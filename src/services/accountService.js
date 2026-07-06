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
  const existing = fileService.getAccountByPhone(result.phone);

  if (existing) {
    // Login ulang: perbarui StringSession & pasang client ke pool.
    const freshSession = result.client.session.save();
    fileService.updateAccountSession(existing.id, freshSession);
    telegramManager.registerClient(existing.id, result.client);
    return { account: fileService.getAccount(existing.id), isNew: false };
  }

  // Akun baru: buat channel privat sebagai storage.
  const peer = await storageService.createStorageChannel(result.client);
  // Simpan sesi SETELAH channel dibuat agar entity ter-cache di StringSession.
  const sessionStr = result.client.session.save();

  const account = fileService.createAccount({
    // Label default = nomor telepon; pengguna diminta membuat label setelah login.
    label: result.label || result.phone,
    phone: result.phone,
    apiId: result.apiId,
    apiHash: result.apiHash,
    sessionStr,
    storagePeer: JSON.stringify(peer),
  });
  telegramManager.registerClient(account.id, result.client);
  return { account, isNew: true };
}

module.exports = { ensureAccountFromLogin, isPhoneAllowed, normPhone };
