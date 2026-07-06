'use strict';

const crypto = require('crypto');

/**
 * Menurunkan kunci enkripsi 32-byte dari kata sandi dan salt.
 * Menggunakan scryptSync yang bawaan dan aman.
 * @param {string} passphrase 
 * @param {string} salt 
 * @returns {Buffer} 32-byte key
 */
function deriveKey(passphrase, salt) {
  if (!passphrase || !salt) {
    throw new Error('Sandi dan salt diperlukan untuk penurunan kunci.');
  }
  // salt dikonversi ke buffer jika masih string hex/utf8
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'hex');
  return crypto.scryptSync(String(passphrase), saltBuf, 32);
}

/**
 * Mengenkripsi teks biasa dengan kunci AES-256-GCM.
 * Menghasilkan format string hex: "iv:ciphertext:tag"
 * @param {string} text 
 * @param {Buffer} key 32-byte key
 * @returns {string} iv:ciphertext:tag
 */
function encrypt(text, key) {
  if (text == null) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Mendekripsi string ciphertext berformat "iv:ciphertext:tag" dengan kunci AES-256-GCM.
 * @param {string} encryptedStr 
 * @param {Buffer} key 32-byte key
 * @returns {string} plaintext
 */
function decrypt(encryptedStr, key) {
  if (!encryptedStr) return '';
  const parts = String(encryptedStr).split(':');
  if (parts.length !== 3) {
    throw new Error('Format teks terenkripsi tidak valid.');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = {
  deriveKey,
  encrypt,
  decrypt,
};
