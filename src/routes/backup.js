'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const os = require('os');

const auditService = require('../services/auditService');
const { requireAdmin } = require('../middleware/restrictAccess');

// Hanya admin yang boleh mengakses backup
router.use(requireAdmin);

// Direktori penyimpanan backup
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Konfigurasi MariaDB / MySQL berdasarkan OS.
 */
function getDbConfig() {
  const isWindows = os.platform() === 'win32';
  const binPath = isWindows
    ? (process.env.MARIADB_BIN_PATH || 'C:\\wamp64\\bin\\mariadb\\mariadb11.5.2\\bin')
    : '';

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || '3307';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_DATABASE || 'tdrive';

  return { isWindows, binPath, host, port, user, password, database };
}

/**
 * Bangun command mysqldump/mariadb-dump.
 */
function buildDumpCommand(config, outputPath) {
  const { isWindows, binPath, host, port, user, password, database } = config;

  // Coba mariadb-dump dulu, fallback ke mysqldump
  let dumpBin;
  if (isWindows) {
    const mariadbDump = path.join(binPath, 'mariadb-dump.exe');
    const mysqlDump = path.join(binPath, 'mysqldump.exe');
    dumpBin = fs.existsSync(mariadbDump) ? `"${mariadbDump}"` : `"${mysqlDump}"`;
  } else {
    // Linux: cek ketersediaan mariadb-dump atau mysqldump di $PATH
    dumpBin = 'mariadb-dump || mysqldump';
    // Kita gunakan which-based approach
    dumpBin = 'mysqldump'; // fallback standar
  }

  let cmd = `${dumpBin} --host=${host} --port=${port} --user=${user}`;
  if (password) {
    cmd += ` --password=${password}`;
  }
  cmd += ` --single-transaction --routines --triggers --events ${database}`;
  cmd += ` > "${outputPath}"`;

  // Untuk Linux, kita coba mariadb-dump terlebih dahulu
  if (!isWindows) {
    cmd = `(command -v mariadb-dump > /dev/null 2>&1 && mariadb-dump --host=${host} --port=${port} --user=${user}${password ? ` --password=${password}` : ''} --single-transaction --routines --triggers --events ${database} > "${outputPath}") || (mysqldump --host=${host} --port=${port} --user=${user}${password ? ` --password=${password}` : ''} --single-transaction --routines --triggers --events ${database} > "${outputPath}")`;
  }

  return cmd;
}

// Halaman utama backup
router.get('/', async (req, res) => {
  try {
    // Baca daftar file backup yang ada
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          name: f,
          size: stat.size,
          created: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.created - a.created); // Terbaru di atas

    const config = getDbConfig();

    res.render('backup', {
      title: 'Backup Database',
      backups: files,
      dbConfig: {
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        os: config.isWindows ? 'Windows' : 'Linux',
        binPath: config.isWindows ? config.binPath : '(System PATH)',
      },
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat halaman backup: ' + err.message);
  }
});

// Proses backup database
router.post('/create', async (req, res) => {
  try {
    const config = getDbConfig();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `tdrive_backup_${timestamp}.sql`;
    const outputPath = path.join(BACKUP_DIR, filename);

    const cmd = buildDumpCommand(config, outputPath);

    console.log(`[Backup] Menjalankan backup database...`);
    console.log(`[Backup] Command: ${cmd.replace(/--password=\S+/, '--password=***')}`);

    await new Promise((resolve, reject) => {
      exec(cmd, { maxBuffer: 100 * 1024 * 1024, shell: config.isWindows ? 'cmd.exe' : '/bin/bash' }, (error, stdout, stderr) => {
        if (error) {
          console.error('[Backup] Error:', error.message);
          // Hapus file kosong jika ada
          if (fs.existsSync(outputPath)) {
            const stat = fs.statSync(outputPath);
            if (stat.size === 0) fs.unlinkSync(outputPath);
          }
          return reject(new Error(stderr || error.message));
        }
        // Verifikasi file output
        if (!fs.existsSync(outputPath)) {
          return reject(new Error('File backup tidak ditemukan setelah proses dump.'));
        }
        const stat = fs.statSync(outputPath);
        if (stat.size === 0) {
          fs.unlinkSync(outputPath);
          return reject(new Error('File backup kosong. Periksa konfigurasi database.'));
        }
        console.log(`[Backup] Berhasil: ${filename} (${(stat.size / 1024).toFixed(1)} KB)`);
        resolve();
      });
    });

    await auditService.log(req, 'DATABASE_BACKUP', `Membuat backup database: ${filename}`);
    res.redirect('/backup?notice=' + encodeURIComponent(`Backup berhasil dibuat: ${filename}`));
  } catch (err) {
    res.redirect('/backup?error=' + encodeURIComponent('Gagal membuat backup: ' + err.message));
  }
});

// Download file backup
router.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  // Sanitize: hanya izinkan karakter aman
  if (!/^[\w\-]+\.sql$/.test(filename)) {
    return res.status(400).send('Nama file tidak valid.');
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File backup tidak ditemukan.');
  }
  res.download(filePath, filename);
});

// Hapus file backup
router.post('/delete/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!/^[\w\-]+\.sql$/.test(filename)) {
    return res.redirect('/backup?error=' + encodeURIComponent('Nama file tidak valid.'));
  }
  const filePath = path.join(BACKUP_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      await auditService.log(req, 'DELETE_BACKUP', `Menghapus file backup: ${filename}`);
    }
    res.redirect('/backup?notice=' + encodeURIComponent(`Backup "${filename}" berhasil dihapus.`));
  } catch (err) {
    res.redirect('/backup?error=' + encodeURIComponent('Gagal menghapus: ' + err.message));
  }
});

module.exports = router;
