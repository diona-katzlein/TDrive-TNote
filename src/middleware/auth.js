'use strict';

/**
 * Gerbang autentikasi aplikasi. Pengguna harus login via Telegram (OTP)
 * sebelum mengakses halaman terproteksi (/drive, /accounts, /folders).
 */
function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.redirect('/login');
}

module.exports = { requireLogin };
