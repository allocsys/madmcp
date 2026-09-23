// test/auth.test.js -- unit coverage for src/auth.js's requireSharedSecret
// middleware (the shared-secret bearer auth between madmcp and this
// worker). Uses minimal fake Express req/res objects, no real HTTP server.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireSharedSecret } from '../src/auth.js';

function makeReq({ path = '/scan', authorization } = {}) {
  return {
    path,
    get(header) {
      if (header.toLowerCase() === 'authorization') return authorization;
      return undefined;
    },
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

describe('requireSharedSecret', () => {
  const ORIGINAL_SECRET = process.env.REPO_MAP_SHARED_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.REPO_MAP_SHARED_SECRET;
    else process.env.REPO_MAP_SHARED_SECRET = ORIGINAL_SECRET;
  });

  test('always allows /health through, even with no secret configured', () => {
    delete process.env.REPO_MAP_SHARED_SECRET;
    const req = makeReq({ path: '/health' });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });

  test('returns 500 when REPO_MAP_SHARED_SECRET is not set on the worker', () => {
    delete process.env.REPO_MAP_SHARED_SECRET;
    const req = makeReq({ path: '/scan', authorization: 'Bearer whatever' });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'server misconfigured');
  });

  test('returns 401 when no Authorization header is sent', () => {
    process.env.REPO_MAP_SHARED_SECRET = 'correct-secret';
    const req = makeReq({ path: '/scan', authorization: undefined });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
  });

  test('returns 401 when the header is missing the Bearer prefix', () => {
    process.env.REPO_MAP_SHARED_SECRET = 'correct-secret';
    const req = makeReq({ path: '/scan', authorization: 'correct-secret' });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('returns 401 when the bearer token does not match', () => {
    process.env.REPO_MAP_SHARED_SECRET = 'correct-secret';
    const req = makeReq({ path: '/scan', authorization: 'Bearer wrong-secret' });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('calls next() when the bearer token matches exactly', () => {
    process.env.REPO_MAP_SHARED_SECRET = 'correct-secret';
    const req = makeReq({ path: '/scan', authorization: 'Bearer correct-secret' });
    const res = makeRes();
    let nextCalled = false;

    requireSharedSecret(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });
});
