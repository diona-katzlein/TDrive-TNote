'use strict';

const crypto = require('crypto');

// Alfabet Base32 (RFC 4648)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Mendekode string Base32 menjadi Buffer.
 */
function base32Decode(str) {
  const cleaned = str.replace(/=+$/, '').toUpperCase();
  const len = cleaned.length;
  const buf = Buffer.alloc(Math.floor((len * 5) / 8));
  let bits = 0;
  let val = 0;
  let index = 0;

  for (let i = 0; i < len; i++) {
    const c = cleaned.charAt(i);
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Karakter Base32 tidak valid.');
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      buf[index++] = (val >> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return buf;
}

/**
 * Menghasilkan token HOTP (RFC 4226)
 */
function generateHOTP(secretBuf, counter) {
  // Counter harus berupa buffer 8-byte
  const buf = Buffer.alloc(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }

  const hmac = crypto.createHmac('sha1', secretBuf);
  hmac.update(buf);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  const otp = code % 1000000;
  return String(otp).padStart(6, '0');
}

/**
 * Memverifikasi token TOTP (RFC 6238) dengan toleransi waktu (window).
 */
function verifyTOTP(token, secret, window = 1, timeStep = 30) {
  try {
    if (!token || !secret) return false;
    const secretBuf = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / timeStep);
    
    // Periksa dengan toleransi window (mencegah desinkronisasi jam)
    for (let i = -window; i <= window; i++) {
      const generated = generateHOTP(secretBuf, counter + i);
      if (generated === String(token).trim()) {
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Menghasilkan secret Base32 acak sepanjang 16 karakter.
 */
function generateSecret(length = 16) {
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += ALPHABET.charAt(crypto.randomInt(0, 32));
  }
  return secret;
}

/**
 * Menghasilkan URL QR Code menggunakan API qrserver gratis & aman.
 */
function getQrCodeUrl(label, secret, issuer = 'TDrive-TNote') {
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
}

module.exports = {
  generateSecret,
  verifyTOTP,
  getQrCodeUrl,
};
