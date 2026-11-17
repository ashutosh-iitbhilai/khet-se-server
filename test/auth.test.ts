import { describe, expect, it } from 'vitest';
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
