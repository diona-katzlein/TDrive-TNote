'use strict';

const crypto = require('crypto');
const os = require('os');

const db = require('../db');
const notificationService = require('./notificationService');

const handlers = new Map();
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const pollMs = Math.max(500, Number(process.env.JOB_POLL_MS || 2000));
const leaseMs = Math.max(30000, Number(process.env.JOB_LEASE_MS || 15 * 60 * 1000));
let timer = null;
let stopping = false;
let processing = false;

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function register(type, handler) {
  if (!type || typeof handler !== 'function') throw new Error('Invalid job handler registration.');
  handlers.set(type, handler);
}

async function enqueue(type, payload, options = {}) {
  if (!handlers.has(type) && options.allowUnregistered !== true) throw new Error(`No handler registered for job type ${type}.`);
  const now = Date.now();
  const uuid = crypto.randomUUID();
  await db.query(
    `INSERT INTO jobs
      (uuid, account_id, type, payload, status, progress, attempts, max_attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?)`,
    [uuid, options.accountId || null, type, JSON.stringify(payload || {}), Math.max(1, Number(options.maxAttempts || 5)), options.availableAt || now, now, now]
  );
  return uuid;
}

async function recoverStaleJobs() {
  const cutoff = Date.now() - leaseMs;
  await db.query(
    `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
       available_at = ?, updated_at = ?, last_error = 'Worker lease expired; job recovered.'
     WHERE status = 'running' AND locked_at < ?`,
    [Date.now(), Date.now(), cutoff]
  );
}

async function claim() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND available_at <= ?
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [Date.now()]
    );
    if (!rows.length) {
      await conn.commit();
      return null;
    }
    const job = rows[0];
    await conn.query(
      `UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?,
       attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      [Date.now(), workerId, Date.now(), job.id]
    );
    await conn.commit();
    return { ...job, attempts: Number(job.attempts) + 1, payload: safeJson(job.payload) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function updateProgress(jobId, progress, result = null) {
  await db.query(
    `UPDATE jobs SET progress = ?, result = COALESCE(?, result), updated_at = ?
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [Math.max(0, Math.min(100, Number(progress))), result == null ? null : JSON.stringify(result), Date.now(), jobId, workerId]
  );
}

async function succeed(job, result) {
  await db.query(
    `UPDATE jobs SET status = 'completed', progress = 100, result = ?, last_error = NULL,
       locked_at = NULL, locked_by = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(result || {}), Date.now(), Date.now(), job.id]
  );
  if (job.account_id) {
    await notificationService.create({
      accountId: job.account_id,
      type: 'job_completed',
      severity: 'success',
      title: `Pekerjaan ${job.type} selesai`,
      message: `Job ${job.uuid} berhasil diproses.`,
      link: '/jobs',
    }).catch(() => {});
  }
}

async function fail(job, error) {
  const terminal = job.attempts >= Number(job.max_attempts);
  const delay = Math.min(60 * 60 * 1000, 5000 * (2 ** Math.max(0, job.attempts - 1)));
  await db.query(
    `UPDATE jobs SET status = ?, last_error = ?, available_at = ?, locked_at = NULL,
       locked_by = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
    [terminal ? 'dead' : 'pending', String(error.message || error).slice(0, 500), Date.now() + delay, Date.now(), terminal ? Date.now() : null, job.id]
  );
  if (terminal && job.account_id) {
    await notificationService.create({
      accountId: job.account_id,
      type: 'job_failed',
      severity: 'error',
      title: `Pekerjaan ${job.type} gagal permanen`,
      message: `Job ${job.uuid} masuk dead-letter queue setelah ${job.attempts} percobaan.`,
      link: '/jobs',
    }).catch(() => {});
  }
}

async function processOne() {
  if (processing || stopping) return false;
  processing = true;
  try {
    const job = await claim();
    if (!job) return false;
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`No handler registered for ${job.type}.`);
    const context = {
      job,
      progress: (value, result) => updateProgress(job.id, value, result),
    };
    try {
      const result = await handler(job.payload, context);
      await succeed(job, result);
    } catch (error) {
      await fail(job, error);
    }
    return true;
  } finally {
    processing = false;
  }
}

async function tick() {
  try {
    let handled = true;
    while (handled && !stopping) handled = await processOne();
  } catch (error) {
    console.error('[Jobs] Worker tick failed:', error);
  }
}

async function start() {
  if (timer || process.env.JOB_WORKER_ENABLED === 'false') return;
  stopping = false;
  await recoverStaleJobs();
  timer = setInterval(tick, pollMs);
  timer.unref();
  tick();
  console.info(`[Jobs] Worker ${workerId} started.`);
}

function stop() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
}

async function list(accountId, limit = 100) {
  const [rows] = await db.query(
    'SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
    [accountId, Math.max(1, Math.min(Number(limit), 200))]
  );
  return rows.map((row) => ({ ...row, payload: safeJson(row.payload), result: safeJson(row.result, null) }));
}

async function retry(uuid, accountId) {
  const [result] = await db.query(
    `UPDATE jobs SET status = 'pending', attempts = 0, progress = 0, last_error = NULL,
       available_at = ?, completed_at = NULL, updated_at = ?
     WHERE uuid = ? AND account_id = ? AND status IN ('failed', 'dead')`,
    [Date.now(), Date.now(), uuid, accountId]
  );
  return result.affectedRows === 1;
}

module.exports = { enqueue, list, processOne, recoverStaleJobs, register, retry, start, stop };
