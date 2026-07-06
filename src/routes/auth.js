'use strict';

const express = require('express');
const router = express.Router();

const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');
const fileService = require('../services/fileService');
const cryptoService = require('../services/cryptoService');

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
    
    // Login berhasil! Sesi didekripsi dan client diregistrasikan ke pool
    // Panggil getClient untuk mengaktifkan koneksi telegramManager secara on-demand
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
    req.session.authenticated = true;
    req.session.userPhone = result.phone;
    req.session.activeAccountId = account.id;

    // Arahkan ke penamaan label jika akun baru. Jika tidak, langsung ke drive.
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

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
