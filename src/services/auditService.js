'use strict';

const db = require('../db');

/**
 * Audit Log Service
 * Mencatat aktivitas pengguna di database audit_logs dan menampilkannya di terminal.
 */

/**
 * Mencatat aksi audit trail.
 * @param {object} req Objek Request Express untuk mengambil info IP dan sesi
 * @param {string} action Kategori aksi (misalnya: 'UPLOAD_FILE', 'DELETE_NOTE')
 * @param {string} details Rincian detail dari aksi tersebut
 */
async function log(req, action, details) {
  const userPhone = (req && req.session && req.session.userPhone) ? req.session.userPhone : 'Public/System';
  let ipAddress = '127.0.0.1';
  if (req) {
    // Cari real IP client di Cloudflare header dulu, lalu x-forwarded-for, baru fallback ke req.ip
    const cfIp = req.headers['cf-connecting-ip'];
    const xForwardedFor = req.headers['x-forwarded-for'];
    
    if (cfIp) {
      ipAddress = cfIp;
    } else if (xForwardedFor) {
      // x-forwarded-for bisa berisi "client, proxy1, proxy2". Kita ambil elemen pertama.
      ipAddress = xForwardedFor.split(',')[0].trim();
    } else {
      ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
    }
  }
  const timestamp = Date.now();
  
  try {
    await db.query(
      'INSERT INTO audit_logs (user_phone, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)',
      [userPhone, action, details || null, ipAddress, timestamp]
    );
    console.log(`[AUDIT LOG] ${new Date(timestamp).toISOString()} | User: ${userPhone} | IP: ${ipAddress} | Action: ${action} | Details: ${details || '-'}`);
  } catch (err) {
    console.error('Gagal mencatat audit log ke DB:', err);
  }
}

module.exports = {
  log,
};
