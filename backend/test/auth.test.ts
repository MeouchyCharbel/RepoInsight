import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { type Ctx, PASSWORD, login, setup, teardown } from './helpers.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('authentication', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup()));
  afterAll(async () => teardown(ctx));

  it('sets an httpOnly, SameSite=Strict session cookie on login', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'bob', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ri_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('stores only a hash of the session token', async () => {
    const cookie = await login(ctx.app, 'bob');
    const token = cookie.split('=')[1]!;
    const stored = await ctx.db.collection('sessions').findOne({ token_hash: token });
    expect(stored).toBeNull();
    expect(await ctx.db.collection('sessions').countDocuments({ user_id: 'u_bob' })).toBeGreaterThan(0);
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    const wrong = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'bob', password: 'nope' } });
    const unknown = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'nobody', password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('audits failed and successful logins', async () => {
    expect(await ctx.db.collection('audit_log').countDocuments({ action: 'auth.login', outcome: 'denied' })).toBeGreaterThan(0);
    expect(await ctx.db.collection('audit_log').countDocuments({ action: 'auth.login', outcome: 'success' })).toBeGreaterThan(0);
  });

  it('rejects protected routes without a session or with a forged token', async () => {
    expect((await ctx.app.inject({ url: '/repos' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: '/repos', headers: { cookie: 'ri_session=forged' } })).statusCode).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const cookie = await login(ctx.app, 'carol');
    expect((await ctx.app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect((await ctx.app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects sessions of a disabled user', async () => {
    const cookie = await login(ctx.app, 'carol');
    await ctx.db.collection('users').updateOne({ username: 'carol' }, { $set: { disabled: true } });
    expect((await ctx.app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
    await ctx.db.collection('users').updateOne({ username: 'carol' }, { $set: { disabled: false } });
  });

  it('validates input and never echoes submitted values', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { username: { $ne: null }, password: 'secret-value' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('secret-value');
    expect(res.body).not.toContain('$ne');
  });
});

describe('login rate limit', () => {
  let ctx: Ctx;
  beforeAll(async () => (ctx = await setup({ rateLimit: { global: 1000, login: 3 } })));
  afterAll(async () => teardown(ctx));

  it('returns 429 after too many attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'bob', password: 'wrong' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
