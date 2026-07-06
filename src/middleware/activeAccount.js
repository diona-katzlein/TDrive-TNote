'use strict';

const fileService = require('../services/fileService');
const { isPhoneAllowed, normPhone } = require('../services/accountService');

/**
 * Muat daftar akun + akun aktif ke res.locals agar tersedia di semua view.
 * Akun aktif disimpan di req.session.activeAccountId.
 * 
 * Untuk pengguna biasa, daftar akun dibatasi hanya pada akun milik mereka sendiri.
 */
async function activeAccount(req, res, next) {
  try {
    if (!req.session || !req.session.authenticated) {
      return next();
    }
    const isAllowedUser = isPhoneAllowed(req.session.userPhone);
    let accounts = await fileService.listAccounts();

    // Jika bukan admin, batasi daftar akun hanya untuk nomor HP yang sedang login
    if (!isAllowedUser && req.session.userPhone) {
      accounts = accounts.filter(
        (a) => normPhone(a.phone) === normPhone(req.session.userPhone)
      );
    }

    res.locals.accounts = accounts;

    let active = null;
    const activeId = req.session.activeAccountId;
    if (activeId) {
      active = accounts.find((a) => a.id === activeId) || null;
    }
    
    // Fallback: pilih akun pertama bila belum ada yang aktif.
    if (!active && accounts.length) {
      active = accounts[0];
      req.session.activeAccountId = active.id;
    }

    req.activeAccount = active;
    res.locals.activeAccount = active;
    res.locals.userPhone = req.session.userPhone || null;
    res.locals.isAdmin = isAllowedUser;
    next();
  } catch (err) {
    next(err);
  }
}

/** Guard: butuh akun aktif untuk mengakses drive. */
function requireActiveAccount(req, res, next) {
  if (!req.activeAccount) {
    return res.redirect('/accounts');
  }
  next();
}

module.exports = { activeAccount, requireActiveAccount };
