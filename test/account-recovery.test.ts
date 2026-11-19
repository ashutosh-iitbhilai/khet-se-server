import crypto from 'crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { PasswordReset } from '../src/models/PasswordReset';
import { User } from '../src/models/User';
import { testOutbox } from '../src/services/email.service';
import { setUserStatus } from '../src/services/user.service';
import { app, http, registerUser, useDatabase } from './helpers';

useDatabase();

const GENERIC = 'If this matches an account with an email address, we have sent a link to reset the password to that email.';
const tokenFromOutbox = () => {
  const mail = testOutbox.at(-1);
  const link = mail?.text.match(/https?:\/\/\S+reset-password\?token=(\S+)/);
  return link ? decodeURIComponent(link[1]!) : null;
};

describe('forgot password', () => {
  beforeEach(() => {
    testOutbox.length = 0;
  });

  it('answers the same for unknown emails and sends nothing', async () => {
    const res = await http().post('/api/auth/forgot-password').send({ email: 'nobody@test.khetse' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(GENERIC);
    expect(testOutbox).toHaveLength(0);
  });

  it('emails a single-use link; resetting changes the password and ends every session', async () => {
    const { email } = await registerUser('customer');
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email, password: 'pass1234' }).expect(200);

    const res = await http().post('/api/auth/forgot-password').send({ email: email.toUpperCase() });
    expect(res.body.data.message).toBe(GENERIC);
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]!.to).toBe(email);
    expect(testOutbox[0]!.html).toContain('Choose a new password');
    const token = tokenFromOutbox()!;
    expect(token).toBeTruthy();

    // Only a hash is stored.
    const stored = await PasswordReset.findOne({ user: (await User.findOne({ email }))!._id });
    expect(stored!.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(stored!.tokenHash).not.toContain(token);

    const weak = await http().post('/api/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(400);

    const ok = await http().post('/api/auth/reset-password').send({ token, password: 'newpass987' });
    expect(ok.status).toBe(200);

    await http().post('/api/auth/login').send({ email, password: 'pass1234' }).expect(401);
    await http().post('/api/auth/login').send({ email, password: 'newpass987' }).expect(200);
    // The device signed in with the old password can no longer refresh its session.
    await agent.post('/api/auth/refresh').expect(401);

    const again = await http().post('/api/auth/reset-password').send({ token, password: 'another123' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects expired and made-up links', async () => {
    const { email } = await registerUser('customer');
    await http().post('/api/auth/forgot-password').send({ email }).expect(200);
    const token = tokenFromOutbox()!;
    await PasswordReset.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await http().post('/api/auth/reset-password').send({ token, password: 'newpass987' });
    expect(expired.body.error.code).toBe('INVALID_RESET_TOKEN');
    const forged = await http().post('/api/auth/reset-password').send({ token: 'x'.repeat(43), password: 'newpass987' });
    expect(forged.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('sends at most one email a minute, and only the newest link works', async () => {
    const { email } = await registerUser('customer');
    await http().post('/api/auth/forgot-password').send({ email }).expect(200);
    await http().post('/api/auth/forgot-password').send({ email }).expect(200);
    expect(testOutbox).toHaveLength(1);
    const first = tokenFromOutbox()!;

    await PasswordReset.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    await http().post('/api/auth/forgot-password').send({ email }).expect(200);
    expect(testOutbox).toHaveLength(2);
    const second = tokenFromOutbox()!;

    expect((await http().post('/api/auth/reset-password').send({ token: first, password: 'newpass987' })).status).toBe(400);
    expect((await http().post('/api/auth/reset-password').send({ token: second, password: 'newpass987' })).status).toBe(200);
  });

  it('accepts a mobile number and emails the link to the account’s email; mobile-only accounts get nothing', async () => {
    const { email, phone } = await registerUser('customer');
    await http().post('/api/auth/forgot-password').send({ identifier: `+91 ${phone}` }).expect(200);
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]!.to).toBe(email);

    await http().post('/api/auth/register').send({ name: 'No Email', phone: '9345600001', password: 'pass1234' }).expect(201);
    const res = await http().post('/api/auth/forgot-password').send({ identifier: '9345600001' });
    expect(res.body.data.message).toBe(GENERIC);
    expect(testOutbox).toHaveLength(1);
  });

  it('does not send links to suspended accounts', async () => {
    const { email, user } = await registerUser('customer');
    await setUserStatus(user.id, 'suspended');
    const res = await http().post('/api/auth/forgot-password').send({ email });
    expect(res.body.data.message).toBe(GENERIC);
    expect(testOutbox).toHaveLength(0);
  });
});

// ─── Google ──────────────────────────────────────────────────────────────────

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

interface FakeGoogleUser {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
  aud?: string;
}

/** Fakes Google's token endpoint; records what we sent so PKCE can be checked. */
function fakeGoogle(user: FakeGoogleUser) {
  const sent: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://oauth2.googleapis.com/token')) throw new Error(`unexpected fetch ${String(input)}`);
    sent.push(new URLSearchParams(String(init?.body)));
    const claims = {
      iss: 'https://accounts.google.com',
      aud: user.aud ?? CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: user.sub,
      email: user.email,
      email_verified: user.email_verified ?? true,
      name: user.name,
    };
    const idToken = `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'at' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return sent;
}

/** Runs the whole redirect dance with one cookie-keeping browser. */
async function googleSignIn(query: Record<string, string> = {}, tamperState = false) {
  const agent = request.agent(app);
  const start = await agent.get('/api/auth/google').query(query);
  expect(start.status).toBe(302);
  const google = new URL(start.headers.location as string);
  const state = google.searchParams.get('state')!;
  const callback = await agent.get('/api/auth/google/callback').query({ code: 'auth-code', state: tamperState ? `${state}x` : state });
  expect(callback.status).toBe(302);
  return { agent, google, callback, location: callback.headers.location as string };
}

describe('continue with Google', () => {
  beforeEach(() => {
    env.GOOGLE_CLIENT_ID = CLIENT_ID;
    env.GOOGLE_CLIENT_SECRET = 'test-secret';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is advertised to the web app only when configured', async () => {
    expect((await http().get('/api/auth/providers')).body.data.google).toBe(true);
    env.GOOGLE_CLIENT_ID = '';
    expect((await http().get('/api/auth/providers')).body.data.google).toBe(false);
    const start = await http().get('/api/auth/google');
    expect(start.headers.location).toBe(`${env.WEB_URL}/login?error=google_disabled`);
  });

  it('creates a customer account with PKCE and signs them in', async () => {
    const sent = fakeGoogle({ sub: 'g-new-customer', email: 'Asha.Rao@gmail.example', name: 'Asha Rao' });
    const { agent, google, callback, location } = await googleSignIn({ next: '/account/orders' });

    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.searchParams.get('redirect_uri')).toBe(`${env.API_PUBLIC_URL}/api/auth/google/callback`);
    // The verifier we sent to Google hashes to the challenge we started with.
    const verifier = sent[0]!.get('code_verifier')!;
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(google.searchParams.get('code_challenge'));

    expect(location).toBe(`${env.WEB_URL}/account/orders`);
    expect(String(callback.headers['set-cookie'])).toMatch(/khetse_token=.*khetse_refresh=/s);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.user).toMatchObject({ email: 'asha.rao@gmail.example', name: 'Asha Rao', role: 'customer' });
    expect(me.body.data.user).not.toHaveProperty('googleId');

    // Signing in again reuses the same account.
    fakeGoogle({ sub: 'g-new-customer', email: 'asha.rao@gmail.example', name: 'Asha Rao' });
    await googleSignIn();
    expect(await User.countDocuments({ email: 'asha.rao@gmail.example' })).toBe(1);
  });

  it('new farmers land on their dashboard with a farmer profile', async () => {
    fakeGoogle({ sub: 'g-new-farmer', email: 'kisan@gmail.example', name: 'Kisan Kumar' });
    const { agent, location } = await googleSignIn({ role: 'farmer', next: '/products' });
    expect(location).toBe(`${env.WEB_URL}/farmer`);
    await agent.get('/api/farmers/me').expect(200);
  });

  it('links Google to an existing password account with the same email', async () => {
    const { email, user } = await registerUser('farmer');
    fakeGoogle({ sub: 'g-existing', email });
    const { agent, location } = await googleSignIn({ role: 'customer' });
    expect(location).toBe(`${env.WEB_URL}/farmer`); // keeps their farmer role
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.user.id).toBe(user.id);
    expect(await User.countDocuments({ email })).toBe(1);
    await http().post('/api/auth/login').send({ email, password: 'pass1234' }).expect(200);
  });

  it('Google-only accounts cannot log in with a password until they set one', async () => {
    fakeGoogle({ sub: 'g-no-password', email: 'nopass@gmail.example', name: 'No Pass' });
    await googleSignIn();
    const res = await http().post('/api/auth/login').send({ email: 'nopass@gmail.example', password: 'anything1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    testOutbox.length = 0;
    await http().post('/api/auth/forgot-password').send({ email: 'nopass@gmail.example' }).expect(200);
    await http().post('/api/auth/reset-password').send({ token: tokenFromOutbox(), password: 'setnow123' }).expect(200);
    await http().post('/api/auth/login').send({ email: 'nopass@gmail.example', password: 'setnow123' }).expect(200);
  });

  it('refuses a callback whose state does not match this browser', async () => {
    fakeGoogle({ sub: 'g-state', email: 'state@gmail.example' });
    const { callback, location } = await googleSignIn({}, true);
    expect(location).toBe(`${env.WEB_URL}/login?error=google_state_mismatch`);
    expect(String(callback.headers['set-cookie'] ?? '')).not.toMatch(/khetse_token=[^;]/);

    // A callback with no cookie at all (e.g. a link sent to someone else) fails the same way.
    const bare = await http().get('/api/auth/google/callback').query({ code: 'c', state: 's' });
    expect(bare.headers.location).toBe(`${env.WEB_URL}/login?error=google_state_mismatch`);
    expect(await User.countDocuments({ email: 'state@gmail.example' })).toBe(0);
  });

  it('refuses unverified Google emails and tokens meant for another app', async () => {
    fakeGoogle({ sub: 'g-unverified', email: 'unverified@gmail.example', email_verified: false });
    expect((await googleSignIn()).location).toBe(`${env.WEB_URL}/login?error=google_email_unverified`);

    vi.restoreAllMocks();
    fakeGoogle({ sub: 'g-aud', email: 'aud@gmail.example', aud: 'someone-else.apps.googleusercontent.com' });
    expect((await googleSignIn()).location).toBe(`${env.WEB_URL}/login?error=google_failed`);
    expect(await User.countDocuments({ email: { $in: ['unverified@gmail.example', 'aud@gmail.example'] } })).toBe(0);
  });

  it('ignores redirect targets outside the web app', async () => {
    fakeGoogle({ sub: 'g-redirect', email: 'redirect@gmail.example' });
    expect((await googleSignIn({ next: '//evil.example/steal' })).location).toBe(`${env.WEB_URL}/`);
  });

  it('a cancelled consent screen or a suspended account ends on the login page', async () => {
    const cancelled = await request.agent(app).get('/api/auth/google/callback').query({ error: 'access_denied' });
    expect(cancelled.headers.location).toBe(`${env.WEB_URL}/login?error=google_cancelled`);

    const { email, user } = await registerUser('customer');
    await setUserStatus(user.id, 'suspended');
    fakeGoogle({ sub: 'g-suspended', email });
    expect((await googleSignIn()).location).toBe(`${env.WEB_URL}/login?error=account_suspended`);
  });
});
