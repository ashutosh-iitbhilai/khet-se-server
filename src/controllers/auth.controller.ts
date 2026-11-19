import type { CookieOptions, Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as sessions from '../services/session.service';
import { AUTH_COOKIE, REFRESH_COOKIE } from '../middleware/auth';
import { env, googleEnabled } from '../config/env';
import * as passwordReset from '../services/password-reset.service';
import * as google from '../services/google-auth.service';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { durationToMs } from '../utils/jwt';

const base: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
};
const accessCookie: CookieOptions = { ...base, path: '/' };
// The refresh token is only ever sent to the auth endpoints, never to the rest of the API.
const refreshCookie: CookieOptions = { ...base, path: '/api/auth' };

const meta = (req: Request): sessions.SessionMeta => ({ userAgent: req.get('user-agent'), ip: req.ip });

function setAuthCookies(res: Response, result: sessions.IssuedTokens) {
  res.cookie(AUTH_COOKIE, result.accessToken, { ...accessCookie, maxAge: durationToMs(env.ACCESS_TOKEN_TTL) });
  res.cookie(REFRESH_COOKIE, result.refreshToken, { ...refreshCookie, expires: result.refreshExpiresAt });
}

function sendAuth(res: Response, status: number, result: sessions.IssuedTokens) {
  setAuthCookies(res, result);
  // The short-lived access token is also returned for non-browser clients (Bearer auth).
  // The refresh token stays in its httpOnly cookie, out of reach of page scripts.
  res.status(status).json({ success: true, data: { user: result.user, token: result.accessToken } });
}

function clearAuth(res: Response) {
  res.clearCookie(AUTH_COOKIE, accessCookie);
  res.clearCookie(REFRESH_COOKIE, refreshCookie);
}

export async function register(req: Request, res: Response) {
  sendAuth(res, 201, await authService.register(req.body, meta(req)));
}

export async function login(req: Request, res: Response) {
  sendAuth(res, 200, await authService.login(req.body, meta(req)));
}

/** Exchanges the refresh cookie for a new access token and a new (rotated) refresh token. */
export async function refresh(req: Request, res: Response) {
  try {
    sendAuth(res, 200, await sessions.rotate(req.cookies?.[REFRESH_COOKIE], meta(req)));
  } catch (err) {
    clearAuth(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await sessions.endSession(req.cookies?.[REFRESH_COOKIE]);
  clearAuth(res);
  res.status(200).json({ success: true, data: null });
}

/** Signs this user out on every device. */
export async function logoutAll(req: Request, res: Response) {
  const ended = await sessions.endAllSessions(req.auth!.userId);
  clearAuth(res);
  res.status(200).json({ success: true, data: { sessionsEnded: ended } });
}

export async function me(req: Request, res: Response) {
  const user = await authService.getById(req.auth!.userId);
  res.json({ success: true, data: { user } });
}

/** Which sign-in options the web app should show. */
export function providers(_req: Request, res: Response) {
  res.json({ success: true, data: { google: googleEnabled(), passwordReset: true } });
}

export async function forgotPassword(req: Request, res: Response) {
  await passwordReset.requestReset(req.body, { ip: req.ip });
  // Same answer whether or not the account exists.
  res.json({
    success: true,
    data: { message: 'If this matches an account with an email address, we have sent a link to reset the password to that email.' },
  });
}

export async function resetPassword(req: Request, res: Response) {
  await passwordReset.resetPassword(req.body.token, req.body.password);
  clearAuth(res);
  res.json({ success: true, data: { message: 'Your password has been changed. Please log in with the new password.' } });
}

// The OAuth cookie must survive the redirect back from Google (a cross-site navigation), so it
// is never SameSite=Strict, and it is only sent to the Google endpoints.
const oauthCookie: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
  path: '/api/auth/google',
};

const loginError = (code: string) => `${env.WEB_URL}/login?error=${encodeURIComponent(code.toLowerCase())}`;

/** Starts "Continue with Google": remember the attempt in a signed cookie, then go to Google. */
export function googleStart(req: Request, res: Response) {
  if (!googleEnabled()) return res.redirect(302, loginError('google_disabled'));
  const { role, next } = req.query as { role: google.GoogleRole; next?: string };
  const { url, cookie } = google.startGoogleSignIn(role, next);
  res.cookie(google.OAUTH_COOKIE, cookie, { ...oauthCookie, maxAge: google.OAUTH_TTL_MS });
  res.redirect(302, url);
}

/** Google sends the browser back here. Always ends in a redirect to the web app. */
export async function googleCallback(req: Request, res: Response) {
  res.clearCookie(google.OAUTH_COOKIE, oauthCookie);
  try {
    const { tokens, redirectTo } = await google.finishGoogleSignIn(req.query, req.cookies?.[google.OAUTH_COOKIE], meta(req));
    setAuthCookies(res, tokens);
    res.redirect(302, `${env.WEB_URL}${redirectTo}`);
  } catch (err) {
    if (!(err instanceof ApiError)) logger.error('Google sign-in error', err);
    res.redirect(302, loginError(err instanceof ApiError ? err.code : 'GOOGLE_FAILED'));
  }
}
