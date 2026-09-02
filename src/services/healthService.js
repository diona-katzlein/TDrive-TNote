'use strict';

const db = require('../db');
const telegramManager = require('./telegramManager');
const notificationService = require('./notificationService');

async function dashboard(account) {
  const accountId = account.id;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [[totals], [growth], [largest], [jobs], [uploads], [channels], [backup], [reconciliation], telegram] = await Promise.all([
    db.query(`SELECT COUNT(*) AS file_count, COALESCE(SUM(size),0) AS total_bytes,
      COALESCE(SUM((SELECT COUNT(*) FROM file_chunks c WHERE c.file_id = files.id)),0) AS chunk_count
      FROM files WHERE account_id = ? AND deleted_at IS NULL`, [accountId]),
    db.query(`SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN size ELSE 0 END),0) AS daily_bytes,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN size ELSE 0 END),0) AS monthly_bytes,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS daily_files,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS monthly_files
      FROM files WHERE account_id = ?`, [dayAgo, monthAgo, dayAgo, monthAgo, accountId]),
    db.query('SELECT uuid, name, size FROM files WHERE account_id = ? AND deleted_at IS NULL ORDER BY size DESC LIMIT 10', [accountId]),
    db.query(`SELECT status, COUNT(*) AS count FROM jobs WHERE account_id = ? GROUP BY status`, [accountId]),
    db.query(`SELECT status, COUNT(*) AS count FROM upload_sessions WHERE account_id = ? GROUP BY status`, [accountId]),
    db.query('SELECT id, title, channel_id, created_at FROM user_channels WHERE account_id = ? ORDER BY created_at DESC', [accountId]),
    db.query('SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 1'),
    db.query('SELECT * FROM reconciliation_runs WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', [accountId]),
    telegramManager.health(account),
  ]);

  const quotaBytes = Math.max(0, Number(process.env.STORAGE_QUOTA_BYTES || 0));
  const used = Number(totals[0].total_bytes || 0);
  const quotaPercent = quotaBytes ? Math.round((used / quotaBytes) * 10000) / 100 : null;
  return {
    totals: { ...totals[0], total_bytes: used, quota_bytes: quotaBytes, quota_percent: quotaPercent },
    growth: growth[0], largest, jobs, uploads, channels,
    backup: backup[0] || null,
    reconciliation: reconciliation[0] || null,
    telegram,
  };
}

async function createAlertOnce(accountId, type, values) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const [rows] = await db.query(
    'SELECT id FROM notifications WHERE account_id = ? AND type = ? AND created_at >= ? LIMIT 1',
    [accountId, type, cutoff]
  );
  if (!rows.length) await notificationService.create({ accountId, type, ...values });
}

async function notifyProblems(account, data) {
  if (data.telegram.status === 'session_invalid' || data.telegram.status === 'reauth_required') {
    await createAlertOnce(account.id, 'telegram_health', { severity: 'error', title: 'Session Telegram perlu login ulang', message: 'Pemeriksaan kesehatan mendeteksi session Telegram expired atau revoked.', link: '/accounts' });
  }
  if (data.totals.quota_percent != null && data.totals.quota_percent >= Number(process.env.STORAGE_QUOTA_WARN_PERCENT || 85)) {
    await createAlertOnce(account.id, 'storage_quota', { severity: 'warning', title: 'Storage quota hampir penuh', message: `Pemakaian mencapai ${data.totals.quota_percent}% dari soft quota.`, link: '/health' });
  }
}

module.exports = { dashboard, notifyProblems };
