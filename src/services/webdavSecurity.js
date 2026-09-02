'use strict';

function parseBasicAuthorization(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    const username = decoded.slice(0, separator).trim();
    const password = decoded.slice(separator + 1);
    if (!username || !password || username.length > 100 || password.length > 512) return null;
    return { username, password };
  } catch (_) {
    return null;
  }
}

function normalizeDavPath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPath || '/'));
  } catch (_) {
    const error = new Error('Malformed path encoding');
    error.status = 400;
    throw error;
  }
  if (decoded.includes('\0') || /[\x00-\x1f\x7f]/.test(decoded) || decoded.includes('\\')) {
    const error = new Error('Invalid path');
    error.status = 400;
    throw error;
  }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length > 50 || parts.some((part) => part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    const error = new Error('Unsafe path');
    error.status = 400;
    throw error;
  }
  return { decoded: '/' + parts.join('/'), parts };
}

function parseDepth(value) {
  if (value == null || value === '') return 1;
  if (value === '0') return 0;
  if (value === '1') return 1;
  const error = new Error('Only Depth 0 or 1 is supported');
  error.status = 403;
  throw error;
}

module.exports = { normalizeDavPath, parseBasicAuthorization, parseDepth };
