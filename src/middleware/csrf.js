'use strict';

const crypto = require('crypto');

/**
 * CSRF proteksi sederhana (synchronizer token) tanpa dependensi tambahan.
 *
 * - Token per sesi disimpan di req.session._csrf dan diekspos ke view via
 *   res.locals.csrfToken (dipasang sebagai hidden input pada form POST).
 * - Untuk request mutasi (POST/PUT/PATCH/DELETE) token diverifikasi dari
 *   body `_csrf`, query `_csrf`, atau header `x-csrf-token`.
 *
 * Catatan: query `_csrf` dipakai untuk form multipart (upload), karena body
 * multipart belum ter-parse saat middleware global berjalan.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function csrf(req, res, next) {
  if (!req.session) return next();

  if (!req.session._csrf) {
    req.session._csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session._csrf;

  if (MUTATING.has(req.method)) {
    const sent =
      (req.body && req.body._csrf) ||
      (req.query && req.query._csrf) ||
      req.headers['x-csrf-token'];
    if (!timingSafeEqual(sent, req.session._csrf)) {
      return res.status(403).send('Token CSRF tidak valid. Muat ulang halaman lalu coba lagi.');
    }
  }

  next();
}

module.exports = { csrf };
