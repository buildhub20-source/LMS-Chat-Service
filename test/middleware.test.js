import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../src/auth/authMiddleware.js';

const sign = (claims, options = {}) =>
  jwt.sign(claims, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER, expiresIn: '5m', ...options });

const run = (req) =>
  new Promise((resolve) => {
    authMiddleware(req, {}, (err) => resolve({ err, req }));
  });

describe('authMiddleware', () => {
  it('accepts a valid access token and sets the tenant', async () => {
    const token = sign({ sub: 'a@srp.edu.in', uid: 'user-1', tid: 'tenant-a', typ: 'access', roles: ['STUDENT'] });
    const { err, req } = await run({ headers: { authorization: `Bearer ${token}` }, query: {} });

    assert.equal(err, undefined);
    assert.equal(req.user.userId, 'user-1');
    assert.equal(req.tenantId, 'tenant-a');
  });

  it('rejects a request with no token', async () => {
    const { err } = await run({ headers: {}, query: {} });
    assert.equal(err?.statusCode ?? err?.status, 401);
  });

  it('rejects a token signed with another secret', async () => {
    const token = jwt.sign({ uid: 'user-1', tid: 'tenant-a', typ: 'access' }, 'some-other-secret', {
      issuer: process.env.JWT_ISSUER,
    });
    const { err } = await run({ headers: { authorization: `Bearer ${token}` }, query: {} });
    assert.equal(err?.statusCode ?? err?.status, 401);
  });

  it('rejects a refresh token', async () => {
    const token = sign({ uid: 'user-1', tid: 'tenant-a', typ: 'refresh' });
    const { err } = await run({ headers: { authorization: `Bearer ${token}` }, query: {} });
    assert.equal(err?.statusCode ?? err?.status, 401);
  });

  it('rejects an expired token', async () => {
    const token = sign({ uid: 'user-1', tid: 'tenant-a', typ: 'access' }, { expiresIn: -120 });
    const { err } = await run({ headers: { authorization: `Bearer ${token}` }, query: {} });
    assert.equal(err?.statusCode ?? err?.status, 401);
  });

  it('rejects a token without a tenant', async () => {
    const token = sign({ uid: 'user-1', typ: 'access' });
    const { err } = await run({ headers: { authorization: `Bearer ${token}` }, query: {} });
    assert.equal(err?.statusCode ?? err?.status, 401);
  });
});
