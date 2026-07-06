'use strict';

const { isPhoneAllowed, normPhone } = require('../services/accountService');
const fileService = require('../services/fileService');

/**
 * Middleware untuk membatasi akses rute administratif /accounts.
 * Hanya pengguna yang nomor teleponnya ada di TDRIVE_ALLOWED_PHONES yang dapat mengelola semua akun.
 * Pengguna biasa hanya diizinkan untuk mengaktifkan atau melabeli akun milik mereka sendiri.
 */
async function requireAdmin(req, res, next) {
  // Jika list diperbolehkan kosong (bebas) atau user adalah admin
  if (res.locals.isAdmin) {
    return next();
  }

  // Pengguna biasa: hanya diperbolehkan mengakses rute aktifkan/label akun miliknya sendiri
  // Rute berformat: /:id/label atau /:id/activate
  const match = req.path.match(/^\/(\d+)\/(label|activate)/);
  if (match) {
    const accountId = Number(match[1]);
    try {
      const account = await fileService.getAccount(accountId);
      if (account && normPhone(account.phone) === normPhone(req.session.userPhone)) {
        return next();
      }
    } catch (err) {
      console.error('Gagal memverifikasi kepemilikan akun:', err);
    }
  }

  // Jika tidak memiliki akses, arahkan ke profil
  return res.redirect('/profile');
}

module.exports = { requireAdmin };
