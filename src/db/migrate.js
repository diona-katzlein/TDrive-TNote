'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./index');

const databaseName = process.env.DB_DATABASE || 'tdrive';
const dryRun = process.argv.includes('--dry-run');
const lockName = `tdrive:migrate:${databaseName}`;

function assertSafeConfiguration() {
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseName)) {
    throw new Error('DB_DATABASE mengandung karakter yang tidak aman.');
  }

  const migrationPath = path.join(__dirname, 'migrations-mariadb.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const withoutComments = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const destructivePatterns = [
    { regex: /\bDROP\s+(?:TABLE|DATABASE|COLUMN|INDEX)\b/i, label: 'DROP' },
    { regex: /\bTRUNCATE\s+(?:TABLE\s+)?/i, label: 'TRUNCATE' },
    { regex: /\bDELETE\s+FROM\b/i, label: 'DELETE FROM' },
  ];

  for (const rule of destructivePatterns) {
    if (rule.regex.test(withoutComments)) {
      throw new Error(`Migrasi dibatalkan: operasi destruktif ${rule.label} terdeteksi.`);
    }
  }

  return migrationPath;
}

async function main() {
  let lockConnection;
  let lockAcquired = false;

  try {
    const migrationPath = assertSafeConfiguration();
    console.log(`[Migrate] Target database : ${databaseName}`);
    console.log(`[Migrate] Migration file : ${migrationPath}`);

    if (dryRun) {
      console.log('[Migrate] DRY RUN berhasil. Tidak ada perubahan database yang dijalankan.');
      return;
    }

    lockConnection = await db.getConnection();
    const [lockRows] = await lockConnection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    lockAcquired = Number(lockRows[0] && lockRows[0].acquired) === 1;
    if (!lockAcquired) {
      throw new Error('Tidak dapat memperoleh migration lock dalam 30 detik. Migrasi lain mungkin sedang berjalan.');
    }

    console.log('[Migrate] Lock diperoleh. Menjalankan migrasi idempoten...');
    await db.init();
    console.log('[Migrate] Migrasi selesai tanpa menghapus data yang sudah ada.');
  } finally {
    if (lockConnection) {
      if (lockAcquired) {
        await lockConnection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      }
      lockConnection.release();
    }
    await db.end();
  }
}

main().catch((err) => {
  console.error('[Migrate] GAGAL:', err.message);
  process.exitCode = 1;
});
