'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'tdrive',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true, // Izinkan multi-statement SQL untuk migrasi
});

/**
 * Memastikan kolom uuid ada dan terpopulasi di tabel tertentu.
 */
async function ensureUuidColumn(tableName) {
  try {
    // 1. Cek apakah kolom uuid sudah ada
    const [columns] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'uuid'`);
    if (columns.length === 0) {
      console.log(`Menambahkan kolom uuid ke tabel ${tableName}...`);
      
      // Tambah kolom uuid sebagai NULLable terlebih dahulu
      await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN uuid VARCHAR(36) DEFAULT NULL`);
      
      // 2. Isi nilai UUID v4 untuk baris data lama yang masih kosong
      const [rows] = await pool.query(`SELECT id FROM \`${tableName}\` WHERE uuid IS NULL`);
      console.log(`Mengisi UUID untuk ${rows.length} baris di ${tableName}...`);
      
      for (const row of rows) {
        const u = crypto.randomUUID();
        await pool.query(`UPDATE \`${tableName}\` SET uuid = ? WHERE id = ?`, [u, row.id]);
      }
      
      // 3. Ubah kolom menjadi NOT NULL dan buat UNIQUE index
      await pool.query(`ALTER TABLE \`${tableName}\` MODIFY COLUMN uuid VARCHAR(36) NOT NULL`);
      await pool.query(`ALTER TABLE \`${tableName}\` ADD UNIQUE KEY \`${tableName}_uuid_unique\` (uuid)`);
      console.log(`Kolom uuid di tabel ${tableName} berhasil dikonfigurasi.`);
    }
  } catch (err) {
    console.error(`Gagal migrasi kolom uuid untuk tabel ${tableName}:`, err);
    throw err;
  }
}

/**
 * Inisialisasi database MariaDB.
 * Membaca skema migrations-mariadb.sql dan menjalankannya secara idempotent.
 */
async function init() {
  try {
    const migrationPath = path.join(__dirname, 'migrations-mariadb.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    
    // Jalankan skema
    await pool.query(migrationSql);
    console.log('Database MariaDB berhasil diinisialisasi.');

    // Jalankan migrasi kolom UUID untuk folders, files, dan notes
    await ensureUuidColumn('folders');
    await ensureUuidColumn('files');
    await ensureUuidColumn('notes');
  } catch (err) {
    console.error('Gagal inisialisasi database MariaDB:', err);
    throw err;
  }
}

// Menambahkan referensi init ke objek pool agar bisa diakses di app.js
pool.init = init;

module.exports = pool;
