'use strict';

const express = require('express');
const router = express.Router();

const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');
const fileService = require('../services/fileService');
const cryptoService = require('../services/cryptoService');
const totpService = require('../services/totpService');

// Halaman login (form nomor telepon)
router.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/drive');
  }
  res.render('auth/login', { title: 'Login', error: null });
});

// Langkah 1: Cek nomor telepon (apakah sudah terdaftar dan punya password)
router.post('/login/check-phone', async (req, res) => {
  const { phone } = req.body;
  try {
    if (!phone || !phone.trim()) throw new Error('Nomor telepon wajib diisi.');
    const normalized = accountService.normPhone(phone);
    
    // Cari apakah akun sudah terdaftar di database TDrive
    const account = await fileService.getAccountByPhone(normalized);
    
    if (account && account.password_hash) {
      // Jika punya password/PIN, minta input password
      return res.render('auth/login-password', {
        title: 'Login Password',
        phone: normalized,
        error: null,
        csrfToken: res.locals.csrfToken,
      });
    } else {
      // Jika belum terdaftar atau belum punya password, kirim OTP
      const { loginId } = await telegramManager.startLogin({ phone: normalized });
      req.session.loginId = loginId;
      return res.render('auth/verify', {
        title: 'Verifikasi OTP',
        phone: normalized,
        needPassword: false,
        error: null,
        csrfToken: res.locals.csrfToken,
      });
    }
  } catch (err) {
    res.render('auth/login', { title: 'Login', error: err.message });
  }
});

// Langkah 1b: Paksa Kirim OTP (bagi user yang ingin masuk menggunakan OTP meskipun punya password)
router.post('/login/send-otp-forced', async (req, res) => {
  const { phone } = req.body;
  try {
    if (!phone) throw new Error('Nomor telepon tidak valid.');
    const normalized = accountService.normPhone(phone);
    const { loginId } = await telegramManager.startLogin({ phone: normalized });
    req.session.loginId = loginId;
    res.render('auth/verify', {
      title: 'Verifikasi OTP',
      phone: normalized,
      needPassword: false,
      error: null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.render('auth/login', { title: 'Login', error: err.message });
  }
});

// Langkah 2a: Verifikasi menggunakan Password / PIN Sistem (Tanpa OTP Telegram)
router.post('/login/verify-password', async (req, res) => {
  const { phone, password } = req.body;
  try {
    if (!phone || !password) throw new Error('Nomor telepon dan password wajib diisi.');
    const normalized = accountService.normPhone(phone);
    const account = await fileService.getAccountByPhone(normalized);
    
    if (!account || !account.password_hash) {
      throw new Error('Akun belum diatur untuk login password.');
    }
    
    const isValid = cryptoService.verifyPassword(password, account.password_hash);
    if (!isValid) {
      return res.render('auth/login-password', {
        title: 'Login Password',
        phone: normalized,
        error: 'Kata sandi / PIN yang Anda masukkan salah.',
        csrfToken: res.locals.csrfToken,
      });
    }
    
    // Login berhasil! Cek MFA terlebih dahulu
    if (account.mfa_secret) {
      req.session.tempLoginPhone = account.phone;
      req.session.tempLoginAccountId = account.id;
      return res.redirect('/login/mfa');
    }
    
    await telegramManager.getClient(account);
    
    req.session.authenticated = true;
    req.session.userPhone = account.phone;
    req.session.activeAccountId = account.id;
    
    res.redirect('/drive');
  } catch (err) {
    res.render('auth/login', { title: 'Login', error: err.message });
  }
});

// Langkah 2b: Verifikasi OTP (+2FA jika ada)
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
        title: 'Verifikasi OTP',
        phone,
        needPassword: true,
        error: 'Akun ini memakai 2FA. Masukkan password cloud Telegram Anda.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const { account, isNew } = await accountService.ensureAccountFromLogin(result);
    delete req.session.loginId;

    // Login berhasil! Cek MFA terlebih dahulu
    if (account.mfa_secret) {
      req.session.tempLoginPhone = result.phone;
      req.session.tempLoginAccountId = account.id;
      req.session.tempLoginIsNew = isNew;
      return res.redirect('/login/mfa');
    }

    req.session.authenticated = true;
    req.session.userPhone = result.phone;
    req.session.activeAccountId = account.id;

    res.redirect(isNew ? `/accounts/${account.id}/label?welcome=1` : '/drive');
  } catch (err) {
    res.render('auth/verify', {
      title: 'Verifikasi OTP',
      phone,
      needPassword: false,
      error: err.message,
      csrfToken: res.locals.csrfToken,
    });
  }
});

// Halaman input kode MFA/2FA TOTP
router.get('/login/mfa', (req, res) => {
  if (!req.session.tempLoginPhone || !req.session.tempLoginAccountId) {
    return res.redirect('/login');
  }
  res.render('auth/mfa', { title: 'Verifikasi 2FA', error: null, csrfToken: res.locals.csrfToken });
});

// Proses verifikasi kode MFA/2FA TOTP
router.post('/login/mfa', async (req, res) => {
  const { token } = req.body;
  if (!req.session.tempLoginPhone || !req.session.tempLoginAccountId) {
    return res.redirect('/login');
  }

  try {
    const account = await fileService.getAccount(req.session.tempLoginAccountId);
    if (!account || !account.mfa_secret) {
      throw new Error('Pengaturan MFA tidak valid.');
    }

    const isValid = totpService.verifyTOTP(token, account.mfa_secret);
    if (!isValid) {
      return res.render('auth/mfa', {
        title: 'Verifikasi 2FA',
        error: 'Kode 2FA salah atau sudah kedaluwarsa. Silakan periksa aplikasi authenticator Anda.',
        csrfToken: res.locals.csrfToken,
      });
    }

    // Sambungkan Telegram client
    await telegramManager.getClient(account);

    req.session.authenticated = true;
    req.session.userPhone = req.session.tempLoginPhone;
    req.session.activeAccountId = req.session.tempLoginAccountId;
    const isNew = req.session.tempLoginIsNew;

    // Bersihkan sesi temporer
    delete req.session.tempLoginPhone;
    delete req.session.tempLoginAccountId;
    delete req.session.tempLoginIsNew;

    res.redirect(isNew ? `/accounts/${account.id}/label?welcome=1` : '/drive');
  } catch (err) {
    res.render('auth/mfa', {
      title: 'Verifikasi 2FA',
      error: err.message,
      csrfToken: res.locals.csrfToken,
    });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
