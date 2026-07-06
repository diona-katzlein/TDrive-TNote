'use strict';

const express = require('express');
const router = express.Router();

const fileService = require('../services/fileService');
const cryptoService = require('../services/cryptoService');
const { isPhoneAllowed } = require('../services/accountService');

// Tampilkan profil pengguna
router.get('/', async (req, res) => {
  try {
    const phone = req.session.userPhone;
    const account = await fileService.getAccountByPhone(phone);
    const isAllowed = isPhoneAllowed(phone);

    res.render('profile', {
      title: 'Profil Saya',
      account,
      phone,
      isAllowed,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Atur/Ubah Kata Sandi Sistem
router.post('/password', async (req, res) => {
  const { password, confirm_password } = req.body;
  try {
    if (!password || !password.trim()) throw new Error('Kata sandi tidak boleh kosong.');
    if (password !== confirm_password) throw new Error('Konfirmasi kata sandi tidak cocok.');

    const phone = req.session.userPhone;
    const account = await fileService.getAccountByPhone(phone);
    if (!account) throw new Error('Akun Telegram Anda belum tersimpan di database.');

    const hash = cryptoService.hashPassword(password);
    await fileService.updateAccountPassword(account.id, hash);

    res.redirect('/profile?notice=' + encodeURIComponent('Kata sandi / PIN sistem berhasil diperbarui. Anda sekarang dapat masuk menggunakan sandi ini tanpa OTP Telegram pada browser lain.'));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
