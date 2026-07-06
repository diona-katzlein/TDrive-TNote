'use strict';

const fileService = require('./fileService');
const storageService = require('./storageService');
const telegramManager = require('./telegramManager');

/**
 * accountService — logika finalisasi akun setelah login Telegram sukses,
 * dipakai bersama oleh alur "login" dan "tambah akun".
 */

/** Normalisasi nomor untuk pembandingan (hanya digit & '+'). */
function normPhone(p) {
  return String(p || '').replace(/[^\d+]/g, '');
}

/** Daftar nomor yang diizinkan login (opsional, dari env). Kosong = tanpa batasan. */
function allowedPhones() {
  return (process.env.TDRIVE_ALLOWED_PHONES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normPhone);
}

function isPhoneAllowed(phone) {
  const list = allowedPhones();
  if (!list.length) return true;
  return list.includes(normPhone(phone));
}

/**
 * Pastikan ada row akun untuk hasil login. Jika nomor sudah ada → perbarui sesi.
 * Jika baru → buat channel storage privat lalu simpan akun.
 * @param {object} result hasil telegramManager.completeLogin (punya .client, .sessionStr, dst.)
 * @returns {Promise<object>} row akun
 */
async function ensureAccountFromLogin(result) {
  const existing = await fileService.getAccountByPhone(result.phone);

  if (existing) {
    // Login ulang: perbarui StringSession & pasang client ke pool.
    const freshSession = result.client.session.save();
    await fileService.updateAccountSession(existing.id, freshSession);
    telegramManager.registerClient(existing.id, result.client);
    return { account: await fileService.getAccount(existing.id), isNew: false };
  }

  // Akun baru: buat channel privat sebagai storage.
  const peer = await storageService.createStorageChannel(result.client);
  // Simpan sesi SETELAH channel dibuat agar entity ter-cache di StringSession.
  const sessionStr = result.client.session.save();

  const account = await fileService.createAccount({
    // Label default = nomor telepon; pengguna diminta membuat label setelah login.
    label: result.label || result.phone,
    phone: result.phone,
    apiId: result.apiId,
    apiHash: result.apiHash,
    sessionStr,
    storagePeer: JSON.stringify(peer),
  });
  telegramManager.registerClient(account.id, result.client);

  // Masukkan channel default ini ke user_channels agar terhitung 1/10
  const db = require('../db');
  await db.query(
    'INSERT INTO user_channels (account_id, channel_id, title, created_at) VALUES (?, ?, ?, ?)',
    [account.id, JSON.stringify(peer), 'TDrive Storage (Default)', Date.now()]
  );

  return { account, isNew: true };
}

module.exports = { ensureAccountFromLogin, isPhoneAllowed, normPhone };
