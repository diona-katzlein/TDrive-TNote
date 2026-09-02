'use strict';

const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function assertProductionConfig() {
  const errors = [];
  const sessionSecret = process.env.SESSION_SECRET || '';
  const masterKey = process.env.TDRIVE_MASTER_KEY || '';
  const dbUser = process.env.DB_USER || 'root';
  const dbPassword = process.env.DB_PASSWORD || '';

  if (isProduction) {
    if (sessionSecret.length < 32 || sessionSecret === 'tdrive-dev-secret' || /ganti_dengan/i.test(sessionSecret)) {
      errors.push('SESSION_SECRET wajib berupa nilai acak minimal 32 karakter.');
    }
    if (!/^[a-f0-9]{64}$/i.test(masterKey)) {
      errors.push('TDRIVE_MASTER_KEY wajib berupa 64 karakter hex (32 byte).');
    }
    if (dbUser.toLowerCase() === 'root') {
      errors.push('DB_USER tidak boleh menggunakan root pada production.');
    }
    if (!dbPassword || dbPassword.length < 12) {
      errors.push('DB_PASSWORD production wajib diisi dan minimal 12 karakter.');
    }
    if (!parseBoolean(process.env.TDRIVE_HTTPS, false)) {
      errors.push('TDRIVE_HTTPS=true wajib pada production agar secure cookie dan HSTS aktif.');
    }
  }

  if (masterKey && !/^[a-f0-9]{64}$/i.test(masterKey)) {
    errors.push('TDRIVE_MASTER_KEY tidak valid; gunakan tepat 64 karakter hex.');
  }

  if (errors.length) {
    const error = new Error(`Konfigurasi keamanan tidak valid:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_PRODUCTION_CONFIG';
    throw error;
  }
}

function sessionCookieOptions() {
  return {
    maxAge: Number(process.env.SESSION_MAX_AGE_MS) || 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    secure: isProduction || parseBoolean(process.env.TDRIVE_HTTPS, false),
    sameSite: process.env.SESSION_SAME_SITE || 'lax',
    path: '/',
  };
}

function trustProxySetting() {
  const value = process.env.TRUST_PROXY;
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

function requestId(req) {
  const supplied = req.headers['x-request-id'];
  if (typeof supplied === 'string' && /^[a-zA-Z0-9._-]{8,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');

  if (isProduction || parseBoolean(process.env.TDRIVE_HTTPS, false)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Transitional CSP: local EJS templates still contain inline scripts/styles and handlers.
  // Other sources remain closed while those templates are migrated to nonce-based assets.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://api.qrserver.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    'upgrade-insecure-requests',
  ].join('; '));
  next();
}

module.exports = {
  assertProductionConfig,
  isProduction,
  parseBoolean,
  requestId,
  securityHeaders,
  sessionCookieOptions,
  trustProxySetting,
};
