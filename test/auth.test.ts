import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/models/Session';
import { setUserStatus } from '../src/services/user.service';
import { auth, http, registerUser, useDatabase } from './helpers';

useDatabase();

describe('auth', () => {
  it('registers, logs in and returns the current user', async () => {
    const { email } = await registerUser('customer');
    const login = await http().post('/api/auth/login').send({ email, password: 'pass1234' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']?.[0]).toMatch(/khetse_token=.*HttpOnly/);
    expect(login.body.data.user).not.toHaveProperty('passwordHash');

    const me = await http().get('/api/auth/me').set(auth(login.body.data.token));
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
  });

  it('accepts the httpOnly cookie as well as Bearer tokens', async () => {
    const { email } = await registerUser('customer');
    const agent = (await import('supertest')).default.agent((await import('./helpers')).app);
    await agent.post('/api/auth/login').send({ email, password: 'pass1234' }).expect(200);
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects bad input with field details', async () => {
    const res = await http().post('/api/auth/register').send({ name: 'A', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });

  it('does not allow self-registering as admin', async () => {
    const res = await http().post('/api/auth/register').send({ name: 'Eve', email: 'eve@test.khetse', password: 'pass1234', role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('refuses duplicate emails and wrong passwords without revealing which', async () => {
    const { email } = await registerUser('customer');
    expect((await http().post('/api/auth/register').send({ name: 'Dup', email, password: 'pass1234' })).status).toBe(409);
    const wrong = await http().post('/api/auth/login').send({ email, password: 'wrong123' });
    const unknown = await http().post('/api/auth/login').send({ email: 'ghost@test.khetse', password: 'wrong123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('enforces roles', async () => {
    const customer = await registerUser('customer');
    expect((await http().get('/api/inventory/mine')).status).toBe(401);
    expect((await http().get('/api/inventory/mine').set(auth(customer.token))).status).toBe(403);
    expect((await http().get('/api/auth/me').set(auth('not-a-token'))).status).toBe(401);
  });

  it('returns JSON 404s for unknown routes', async () => {
    const res = await http().get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

/** Pulls `name=value` out of Set-Cookie headers. */
function cookie(res: { headers: Record<string, unknown> }, name: string) {
  const all = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const line = all.find((c) => c.startsWith(`${name}=`));
  return { line, value: line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : undefined };
}
const refreshWith = (token: string) => http().post('/api/auth/refresh').set('Cookie', `khetse_refresh=${encodeURIComponent(token)}`);

async function loggedIn() {
  const { email, user } = await registerUser('customer');
  const res = await http().post('/api/auth/login').send({ email, password: 'pass1234' });
  return { email, userId: user.id as string, access: res.body.data.token as string, refresh: cookie(res, 'khetse_refresh').value!, res };
}

describe('sessions (short access token + rotating refresh token)', () => {
  it('login sets a short-lived access cookie and an httpOnly refresh cookie scoped to /api/auth', async () => {
    const { res, access } = await loggedIn();
    expect(cookie(res, 'khetse_token').line).toMatch(/HttpOnly/);
    expect(cookie(res, 'khetse_refresh').line).toMatch(/Path=\/api\/auth; .*HttpOnly/);
    expect(res.body.data).not.toHaveProperty('refreshToken'); // never exposed to page scripts
    const { exp, iat } = jwt.decode(access) as { exp: number; iat: number };
    expect(exp - iat).toBe(15 * 60);
  });

  it('stores only a hash of the refresh token', async () => {
    const { refresh } = await loggedIn();
    const [id, secret] = refresh.split('.');
    const s = await Session.findById(id).lean();
    expect(s!.tokenHash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(s)).not.toContain(secret);
  });

  it('refresh rotates the token and the new access token works', async () => {
    const { refresh } = await loggedIn();
    const r = await refreshWith(refresh);
    expect(r.status).toBe(200);
    const next = cookie(r, 'khetse_refresh').value!;
    expect(next).not.toBe(refresh);
    expect((await http().get('/api/auth/me').set(auth(r.body.data.token))).status).toBe(200);
  });

  it('an expired access token is refused, and refreshing recovers the session', async () => {
    const { userId, refresh } = await loggedIn();
    const expired = jwt.sign({ sub: userId, role: 'customer', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!);
    const r = await http().get('/api/auth/me').set(auth(expired));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('TOKEN_INVALID');
    expect((await refreshWith(refresh)).status).toBe(200);
  });

  it('two tabs refreshing the same token at once both succeed (grace window)', async () => {
    const { refresh } = await loggedIn();
    const [a, b] = await Promise.all([refreshWith(refresh), refreshWith(refresh)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('replaying an already-used refresh token revokes the whole session family', async () => {
    const { refresh } = await loggedIn();
    const r1 = await refreshWith(refresh);
    const current = cookie(r1, 'khetse_refresh').value!;
    // Move past the grace window, then replay the old (stolen) token.
    await Session.collection.updateOne({ _id: new (await import('mongoose')).Types.ObjectId(refresh.split('.')[0]) }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    expect((await refreshWith(refresh)).status).toBe(401);
    // The legitimate user's newest token is now dead too — they must log in again.
    const after = await refreshWith(current);
    expect(after.status).toBe(401);
    expect(await Session.countDocuments({ revokedReason: 'reuse_detected' })).toBeGreaterThanOrEqual(1);
  });

  it('a forged or malformed refresh token is rejected', async () => {
    const { refresh } = await loggedIn();
    expect((await refreshWith(`${refresh.split('.')[0]}.not-the-secret`)).status).toBe(401);
    expect((await refreshWith('garbage')).status).toBe(401);
    expect((await http().post('/api/auth/refresh')).status).toBe(401);
  });

  it('logout ends the session on the server', async () => {
    const { refresh } = await loggedIn();
    await http().post('/api/auth/logout').set('Cookie', `khetse_refresh=${encodeURIComponent(refresh)}`).expect(200);
    expect((await refreshWith(refresh)).status).toBe(401);
  });

  it('logout-all ends every device', async () => {
    const a = await loggedIn();
    const second = await http().post('/api/auth/login').send({ email: a.email, password: 'pass1234' });
    const b = cookie(second, 'khetse_refresh').value!;
    const r = await http().post('/api/auth/logout-all').set(auth(a.access));
    expect(r.body.data.sessionsEnded).toBe(3); // registration + two logins
    expect((await refreshWith(a.refresh)).status).toBe(401);
    expect((await refreshWith(b)).status).toBe(401);
  });

  it('suspension ends sessions; the user cannot refresh or log in', async () => {
    const { userId, email, refresh } = await loggedIn();
    await setUserStatus(userId, 'suspended');
    const r = await refreshWith(refresh);
    expect(r.status).toBe(401);
    expect((await http().post('/api/auth/login').send({ email, password: 'pass1234' })).status).toBe(403);
  });
});
