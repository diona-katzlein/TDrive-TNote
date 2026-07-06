'use strict';

const fileService = require('../services/fileService');

/**
 * Muat daftar akun + akun aktif ke res.locals agar tersedia di semua view.
 * Akun aktif disimpan di req.session.activeAccountId.
 */
function activeAccount(req, res, next) {
  const accounts = fileService.listAccounts();
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
  next();
}

/** Guard: butuh akun aktif untuk mengakses drive. */
function requireActiveAccount(req, res, next) {
  if (!req.activeAccount) {
    return res.redirect('/accounts');
  }
  next();
}

module.exports = { activeAccount, requireActiveAccount };
