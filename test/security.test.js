'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const securityPath = require.resolve('../src/config/security');
const webdavSecurity = require('../src/services/webdavSecurity');
const { inspectMetadata } = require('../src/services/reconciliationService');

function withEnvironment(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[securityPath];
  try {
    return callback(require('../src/config/security'));
  } finally {
    delete require.cache[securityPath];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production startup rejects default and missing secrets', () => {
  withEnvironment({
    NODE_ENV: 'production',
    SESSION_SECRET: 'tdrive-dev-secret',
    TDRIVE_MASTER_KEY: '',
    DB_USER: 'root',
    DB_PASSWORD: '',
    TDRIVE_HTTPS: 'false',
  }, ({ assertProductionConfig }) => {
    assert.throws(assertProductionConfig, (error) => {
      assert.equal(error.code, 'INVALID_PRODUCTION_CONFIG');
      assert.match(error.message, /SESSION_SECRET/);
      assert.match(error.message, /TDRIVE_MASTER_KEY/);
      assert.match(error.message, /DB_USER/);
      assert.match(error.message, /DB_PASSWORD/);
      assert.match(error.message, /TDRIVE_HTTPS/);
      return true;
    });
  });
});

test('production startup accepts hardened configuration and secure cookies', () => {
  withEnvironment({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a'.repeat(48),
    TDRIVE_MASTER_KEY: 'ab'.repeat(32),
    DB_USER: 'tdrive_app',
    DB_PASSWORD: 'a-long-random-database-password',
    TDRIVE_HTTPS: 'true',
  }, ({ assertProductionConfig, sessionCookieOptions }) => {
    assert.doesNotThrow(assertProductionConfig);
    assert.deepEqual(sessionCookieOptions(), {
      maxAge: 2592000000,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });
});

test('security middleware emits browser protections and HSTS over HTTPS', () => {
  withEnvironment({ NODE_ENV: 'production', TDRIVE_HTTPS: 'true' }, ({ securityHeaders }) => {
    const headers = {};
    const res = {
      locals: {},
      setHeader(name, value) { headers[name] = value; },
    };
    let nextCalled = false;
    securityHeaders({}, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
    assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  });
});

test('Basic Auth preserves colons in dedicated WebDAV passwords', () => {
  const header = `Basic ${Buffer.from('+628123:part:with:colons').toString('base64')}`;
  assert.deepEqual(webdavSecurity.parseBasicAuthorization(header), {
    username: '+628123',
    password: 'part:with:colons',
  });
  assert.equal(webdavSecurity.parseBasicAuthorization('Bearer token'), null);
});

test('WebDAV path and Depth validation rejects traversal and infinite scans', () => {
  assert.deepEqual(webdavSecurity.normalizeDavPath('/folder/a%20b.txt').parts, ['folder', 'a b.txt']);
  assert.throws(() => webdavSecurity.normalizeDavPath('/folder/%2e%2e/secret'), (error) => error.status === 400);
  assert.throws(() => webdavSecurity.normalizeDavPath('/folder\\secret'), (error) => error.status === 400);
  assert.equal(webdavSecurity.parseDepth(undefined), 1);
  assert.equal(webdavSecurity.parseDepth('0'), 0);
  assert.throws(() => webdavSecurity.parseDepth('infinity'), (error) => error.status === 403);
});

test('reconciliation identifies chunk ordering, size, and flag inconsistencies', () => {
  const issues = inspectMetadata(
    { size: 30, is_chunked: 0 },
    [
      { part_index: 0, size: 10 },
      { part_index: 2, size: 10 },
    ]
  );
  assert.deepEqual(issues.map((issue) => issue.code), ['CHUNK_ORDER', 'MAPPED_SIZE', 'CHUNK_FLAG']);
  assert.deepEqual(inspectMetadata({ size: 20, is_chunked: 1 }, [
    { part_index: 0, size: 10 },
    { part_index: 1, size: 10 },
  ]), []);
});
