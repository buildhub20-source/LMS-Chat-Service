import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOriginAllowed } from '../src/config/environment.js';

const production = { allowedOrigins: [], baseDomain: 'gradusmind.com', allowLocalhost: false };

describe('chat CORS policy', () => {
  it('allows any institute subdomain over https in production', () => {
    assert.equal(isOriginAllowed('https://srp.gradusmind.com', production), true);
    assert.equal(isOriginAllowed('https://demo-college.gradusmind.com', production), true);
  });

  it('rejects localhost in production', () => {
    assert.equal(isOriginAllowed('http://localhost:5173', production), false);
    assert.equal(isOriginAllowed('http://demo.localhost:3000', production), false);
  });

  it('rejects look-alike and nested hosts', () => {
    assert.equal(isOriginAllowed('https://gradusmind.com.evil.com', production), false);
    assert.equal(isOriginAllowed('https://evilgradusmind.com', production), false);
    assert.equal(isOriginAllowed('https://a.b.gradusmind.com', production), false);
    assert.equal(isOriginAllowed('http://srp.gradusmind.com', production), false);
  });

  it('allows localhost during development', () => {
    const dev = { allowedOrigins: [], baseDomain: '', allowLocalhost: true };
    assert.equal(isOriginAllowed('http://demo.localhost:3000', dev), true);
  });

  it('still honours explicitly listed origins', () => {
    const policy = { ...production, allowedOrigins: ['https://platform.gradusmind.com'] };
    assert.equal(isOriginAllowed('https://platform.gradusmind.com', policy), true);
  });
});
