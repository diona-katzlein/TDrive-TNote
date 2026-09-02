'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const db = require('../db');
const { assertRestoreAllowed, validBackupFilename } = require('./phase2Validation');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'data', 'backups'));
const MAGIC = Buffer.from('TDRIVEBACKUP1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
let scheduler = null;
let running = false;

function getDbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: String(process.env.DB_PORT || '3307'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tdrive',
  };
}

function getEncryptionKey() {
  const value = process.env.BACKUP_ENCRYPTION_KEY || process.env.TDRIVE_MASTER_KEY;
  if (!/^[a-fA-F0-9]{64}$/.test(value || '')) {
    throw new Error('BACKUP_ENCRYPTION_KEY atau TDRIVE_MASTER_KEY harus berupa 64 karakter heksadesimal.');
  }
  return Buffer.from(value, 'hex');
}

function dumpCandidates() {
  if (os.platform() === 'win32') {
    const binPath = process.env.MARIADB_BIN_PATH || 'C:\\wamp64\\bin\\mariadb\\mariadb11.5.2\\bin';
    return [path.join(binPath, 'mariadb-dump.exe'), path.join(binPath, 'mysqldump.exe')];
  }
  return ['mariadb-dump', 'mysqldump'];
}

function dumpArguments(config) {
  return [
    `--host=${config.host}`,
    `--port=${config.port}`,
    `--user=${config.user}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--default-character-set=utf8mb4',
    config.database,
  ];
}

function spawnDump(candidate, config) {
  return spawn(candidate, dumpArguments(config), {
    env: { ...process.env, MYSQL_PWD: config.password },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function openDumpProcess(config) {
  const candidates = dumpCandidates();
  for (let index = 0; index < candidates.length; index += 1) {
    const child = spawnDump(candidates[index], config);
    const result = await new Promise((resolve) => {
      let settled = false;
      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          resolve({ child, command: candidates[index] });
        }
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          resolve({ error });
        }
      });
    });
    if (result.child) return result;
    if (index === candidates.length - 1) throw result.error;
  }
  throw new Error('mariadb-dump atau mysqldump tidak ditemukan.');
}

async function insertRun(triggerType) {
  const now = Date.now();
  const [result] = await db.query(
    `INSERT INTO backup_runs (status, trigger_type, encrypted, created_at)
     VALUES ('running', ?, 1, ?)`,
    [triggerType, now]
  );
  return result.insertId;
}

async function finishRun(id, values) {
  await db.query(
    `UPDATE backup_runs
       SET filename = ?, status = ?, size_bytes = ?, checksum_sha256 = ?,
           verified_at = ?, error_message = ?, completed_at = ?
     WHERE id = ?`,
    [
      values.filename || null,
      values.status,
      values.sizeBytes || null,
      values.checksum || null,
      values.verifiedAt || null,
      values.error ? String(values.error).slice(0, 500) : null,
      Date.now(),
      id,
    ]
  );
}

async function replicateBackup(filePath, filename, checksum) {
  if (!process.env.BACKUP_SECONDARY_DIR) return null;
  const secondaryDir = path.resolve(process.env.BACKUP_SECONDARY_DIR);
  if (secondaryDir === BACKUP_DIR) throw new Error('Secondary backup directory must differ from BACKUP_DIR.');
  await fsp.mkdir(secondaryDir, { recursive: true });
  const destination = path.join(secondaryDir, filename);
  const temporary = `${destination}.partial`;
  await fsp.copyFile(filePath, temporary, fs.constants.COPYFILE_EXCL);
  const replicaChecksum = await sha256File(temporary);
  if (replicaChecksum !== checksum) {
    await fsp.unlink(temporary).catch(() => {});
    throw new Error('Secondary backup checksum mismatch.');
  }
  await fsp.rename(temporary, destination);
  return destination;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function verifyBackup(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const minimum = MAGIC.length + IV_LENGTH + TAG_LENGTH + 1;
    if (stat.size < minimum) throw new Error('Backup terenkripsi tidak lengkap.');

    const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Format backup tidak dikenali.');

    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, stat.size - TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);

    let sample = '';
    decipher.on('data', (chunk) => {
      if (sample.length < 65536) sample += chunk.toString('utf8');
    });
    await pipeline(
      fs.createReadStream(filePath, {
        start: header.length,
        end: stat.size - TAG_LENGTH - 1,
      }),
      decipher
    );
    if (!/(MariaDB dump|MySQL dump|CREATE TABLE|INSERT INTO)/i.test(sample)) {
      throw new Error('Konten hasil dekripsi tidak terlihat seperti SQL dump.');
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function applyRetention() {
  const keep = Math.max(1, Number(process.env.BACKUP_RETENTION_COUNT || 14));
  const files = (await fsp.readdir(BACKUP_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^tdrive_backup_[\w-]+\.sql\.enc$/.test(entry.name));
  const entries = await Promise.all(files.map(async (entry) => ({
    name: entry.name,
    stat: await fsp.stat(path.join(BACKUP_DIR, entry.name)),
  })));
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  await Promise.all(entries.slice(keep).map((entry) => fsp.unlink(path.join(BACKUP_DIR, entry.name))));
}

async function createBackup(triggerType = 'manual') {
  if (running) throw new Error('Proses backup lain sedang berjalan.');
  running = true;
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const runId = await insertRun(triggerType);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `tdrive_backup_${timestamp}.sql.enc`;
  const outputPath = path.join(BACKUP_DIR, filename);
  const temporaryPath = `${outputPath}.partial`;

  try {
    const config = getDbConfig();
    const { child, command } = await openDumpProcess(config);
    console.info(`[Backup] Menjalankan ${path.basename(command)} untuk backup ${runId}.`);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Dump berhenti dengan kode ${code}.`)));
    });

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const output = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
    output.write(Buffer.concat([MAGIC, iv]));
    await pipeline(child.stdout, cipher, output, { end: false });
    await exitPromise;
    output.end(cipher.getAuthTag());
    await new Promise((resolve, reject) => {
      output.once('close', resolve);
      output.once('error', reject);
    });

    await fsp.rename(temporaryPath, outputPath);
    await verifyBackup(outputPath);
    const stat = await fsp.stat(outputPath);
    const checksum = await sha256File(outputPath);
    const replica = await replicateBackup(outputPath, filename, checksum);
    await finishRun(runId, {
      filename,
      status: 'success',
      sizeBytes: stat.size,
      checksum,
      verifiedAt: Date.now(),
    });
    await applyRetention();
    return { id: runId, filename, size: stat.size, checksum, verified: true, replicated: Boolean(replica) };
  } catch (error) {
    await Promise.allSettled([fsp.unlink(temporaryPath), fsp.unlink(outputPath)]);
    await finishRun(runId, { filename, status: 'failed', error: error.message });
    throw error;
  } finally {
    running = false;
  }
}

async function listBackups() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const names = await fsp.readdir(BACKUP_DIR);
  const valid = names.filter((name) => /^tdrive_backup_[\w-]+\.sql\.enc$/.test(name));
  const files = await Promise.all(valid.map(async (name) => {
    const stat = await fsp.stat(path.join(BACKUP_DIR, name));
    return { name, size: stat.size, created: stat.mtimeMs };
  }));
  return files.sort((a, b) => b.created - a.created);
}

async function decryptBackupToFile(filePath, outputPath) {
  await verifyBackup(filePath);
  const stat = await fsp.stat(filePath);
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
    await handle.read(header, 0, header.length, 0);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, stat.size - TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(filePath, { start: header.length, end: stat.size - TAG_LENGTH - 1 }),
      decipher,
      fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    );
  } finally {
    await handle.close();
  }
}

function restoreClientCandidates() {
  if (os.platform() === 'win32') {
    const binPath = process.env.MARIADB_BIN_PATH || 'C:\\wamp64\\bin\\mariadb\\mariadb11.5.2\\bin';
    return [path.join(binPath, 'mariadb.exe'), path.join(binPath, 'mysql.exe')];
  }
  return ['mariadb', 'mysql'];
}

async function importSql(sqlPath, database) {
  const config = getDbConfig();
  let lastError;
  for (const command of restoreClientCandidates()) {
    const child = spawn(command, [`--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`, database], {
      env: { ...process.env, MYSQL_PWD: config.password }, shell: false,
      stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    fs.createReadStream(sqlPath).pipe(child.stdin);
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code) => resolve({ code }));
    });
    if (result.code === 0) return;
    lastError = result.error || new Error(stderr.trim() || `Restore client exited with code ${result.code}.`);
    if (!result.error || result.error.code !== 'ENOENT') break;
  }
  throw lastError || new Error('MariaDB restore client not found.');
}

async function simulateRestore(filename) {
  const filePath = resolveBackupPath(filename);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Backup not found.');
  const config = getDbConfig();
  const simulationDb = `${config.database}_restore_test_${Date.now()}`;
  const sqlPath = path.join(os.tmpdir(), `tdrive-restore-${crypto.randomUUID()}.sql`);
  const conn = await db.getConnection();
  try {
    await decryptBackupToFile(filePath, sqlPath);
    await conn.query(`CREATE DATABASE \`${simulationDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await importSql(sqlPath, simulationDb);
    const [tables] = await conn.query(`SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?`, [simulationDb]);
    if (!Number(tables[0].count)) throw new Error('Restore simulation produced no tables.');
    return { database: simulationDb, tables: Number(tables[0].count) };
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${simulationDb}\``).catch(() => {});
    conn.release();
    await fsp.unlink(sqlPath).catch(() => {});
  }
}

async function restoreBackup(filename, confirmation) {
  const config = getDbConfig();
  assertRestoreAllowed(process.env.BACKUP_RESTORE_ENABLED, confirmation, config.database);
  const filePath = resolveBackupPath(filename);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Backup not found.');
  const sqlPath = path.join(os.tmpdir(), `tdrive-restore-${crypto.randomUUID()}.sql`);
  try {
    await decryptBackupToFile(filePath, sqlPath);
    await importSql(sqlPath, config.database);
    return true;
  } finally {
    await fsp.unlink(sqlPath).catch(() => {});
  }
}

function resolveBackupPath(filename) {
  if (!validBackupFilename(filename)) return null;
  return path.join(BACKUP_DIR, filename);
}

async function removeBackup(filename) {
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new Error('Nama file backup tidak valid.');
  await fsp.unlink(filePath);
}

function startScheduler(enqueueBackup) {
  if (scheduler || process.env.BACKUP_SCHEDULE_ENABLED !== 'true') return;
  if (typeof enqueueBackup !== 'function') throw new Error('Backup scheduler requires a durable enqueue callback.');
  const intervalHours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24));
  scheduler = setInterval(() => {
    enqueueBackup().catch((error) => console.error('[Backup] Gagal menjadwalkan backup:', error));
  }, intervalHours * 60 * 60 * 1000);
  scheduler.unref();
  console.info(`[Backup] Scheduler aktif setiap ${intervalHours} jam.`);
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  getDbConfig,
  listBackups,
  removeBackup,
  resolveBackupPath,
  restoreBackup,
  simulateRestore,
  startScheduler,
  verifyBackup,
};
