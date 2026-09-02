'use strict';

const crypto = require('crypto');
const db = require('../db');

function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId)).digest('hex');
}

function describeDevice(userAgent) {
  const ua = String(userAgent || '').slice(0, 500);
  let platform = 'Perangkat tidak dikenal';
  if (/iPhone/i.test(ua)) platform = 'iPhone';
  else if (/iPad/i.test(ua)) platform = 'iPad';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let browser = 'Browser tidak dikenal';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return `${browser} · ${platform}`;
}

async function register(req, accountId) {
  const now = Date.now();
  const sessionHash = hashSessionId(req.sessionID);
  const userAgent = String(req.get('user-agent') || '').slice(0, 500);
  await db.query(
    `INSERT INTO user_sessions
       (session_hash, account_id, user_phone, device_name, user_agent, ip_address, created_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       account_id = VALUES(account_id), user_phone = VALUES(user_phone),
       device_name = VALUES(device_name), user_agent = VALUES(user_agent),
       ip_address = VALUES(ip_address), last_seen_at = VALUES(last_seen_at), revoked_at = NULL`,
    [sessionHash, accountId, req.session.userPhone, describeDevice(userAgent), userAgent, req.ip, now, now]
  );
  req.session.sessionRegistryHash = sessionHash;
  return sessionHash;
}

async function rotateAndAuthenticate(req, login) {
  const preserved = {
    activeAccountId: login.accountId,
    authenticated: true,
    userPhone: login.phone,
  };
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => err ? reject(err) : resolve());
  });
  Object.assign(req.session, preserved);
  await register(req, login.accountId);
  await new Promise((resolve, reject) => {
    req.session.save((err) => err ? reject(err) : resolve());
  });
}

async function ensureActive(req, res, next) {
  if (!req.session || !req.session.authenticated) return next();
  try {
    const sessionHash = req.session.sessionRegistryHash || hashSessionId(req.sessionID);
    const [rows] = await db.query(
      'SELECT revoked_at FROM user_sessions WHERE session_hash = ? AND account_id = ? LIMIT 1',
      [sessionHash, req.session.activeAccountId]
    );
    if (!rows.length) {
      await register(req, req.session.activeAccountId);
    } else if (rows[0].revoked_at) {
      return req.session.destroy(() => res.redirect('/login?error=' + encodeURIComponent('Sesi ini telah dicabut. Silakan masuk kembali.')));
    } else {
      const lastTouch = Number(req.session.registryLastTouch || 0);
      if (Date.now() - lastTouch > 5 * 60 * 1000) {
        req.session.registryLastTouch = Date.now();
        await db.query(
          'UPDATE user_sessions SET last_seen_at = ?, ip_address = ? WHERE session_hash = ?',
          [Date.now(), req.ip, sessionHash]
        );
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function listForAccount(accountId, currentSessionId) {
  const currentHash = hashSessionId(currentSessionId);
  const [rows] = await db.query(
    `SELECT id, device_name, ip_address, created_at, last_seen_at, revoked_at, session_hash
     FROM user_sessions WHERE account_id = ? ORDER BY revoked_at IS NULL DESC, last_seen_at DESC LIMIT 100`,
    [accountId]
  );
  return rows.map((row) => ({ ...row, is_current: row.session_hash === currentHash, session_hash: undefined }));
}

async function revoke(accountId, id, currentSessionId) {
  const currentHash = hashSessionId(currentSessionId);
  const [result] = await db.query(
    'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND session_hash <> ? AND revoked_at IS NULL',
    [Date.now(), id, accountId, currentHash]
  );
  return result.affectedRows === 1;
}

async function revokeAll(accountId, currentSessionId, includeCurrent = false) {
  const params = [Date.now(), accountId];
  let sql = 'UPDATE user_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL';
  if (!includeCurrent) {
    sql += ' AND session_hash <> ?';
    params.push(hashSessionId(currentSessionId));
  }
  const [result] = await db.query(sql, params);
  return result.affectedRows;
}

async function revokeCurrent(req) {
  if (!req.sessionID) return;
  await db.query(
    'UPDATE user_sessions SET revoked_at = ? WHERE session_hash = ?',
    [Date.now(), hashSessionId(req.sessionID)]
  );
}

module.exports = {
  describeDevice,
  ensureActive,
  hashSessionId,
  listForAccount,
  register,
  revoke,
  revokeAll,
  revokeCurrent,
  rotateAndAuthenticate,
};
