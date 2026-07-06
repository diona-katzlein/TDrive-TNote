'use strict';

const express = require('express');
const router = express.Router();

const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');

// Halaman login (form kredensial Telegram)
router.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/drive');
  res.render('auth/login', { title: 'Login', error: null });
});

// Langkah 1: kirim OTP
router.post('/login/send-code', async (req, res) => {
  const { api_id, api_hash, phone, label } = req.body;
  try {
    if (!accountService.isPhoneAllowed(phone)) {
      throw new Error('Nomor ini tidak diizinkan login pada instance ini.');
    }
    const { loginId } = await telegramManager.startLogin({
      apiId: api_id,
      apiHash: api_hash,
      phone,
      label,
    });
    req.session.loginId = loginId;
    res.render('auth/verify', { title: 'Login', phone, needPassword: false, error: null });
  } catch (err) {
    res.render('auth/login', { title: 'Login', error: err.message });
  }
});

// Langkah 2: verifikasi OTP (+2FA) → autentikasi sesi
router.post('/login/verify', async (req, res) => {
  const { code, password, phone } = req.body;
  const loginId = req.session.loginId;
  if (!loginId) {
    return res.render('auth/login', { title: 'Login', error: 'Sesi login kedaluwarsa, mulai ulang.' });
  }

  try {
    const result = await telegramManager.completeLogin(loginId, code, password);

    if (result.needPassword) {
      return res.render('auth/verify', {
        title: 'Login',
        phone,
        needPassword: true,
        error: 'Akun ini memakai 2FA. Masukkan password cloud Telegram Anda.',
      });
    }

    if (!accountService.isPhoneAllowed(result.phone)) {
      await telegramManager.cancelLogin(loginId);
      delete req.session.loginId;
      return res.render('auth/login', {
        title: 'Login',
        error: 'Nomor ini tidak diizinkan login pada instance ini.',
      });
    }

    const account = await accountService.ensureAccountFromLogin(result);

    delete req.session.loginId;
    req.session.authenticated = true;
    req.session.userPhone = result.phone;
    req.session.activeAccountId = account.id;
    res.redirect('/drive');
  } catch (err) {
    res.render('auth/verify', { title: 'Login', phone, needPassword: false, error: err.message });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
