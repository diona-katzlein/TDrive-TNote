'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const dbName = process.env.DB_DATABASE || 'tdrive';
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

// Buat pool tanpa memilih database terlebih dahulu agar tidak crash jika DB belum ada
const pool = mysql.createPool({
  ...dbConfig,
  database: dbName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true, // Izinkan multi-statement SQL untuk migrasi
});

/**
 * Membuat database jika belum ada
 */
async function ensureDatabaseExists() {
  const tempConn = await mysql.createConnection(dbConfig);
  try {
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[Database] Memastikan database \`${dbName}\` tersedia.`);
  } catch (err) {
    console.error(`[Database] Gagal memastikan database \`${dbName}\` ada:`, err.message);
  } finally {
    await tempConn.end();
  }
}

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
 * Memastikan kolom dinamis ada di tabel tertentu.
 */
async function ensureColumn(tableName, columnName, alterSql) {
  try {
    const [columns] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE '${columnName}'`);
    if (columns.length === 0) {
      console.log(`Menambahkan kolom ${columnName} ke tabel ${tableName}...`);
      await pool.query(alterSql);
    }
  } catch (err) {
    console.error(`Gagal menambahkan kolom ${columnName} ke tabel ${tableName}:`, err);
    throw err;
  }
}

/**
 * Inisialisasi database MariaDB.
 * Membaca skema migrations-mariadb.sql dan menjalankannya secara idempotent.
 */
async function init() {
  try {
    // Pastikan database sudah dibuat
    await ensureDatabaseExists();

    const migrationPath = path.join(__dirname, 'migrations-mariadb.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    
    // Jalankan skema
    await pool.query(migrationSql);
    console.log('Database MariaDB berhasil diinisialisasi.');

    // Jalankan migrasi kolom UUID untuk folders, files, dan notes
    await ensureUuidColumn('folders');
    await ensureUuidColumn('files');
    await ensureUuidColumn('notes');

    // Jalankan migrasi kolom-kolom baru untuk Recycle Bin, File Versioning, dan MFA
    await ensureColumn('folders', 'deleted_at', 'ALTER TABLE folders ADD COLUMN deleted_at BIGINT DEFAULT NULL');
    await ensureColumn('files', 'deleted_at', 'ALTER TABLE files ADD COLUMN deleted_at BIGINT DEFAULT NULL');
    await ensureColumn('files', 'parent_file_id', 'ALTER TABLE files ADD COLUMN parent_file_id INT DEFAULT NULL, ADD CONSTRAINT fk_files_parent FOREIGN KEY (parent_file_id) REFERENCES files(id) ON DELETE SET NULL');
    await ensureColumn('accounts', 'mfa_secret', 'ALTER TABLE accounts ADD COLUMN mfa_secret VARCHAR(128) DEFAULT NULL');
    await ensureColumn('accounts', 'user_type', 'ALTER TABLE accounts ADD COLUMN user_type VARCHAR(20) DEFAULT "Free"');

    // Perbesar ukuran channel_id di user_channels agar muat JSON string storage peer
    try {
      await pool.query('ALTER TABLE user_channels MODIFY COLUMN channel_id VARCHAR(255) NOT NULL');
    } catch (_) {}
  } catch (err) {
    console.error('Gagal inisialisasi database MariaDB:', err);
    throw err;
  }
}

// Menambahkan referensi init ke objek pool agar bisa diakses di app.js
pool.init = init;

module.exports = pool;
