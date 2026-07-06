'use strict';

const express = require('express');
const router = express.Router();

const fileService = require('../services/fileService');
const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');

// Daftar akun (drive)
router.get('/', (req, res) => {
  res.render('accounts/list', { title: 'Accounts', error: null });
});

// Form tambah akun
router.get('/add', (req, res) => {
  res.render('accounts/add', { title: 'Add Account', error: null });
});

// Langkah 1: kirim OTP
router.post('/send-code', async (req, res) => {
  const { api_id, api_hash, phone, label } = req.body;
  try {
    if (!accountService.isPhoneAllowed(phone)) {
      throw new Error('Nomor ini tidak diizinkan pada instance ini.');
    }
    const { loginId } = await telegramManager.startLogin({
      apiId: api_id,
      apiHash: api_hash,
      phone,
      label,
    });
    req.session.loginId = loginId;
    res.render('accounts/verify', { title: 'Verify OTP', phone, needPassword: false, error: null });
  } catch (err) {
    res.render('accounts/add', { title: 'Add Account', error: err.message });
  }
});

// Langkah 2: verifikasi OTP (+2FA) → simpan/perbarui akun (+ channel storage bila baru)
router.post('/verify', async (req, res) => {
  const { code, password, phone } = req.body;
  const loginId = req.session.loginId;
  if (!loginId) {
    return res.render('accounts/add', {
      title: 'Add Account',
      error: 'Sesi login kedaluwarsa, mulai ulang.',
    });
  }

  try {
    const result = await telegramManager.completeLogin(loginId, code, password);

    if (result.needPassword) {
      return res.render('accounts/verify', {
        title: 'Verify OTP',
        phone,
        needPassword: true,
        error: 'Akun ini memakai 2FA. Masukkan password cloud Telegram Anda.',
      });
    }

    if (!accountService.isPhoneAllowed(result.phone)) {
      await telegramManager.cancelLogin(loginId);
      delete req.session.loginId;
      return res.render('accounts/add', {
        title: 'Add Account',
        error: 'Nomor ini tidak diizinkan pada instance ini.',
      });
    }

    const account = await accountService.ensureAccountFromLogin(result);

    delete req.session.loginId;
    req.session.activeAccountId = account.id;
    res.redirect('/drive');
  } catch (err) {
    res.render('accounts/verify', { title: 'Verify OTP', phone, needPassword: false, error: err.message });
  }
});

// Set akun aktif
router.post('/:id/activate', (req, res) => {
  const id = Number(req.params.id);
  const account = fileService.getAccount(id);
  if (account) req.session.activeAccountId = id;
  res.redirect('/drive');
});

// Hapus akun (logout + hapus sesi + metadata cascade)
router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  await telegramManager.dropClient(id);
  fileService.deleteAccount(id);
  if (req.session.activeAccountId === id) delete req.session.activeAccountId;
  res.redirect('/accounts');
});

module.exports = router;
