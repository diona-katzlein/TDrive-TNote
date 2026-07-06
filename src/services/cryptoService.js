'use strict';

const crypto = require('crypto');

// Kunci master 32 byte (hex 64 char) dari environment.
function getKey() {
  const hex = process.env.TDRIVE_MASTER_KEY;
  if (!hex) {
    throw new Error('TDRIVE_MASTER_KEY belum diset. Jalankan "npm run genkey" lalu isi .env');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('TDRIVE_MASTER_KEY harus 32 byte (64 karakter hex).');
  }
  return key;
}

/**
 * Enkripsi string -> { enc, iv, tag } (semua Buffer) untuk disimpan di SQLite.
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
}

/**
 * Dekripsi kembali menjadi string.
 */
function decrypt(enc, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
