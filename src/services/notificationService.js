'use strict';

const db = require('../db');

async function create({ accountId = null, userPhone = null, type, severity = 'info', title, message, link = null }) {
  await db.query(
    `INSERT INTO notifications (account_id, user_phone, type, severity, title, message, link, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [accountId, userPhone, type, severity, String(title).slice(0, 255), String(message), link, Date.now()]
  );
}

async function list(accountId, userPhone, limit = 50) {
  const [rows] = await db.query(
    `SELECT * FROM notifications
     WHERE account_id = ? OR (account_id IS NULL AND user_phone = ?)
     ORDER BY created_at DESC LIMIT ?`,
    [accountId, userPhone, Math.max(1, Math.min(Number(limit), 100))]
  );
  return rows;
}

async function unreadCount(accountId, userPhone) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count FROM notifications
     WHERE read_at IS NULL AND (account_id = ? OR (account_id IS NULL AND user_phone = ?))`,
    [accountId, userPhone]
  );
  return Number(rows[0].count);
}

async function markRead(id, accountId, userPhone) {
  await db.query(
    `UPDATE notifications SET read_at = ?
     WHERE id = ? AND (account_id = ? OR (account_id IS NULL AND user_phone = ?))`,
    [Date.now(), id, accountId, userPhone]
  );
}

async function markAllRead(accountId, userPhone) {
  await db.query(
    `UPDATE notifications SET read_at = ?
     WHERE read_at IS NULL AND (account_id = ? OR (account_id IS NULL AND user_phone = ?))`,
    [Date.now(), accountId, userPhone]
  );
}

module.exports = { create, list, markAllRead, markRead, unreadCount };
