'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'tdrive.sqlite');

async function migrate() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`SQLite database tidak ditemukan di ${DB_PATH}. Migrasi dilewati.`);
    return;
  }

  console.log(`Menghubungkan ke SQLite di ${DB_PATH}...`);
  const sqliteDb = new Database(DB_PATH, { readonly: true });

  console.log('Menghubungkan ke MariaDB...');
  const mariadbPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tdrive',
  });

  const connection = await mariadbPool.getConnection();

  try {
    console.log('Memulai migrasi data...');
    // Nonaktifkan foreign key check sementara agar migrasi mulus
    await connection.query('SET FOREIGN_KEY_CHECKS = 0;');

    // 1. Migrate accounts
    console.log('Migrasi tabel accounts...');
    const accounts = sqliteDb.prepare('SELECT * FROM accounts').all();
    for (const acc of accounts) {
      await connection.query(
        `INSERT INTO accounts (id, label, phone, api_id, api_hash, session_enc, session_iv, session_tag, storage_peer, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label=VALUES(label), session_enc=VALUES(session_enc), status=VALUES(status)`,
        [
          acc.id,
          acc.label,
          acc.phone,
          acc.api_id,
          acc.api_hash,
          acc.session_enc, // Buffer
          acc.session_iv,  // Buffer
          acc.session_tag, // Buffer
          acc.storage_peer,
          acc.status,
          acc.created_at,
          acc.updated_at,
        ]
      );
    }
    console.log(`Berhasil memindahkan ${accounts.length} akun.`);

    // 2. Migrate folders
    console.log('Migrasi tabel folders...');
    const folders = sqliteDb.prepare('SELECT * FROM folders').all();
    for (const fol of folders) {
      await connection.query(
        `INSERT INTO folders (id, account_id, parent_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name)`,
        [fol.id, fol.account_id, fol.parent_id, fol.name, fol.created_at]
      );
    }
    console.log(`Berhasil memindahkan ${folders.length} folder.`);

    // 3. Migrate files
    console.log('Migrasi tabel files...');
    const files = sqliteDb.prepare('SELECT * FROM files').all();
    for (const fil of files) {
      await connection.query(
        `INSERT INTO files (id, account_id, folder_id, name, size, mime, sha256, is_chunked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), folder_id=VALUES(folder_id)`,
        [
          fil.id,
          fil.account_id,
          fil.folder_id,
          fil.name,
          fil.size,
          fil.mime,
          fil.sha256,
          fil.is_chunked,
          fil.created_at,
          fil.updated_at,
        ]
      );
    }
    console.log(`Berhasil memindahkan ${files.length} file.`);

    // 4. Migrate file_chunks
    console.log('Migrasi tabel file_chunks...');
    const chunks = sqliteDb.prepare('SELECT * FROM file_chunks').all();
    for (const chk of chunks) {
      await connection.query(
        `INSERT INTO file_chunks (id, file_id, part_index, message_id, peer, size)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE message_id=VALUES(message_id)`,
        [chk.id, chk.file_id, chk.part_index, chk.message_id, chk.peer, chk.size]
      );
    }
    console.log(`Berhasil memindahkan ${chunks.length} chunk file.`);

    // 5. Migrate notes
    console.log('Migrasi tabel notes...');
    const notes = sqliteDb.prepare('SELECT * FROM notes').all();
    for (const nt of notes) {
      await connection.query(
        `INSERT INTO notes (id, account_id, title, body, message_id, peer, synced, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body)`,
        [
          nt.id,
          nt.account_id,
          nt.title,
          nt.body,
          nt.message_id,
          nt.peer,
          nt.synced,
          nt.created_at,
          nt.updated_at,
        ]
      );
    }
    console.log(`Berhasil memindahkan ${notes.length} catatan.`);

    // Kembalikan foreign key check
    await connection.query('SET FOREIGN_KEY_CHECKS = 1;');
    console.log('Migrasi data selesai dengan sukses!');
  } catch (err) {
    console.error('Terjadi kesalahan saat migrasi data:', err);
  } finally {
    connection.release();
    sqliteDb.close();
    await mariadbPool.end();
  }
}

if (require.main === module) {
  migrate().catch(console.error);
}

module.exports = migrate;
