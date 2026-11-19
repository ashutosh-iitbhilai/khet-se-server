import crypto from 'crypto';
import { env, googleEnabled } from '../config/env';
import { User, type UserDocument } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { ensureFarmerForUser } from './farmer.service';
import { ensurePartnerForUser } from './delivery.service';
import { startSession, type IssuedTokens, type SessionMeta } from './session.service';

/**
 * "Continue with Google": OAuth 2.0 authorization-code flow with PKCE, run entirely on the
 * server. The browser never sees Google tokens; it ends up with our normal session cookies.
 *
 *   GET /api/auth/google           → sets a signed, short-lived state cookie, redirects to Google
 *   GET /api/auth/google/callback  → checks state, exchanges the code, signs the user in
 *
 * The ID token comes straight from Google's token endpoint over TLS, authenticated with our
 * client secret, so per OpenID Connect Core §3.1.3.7 its issuer, audience and expiry are
 * checked without re-verifying the JWT signature.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const OAUTH_COOKIE = 'khetse_oauth';
export const OAUTH_TTL_MS = 10 * 60_000;

export type GoogleRole = 'customer' | 'farmer' | 'delivery';

interface OAuthState {
  state: string;
  verifier: string;
  role: GoogleRole;
  next?: string;
  exp: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const sign = (payload: string) => crypto.createHmac('sha256', env.JWT_SECRET).update(`oauth:${payload}`).digest('base64url');
export const redirectUri = () => `${env.API_PUBLIC_URL}/api/auth/google/callback`;

/** Only same-site paths like "/account/orders" — never "//evil.com" or absolute URLs. */
export function safeNext(next: unknown): string | undefined {
  if (typeof next !== 'string' || next.length > 200) return undefined;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return undefined;
  return next;
}

export function homeForRole(role: string) {
  if (role === 'farmer') return '/farmer';
  if (role === 'delivery') return '/delivery';
  if (role === 'admin') return '/admin';
  return '/';
}

/** Builds the Google consent URL and the signed cookie that remembers this attempt. */
export function startGoogleSignIn(role: GoogleRole, next?: string) {
  if (!googleEnabled()) throw new ApiError(404, 'GOOGLE_DISABLED', 'Google sign-in is not available');

  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const payload: OAuthState = { state, verifier, role, next: safeNext(next), exp: Date.now() + OAUTH_TTL_MS };
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();

  return { url: url.toString(), cookie: `${encoded}.${sign(encoded)}` };
}

function readState(cookie: unknown): OAuthState | null {
  if (typeof cookie !== 'string') return null;
  const [encoded, mac] = cookie.split('.');
  if (!encoded || !mac) return null;
  const expected = sign(encoded);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as OAuthState;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

async function exchangeCode(code: string, verifier: string): Promise<GoogleProfile> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { id_token?: string; error?: string } | null;
  if (!res.ok || !body?.id_token) throw new Error(`Google token exchange failed (${res.status} ${body?.error ?? ''})`);

  const [, part] = body.id_token.split('.');
  const claims = JSON.parse(Buffer.from(part ?? '', 'base64url').toString()) as Record<string, unknown>;
  if (!ISSUERS.includes(String(claims.iss))) throw new Error('Google ID token: wrong issuer');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('Google ID token: wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('Google ID token: expired');
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') throw new Error('Google ID token: missing subject or email');
  if (claims.email_verified !== true) throw new ApiError(403, 'GOOGLE_EMAIL_UNVERIFIED', 'Your Google email address is not verified');

  return { sub: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : undefined };
}

/** Finds the account for this Google identity, links it to an existing email account, or creates one. */
async function findOrCreateUser(profile: GoogleProfile, role: GoogleRole): Promise<{ user: UserDocument; created: boolean }> {
  const byGoogle = await User.findOne({ googleId: profile.sub });
  if (byGoogle) return { user: byGoogle, created: false };

  // Google has verified this address, so it is safe to link it to the matching account.
  const byEmail = await User.findOneAndUpdate({ email: profile.email, googleId: null }, { $set: { googleId: profile.sub } }, { new: true });
  if (byEmail) return { user: byEmail, created: false };

  const raw = profile.name?.trim() || profile.email.split('@')[0]!.replace(/[._-]+/g, ' ').trim();
  const name = raw.length >= 2 ? raw.slice(0, 80) : 'Khet Se user';
  try {
    const user = await User.create({ name, email: profile.email, googleId: profile.sub, role });
    if (role === 'farmer') await ensureFarmerForUser(user._id);
    if (role === 'delivery') await ensurePartnerForUser(user._id);
    return { user, created: true };
  } catch (err) {
    // Two callbacks for the same new account raced: use the one that won.
    if ((err as { code?: number }).code === 11000) {
      const user = await User.findOne({ googleId: profile.sub });
      if (user) return { user, created: false };
      // The email belongs to an account already linked to a different Google account.
      throw new ApiError(409, 'GOOGLE_EMAIL_TAKEN', 'This email is already linked to another Google account');
    }
    throw err;
  }
}

export interface GoogleResult {
  tokens: IssuedTokens;
  redirectTo: string;
}

/** Completes the sign-in. Throws ApiError with a code the controller turns into a friendly redirect. */
export async function finishGoogleSignIn(
  query: { code?: unknown; state?: unknown; error?: unknown },
  cookie: unknown,
  meta: SessionMeta,
): Promise<GoogleResult> {
  if (!googleEnabled()) throw new ApiError(404, 'GOOGLE_DISABLED', 'Google sign-in is not available');
  if (query.error) throw new ApiError(400, 'GOOGLE_CANCELLED', 'Google sign-in was cancelled');

  const saved = readState(cookie);
  const state = typeof query.state === 'string' ? query.state : '';
  if (!saved || state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
    throw new ApiError(400, 'GOOGLE_STATE_MISMATCH', 'This sign-in attempt expired. Please try again.');
  }
  if (typeof query.code !== 'string' || !query.code) throw new ApiError(400, 'GOOGLE_FAILED', 'Google did not return a sign-in code');

  let profile: GoogleProfile;
  try {
    profile = await exchangeCode(query.code, saved.verifier);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn(`Google sign-in failed: ${(err as Error).message}`);
    throw new ApiError(502, 'GOOGLE_FAILED', 'Could not complete Google sign-in');
  }

  const { user, created } = await findOrCreateUser(profile, saved.role);
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');

  user.lastLoginAt = new Date();
  await user.save();
  logger.info(`Google sign-in: user ${user._id}${created ? ' (new account)' : ''}`);

  // New farmers and partners go straight to their dashboard to finish setting up.
  const redirectTo = created && user.role !== 'customer' ? homeForRole(user.role) : (saved.next ?? homeForRole(user.role));
  return { tokens: await startSession(user, meta), redirectTo };
}
