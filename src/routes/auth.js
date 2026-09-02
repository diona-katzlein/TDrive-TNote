'use strict';

const express = require('express');
const router = express.Router();

const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');
const fileService = require('../services/fileService');
const cryptoService = require('../services/cryptoService');
const totpService = require('../services/totpService');
const sessionService = require('../services/sessionService');

// Halaman login (form nomor telepon)
router.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/drive');
  }
  res.render('auth/login', { title: 'Login', error: null });
});

function isMfaEnabled(account) {
  return Boolean(account && typeof account.mfa_secret === 'string' && account.mfa_secret.trim());
}

function clearPendingMfa(req) {
  delete req.session.tempLoginPhone;
  delete req.session.tempLoginAccountId;
  delete req.session.tempLoginIsNew;
}

// Langkah 1: Cek nomor telepon (apakah sudah terdaftar dan punya password)
router.post('/login/check-phone', async (req, res) => {
  const { phone } = req.body;
  try {
    if (!phone || !phone.trim()) throw new Error('Nomor telepon wajib diisi.');
    clearPendingMfa(req);
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
    
    // MFA TDrive bersifat opsional dan hanya diminta jika pemilik sudah mengaktifkannya.
    if (isMfaEnabled(account)) {
      req.session.tempLoginPhone = account.phone;
      req.session.tempLoginAccountId = account.id;
      return res.redirect('/login/mfa');
    }
    
    await telegramManager.getClient(account);
    
    await sessionService.rotateAndAuthenticate(req, {
      phone: account.phone,
      accountId: account.id,
    });
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
        error: 'Telegram meminta Password Cloud untuk akun ini.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const { account, isNew } = await accountService.ensureAccountFromLogin(result);
    delete req.session.loginId;

    // MFA TDrive bersifat opsional dan hanya diminta jika pemilik sudah mengaktifkannya.
    if (isMfaEnabled(account)) {
      req.session.tempLoginPhone = result.phone;
      req.session.tempLoginAccountId = account.id;
      req.session.tempLoginIsNew = isNew;
      return res.redirect('/login/mfa');
    }

    await sessionService.rotateAndAuthenticate(req, {
      phone: result.phone,
      accountId: account.id,
    });
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
    if (!isMfaEnabled(account)) {
      clearPendingMfa(req);
      return res.redirect('/login');
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

    const loginPhone = req.session.tempLoginPhone;
    const loginAccountId = req.session.tempLoginAccountId;
    const isNew = req.session.tempLoginIsNew;
    clearPendingMfa(req);
    await sessionService.rotateAndAuthenticate(req, {
      phone: loginPhone,
      accountId: loginAccountId,
    });
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
router.post('/logout', async (req, res) => {
  try {
    await sessionService.revokeCurrent(req);
  } catch (err) {
    console.error('[Auth] Gagal menandai session logout sebagai revoked:', err);
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
