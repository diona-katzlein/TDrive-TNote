'use strict';

const express = require('express');
const router = express.Router();
const { Api } = require('telegram');

const db = require('../db');
const fileService = require('../services/fileService');
const cryptoService = require('../services/cryptoService');
const totpService = require('../services/totpService');
const auditService = require('../services/auditService');
const telegramManager = require('../services/telegramManager');
const { isPhoneAllowed } = require('../services/accountService');
const { requireActiveAccount } = require('../middleware/activeAccount');

// Tampilkan profil pengguna
router.get('/', requireActiveAccount, async (req, res) => {
  try {
    const phone = req.session.userPhone;
    const account = req.activeAccount;
    const isAllowed = isPhoneAllowed(phone);

    // Ambil daftar private channel buatan user
    const [channels] = await db.query('SELECT * FROM user_channels WHERE account_id = ? ORDER BY created_at DESC', [account.id]);

    res.render('profile', {
      title: 'Profil Saya',
      account,
      phone,
      isAllowed,
      channels,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Terjadi kesalahan: ' + err.message);
  }
});

// Atur/Ubah Kata Sandi Sistem
router.post('/password', requireActiveAccount, async (req, res) => {
  const { password, confirm_password } = req.body;
  try {
    if (!password || !password.trim()) throw new Error('Kata sandi tidak boleh kosong.');
    if (password !== confirm_password) throw new Error('Konfirmasi kata sandi tidak cocok.');

    const account = req.activeAccount;
    const hash = cryptoService.hashPassword(password);
    
    await fileService.updateAccountPassword(account.id, hash);
    await auditService.log(req, 'UPDATE_PASSWORD', 'Memperbarui kata sandi masuk sistem.');

    res.redirect('/profile?notice=' + encodeURIComponent('Kata sandi / PIN sistem berhasil diperbarui.'));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

// ----------------------------------------------------
// LOGIKA MFA / 2FA
// ----------------------------------------------------

// Setup MFA: Tampilkan QR Code & Base32 Key
router.get('/mfa/setup', requireActiveAccount, (req, res) => {
  try {
    const account = req.activeAccount;
    if (account.mfa_secret) {
      return res.redirect('/profile?error=' + encodeURIComponent('MFA sudah aktif pada akun Anda.'));
    }

    // Generate secret sementara jika belum ada di session
    if (!req.session.tempMfaSecret) {
      req.session.tempMfaSecret = totpService.generateSecret();
    }

    const qrUrl = totpService.getQrCodeUrl(account.phone, req.session.tempMfaSecret);

    res.render('profile/mfa-setup', {
      title: 'Setup 2FA',
      secret: req.session.tempMfaSecret,
      qrUrl,
      error: null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat setup MFA: ' + err.message);
  }
});

// Proses aktivasi MFA setelah verifikasi token 6-digit sukses
router.post('/mfa/enable', requireActiveAccount, async (req, res) => {
  const { token } = req.body;
  const tempSecret = req.session.tempMfaSecret;
  
  try {
    if (!tempSecret) throw new Error('Sesi pembuatan 2FA kedaluwarsa. Silakan mulai ulang.');
    if (!token) throw new Error('Kode verifikasi wajib diisi.');

    const isValid = totpService.verifyTOTP(token, tempSecret);
    if (!isValid) throw new Error('Kode verifikasi salah atau kedaluwarsa.');

    // Simpan secret MFA ke database
    await db.query('UPDATE accounts SET mfa_secret = ? WHERE id = ?', [tempSecret, req.activeAccount.id]);
    req.activeAccount.mfa_secret = tempSecret;

    delete req.session.tempMfaSecret;
    await auditService.log(req, 'ENABLE_MFA', 'Mengaktifkan Autentikasi Dua Faktor (2FA/TOTP).');

    res.redirect('/profile?notice=' + encodeURIComponent('Autentikasi Dua Faktor (2FA) berhasil diaktifkan!'));
  } catch (err) {
    const qrUrl = tempSecret ? totpService.getQrCodeUrl(req.activeAccount.phone, tempSecret) : '';
    res.render('profile/mfa-setup', {
      title: 'Setup 2FA',
      secret: tempSecret || '',
      qrUrl,
      error: err.message,
      csrfToken: res.locals.csrfToken,
    });
  }
});

// Nonaktifkan MFA
router.post('/mfa/disable', requireActiveAccount, async (req, res) => {
  try {
    await db.query('UPDATE accounts SET mfa_secret = NULL WHERE id = ?', [req.activeAccount.id]);
    req.activeAccount.mfa_secret = null;

    await auditService.log(req, 'DISABLE_MFA', 'Menonaktifkan Autentikasi Dua Faktor (2FA/TOTP).');
    res.redirect('/profile?notice=' + encodeURIComponent('Autentikasi Dua Faktor (2FA) dinonaktifkan.'));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

// ----------------------------------------------------
// LOGIKA PEER STORAGE & TELEGRAM CHANNELS
// ----------------------------------------------------

// Set manual peer penyimpanan
router.post('/storage-peer', requireActiveAccount, async (req, res) => {
  const peer = (req.body.storage_peer || '').trim() || 'me';
  try {
    await fileService.updateAccountStoragePeer(req.activeAccount.id, peer);
    await auditService.log(req, 'UPDATE_STORAGE_PEER', `Mengubah target penyimpanan menjadi "${peer}".`);
    res.redirect('/profile?notice=' + encodeURIComponent('Target penyimpanan berhasil diperbarui.'));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

// Buat Channel Telegram baru otomatis via GramJS
router.post('/channel/create', requireActiveAccount, async (req, res) => {
  const title = (req.body.title || '').trim() || 'TDrive Cloud Storage';
  
  try {
    const account = req.activeAccount;
    
    // 1. Cek jumlah channel terpakai
    const [rows] = await db.query('SELECT COUNT(*) AS count FROM user_channels WHERE account_id = ?', [account.id]);
    const currentCount = rows[0].count;
    
    // Terapkan batasan Free vs Premium
    const limit = account.user_type === 'Premium' ? 500 : 10;
    if (currentCount >= limit) {
      throw new Error(`Batas pembuatan channel terlampaui. Akun ${account.user_type} dibatasi maksimal ${limit} channel.`);
    }

    // 2. Hubungkan client GramJS
    const client = await telegramManager.getClient(account);
    
    // 3. Panggil API Telegram untuk buat channel
    console.log(`[GramJS] Membuat private channel baru: "${title}"...`);
    const result = await client.invoke(new Api.channels.CreateChannel({
      title: title,
      about: 'TDrive Storage Channel',
      megagroup: false,
    }));

    let channelId = null;
    const updates = result.updates;
    for (const u of updates) {
      if (u.channelId) {
        channelId = String(u.channelId);
        break;
      }
    }
    if (!channelId && result.chats && result.chats.length > 0) {
      channelId = String(result.chats[0].id);
    }

    if (!channelId) {
      throw new Error('Gagal mengekstrak ID Channel yang baru dibuat.');
    }

    // Catatan: Telegram channel ID di GramJS biasanya berupa string angka negatif atau format ID mentah.
    // Kita simpan ke DB.
    await db.query(
      'INSERT INTO user_channels (account_id, channel_id, title, created_at) VALUES (?, ?, ?, ?)',
      [account.id, channelId, title, Date.now()]
    );

    // 4. Otomatis set channel ID sebagai Storage Peer aktif
    await fileService.updateAccountStoragePeer(account.id, channelId);

    await auditService.log(req, 'CREATE_STORAGE_CHANNEL', `Membuat private channel "${title}" (ID: ${channelId}) dan menjadikannya peer penyimpanan.`);
    res.redirect('/profile?notice=' + encodeURIComponent(`Private channel "${title}" berhasil dibuat dan dikonfigurasi sebagai peer penyimpanan aktif!`));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent('Gagal membuat channel: ' + err.message));
  }
});

module.exports = router;
