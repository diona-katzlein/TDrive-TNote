'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');
const fileService = require('../services/fileService');
const telegramManager = require('../services/telegramManager');
const accountService = require('../services/accountService');
const { requireAdmin } = require('../middleware/restrictAccess');

// Gunakan middleware pembatasan akses
router.use(requireAdmin);

// Daftar akun (drive) - Hanya Admin
router.get('/', async (req, res) => {
  try {
    const rawAccounts = await fileService.listAccounts();
    const accounts = [];
    for (const a of rawAccounts) {
      const stats = await fileService.accountStats(a.id);
      const [channelRows] = await db.query('SELECT COUNT(*) AS count FROM user_channels WHERE account_id = ?', [a.id]);
      const channelCount = channelRows[0].count;

      accounts.push({
        ...a,
        storageUsed: stats.total,
        fileCount: stats.count,
        channelCount,
      });
    }

    res.render('accounts/list', {
      title: 'Accounts',
      accounts,
      error: null,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Form tambah akun - Hanya Admin
router.get('/add', (req, res) => {
  res.render('accounts/add', { title: 'Add Account', error: null, csrfToken: res.locals.csrfToken });
});

// Langkah 1: kirim OTP (cukup nomor telepon; kredensial app dari env bersama) - Hanya Admin
router.post('/send-code', async (req, res) => {
  const { phone } = req.body;
  try {
    if (!phone || !phone.trim()) throw new Error('Nomor telepon wajib diisi.');
    const normalized = accountService.normPhone(phone);
    
    // Admin hanya bisa mendaftarkan nomor yang diizinkan (atau jika allowed list kosong, siapa saja)
    if (!accountService.isPhoneAllowed(normalized)) {
      throw new Error('Nomor ini tidak diizinkan pada instance ini.');
    }
    
    const { loginId } = await telegramManager.startLogin({ phone: normalized });
    req.session.loginId = loginId;
    res.render('accounts/verify', { title: 'Verify OTP', phone: normalized, needPassword: false, error: null, csrfToken: res.locals.csrfToken });
  } catch (err) {
    res.render('accounts/add', { title: 'Add Account', error: err.message, csrfToken: res.locals.csrfToken });
  }
});

// Langkah 2: verifikasi OTP (+2FA) → simpan/perbarui akun (+ channel storage bila baru) - Hanya Admin
router.post('/verify', async (req, res) => {
  const { code, password, phone } = req.body;
  const loginId = req.session.loginId;
  if (!loginId) {
    return res.render('accounts/add', {
      title: 'Add Account',
      error: 'Sesi login kedaluwarsa, mulai ulang.',
      csrfToken: res.locals.csrfToken,
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
        csrfToken: res.locals.csrfToken,
      });
    }

    if (!accountService.isPhoneAllowed(result.phone)) {
      await telegramManager.cancelLogin(loginId);
      delete req.session.loginId;
      return res.render('accounts/add', {
        title: 'Add Account',
        error: 'Nomor ini tidak diizinkan pada instance ini.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const { account, isNew } = await accountService.ensureAccountFromLogin(result);

    delete req.session.loginId;
    req.session.activeAccountId = account.id;
    // Akun baru → minta label dulu. Akun yang sudah ada → langsung ke drive.
    res.redirect(isNew ? `/accounts/${account.id}/label` : '/drive');
  } catch (err) {
    res.render('accounts/verify', {
      title: 'Verify OTP',
      phone,
      needPassword: false,
      error: err.message,
      csrfToken: res.locals.csrfToken,
    });
  }
});

// Form buat/ubah label akun (diakses setelah login akun baru / oleh pemilik atau admin)
router.get('/:id/label', async (req, res) => {
  try {
    const account = await fileService.getAccount(Number(req.params.id));
    if (!account) return res.redirect('/accounts');
    res.render('accounts/label', {
      title: 'Buat Label',
      account,
      welcome: req.query.welcome === '1',
      error: null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Simpan label
router.post('/:id/label', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const account = await fileService.getAccount(id);
    if (!account) return res.redirect('/accounts');
    const label = (req.body.label || '').trim();
    if (label) await fileService.updateAccountLabel(id, label);
    res.redirect('/drive');
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Set akun aktif (untuk berpindah drive)
router.post('/:id/activate', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const account = await fileService.getAccount(id);
    if (account) req.session.activeAccountId = id;
    res.redirect('/drive');
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Hapus akun (logout + hapus sesi + metadata cascade) - Hanya Admin
router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await telegramManager.dropClient(id);
    await fileService.deleteAccount(id);
    if (req.session.activeAccountId === id) delete req.session.activeAccountId;
    res.redirect('/accounts');
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

module.exports = router;
