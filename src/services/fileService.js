'use strict';

const crypto = require('crypto');
const db = require('../db');
const { encrypt } = require('./cryptoService');

const now = () => Date.now();

// ---------- Accounts ----------

async function createAccount({ label, phone, apiId, apiHash, sessionStr, storagePeer }) {
  const { enc, iv, tag } = encrypt(sessionStr);
  const ts = now();
  const [result] = await db.query(
    `INSERT INTO accounts (label, phone, api_id, api_hash, session_enc, session_iv, session_tag, storage_peer, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      label || phone,
      phone,
      Number(apiId),
      String(apiHash),
      enc, // Buffer
      iv,  // Buffer
      tag, // Buffer
      storagePeer || 'me',
      ts,
      ts,
    ]
  );
  return getAccount(result.insertId);
}

async function getAccount(id) {
  const [rows] = await db.query('SELECT * FROM accounts WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getAccountByPhone(phone) {
  const [rows] = await db.query('SELECT * FROM accounts WHERE phone = ?', [phone]);
  return rows[0] || null;
}

async function listAccounts() {
  const [rows] = await db.query('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows;
}

async function updateAccountSession(id, sessionStr) {
  const { enc, iv, tag } = encrypt(sessionStr);
  return db.query(
    'UPDATE accounts SET session_enc = ?, session_iv = ?, session_tag = ?, updated_at = ? WHERE id = ?',
    [enc, iv, tag, now(), id]
  );
}

async function updateAccountLabel(id, label) {
  return db.query('UPDATE accounts SET label = ?, updated_at = ? WHERE id = ?', [label, now(), id]);
}

async function updateAccountStoragePeer(id, storagePeer) {
  return db.query('UPDATE accounts SET storage_peer = ?, updated_at = ? WHERE id = ?', [storagePeer, now(), id]);
}

async function updateAccountPassword(id, passwordHash) {
  return db.query('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, now(), id]);
}

async function updateAccountNotesSecurity(id, salt, verifier) {
  return db.query('UPDATE accounts SET notes_salt = ?, notes_verifier = ?, updated_at = ? WHERE id = ?', [salt, verifier, now(), id]);
}

async function deleteAccount(id) {
  return db.query('DELETE FROM accounts WHERE id = ?', [id]);
}

// ---------- Folders ----------

async function createFolder(accountId, parentId, name) {
  const u = crypto.randomUUID();
  const [result] = await db.query(
    'INSERT INTO folders (account_id, parent_id, name, uuid, created_at) VALUES (?, ?, ?, ?, ?)',
    [accountId, parentId || null, name, u, now()]
  );
  return getFolder(result.insertId);
}

async function listFolders(accountId, parentId) {
  if (parentId === null || parentId === undefined) {
    const [rows] = await db.query(
      'SELECT * FROM folders WHERE account_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY name ASC',
      [accountId]
    );
    return rows;
  } else {
    const [rows] = await db.query(
      'SELECT * FROM folders WHERE account_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY name ASC',
      [accountId, parentId]
    );
    return rows;
  }
}

async function getFolder(id) {
  const [rows] = await db.query('SELECT * FROM folders WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getFolderByUuid(uuid) {
  const [rows] = await db.query('SELECT * FROM folders WHERE uuid = ?', [uuid]);
  return rows[0] || null;
}

/** Semua folder pada satu akun (untuk dropdown "pindahkan ke" - mengecualikan yang di tempat sampah). */
async function listAllFolders(accountId) {
  const [rows] = await db.query(
    'SELECT id, uuid, parent_id, name FROM folders WHERE account_id = ? AND deleted_at IS NULL ORDER BY name ASC',
    [accountId]
  );
  return rows;
}

async function renameFolder(id, newName) {
  return db.query('UPDATE folders SET name = ? WHERE id = ?', [newName, id]);
}

async function deleteFolder(id) {
  return db.query('DELETE FROM folders WHERE id = ?', [id]);
}

// ---------- Files ----------

/**
 * Simpan metadata file + daftar chunk secara atomik (transaksi).
 * @param {object} meta { accountId, folderId, name, size, mime, sha256, isChunked }
 * @param {Array}  chunks [{ partIndex, messageId, peer, size }]
 */
async function createFileWithChunks(meta, chunks) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const ts = now();
    const u = crypto.randomUUID();
    const [fileResult] = await conn.query(
      `INSERT INTO files (account_id, folder_id, name, size, mime, sha256, is_chunked, uuid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meta.accountId,
        meta.folderId || null,
        meta.name,
        meta.size,
        meta.mime || null,
        meta.sha256 || null,
        meta.isChunked ? 1 : 0,
        u,
        ts,
        ts
      ]
    );
    const fileId = fileResult.insertId;
    for (const c of chunks) {
      await conn.query(
        'INSERT INTO file_chunks (file_id, part_index, message_id, peer, size) VALUES (?, ?, ?, ?, ?)',
        [fileId, c.partIndex, c.messageId, c.peer || 'me', c.size]
      );
    }
    await conn.commit();
    return await getFile(fileId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getFile(id) {
  const [rows] = await db.query('SELECT * FROM files WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getFileByUuid(uuid) {
  const [rows] = await db.query('SELECT * FROM files WHERE uuid = ?', [uuid]);
  return rows[0] || null;
}

async function getFileChunks(fileId) {
  const [rows] = await db.query(
    'SELECT * FROM file_chunks WHERE file_id = ? ORDER BY part_index ASC',
    [fileId]
  );
  return rows;
}

async function listFiles(accountId, folderId) {
  if (folderId === null || folderId === undefined) {
    const [rows] = await db.query(
      'SELECT * FROM files WHERE account_id = ? AND folder_id IS NULL AND deleted_at IS NULL AND parent_file_id IS NULL ORDER BY name ASC',
      [accountId]
    );
    return rows;
  } else {
    const [rows] = await db.query(
      'SELECT * FROM files WHERE account_id = ? AND folder_id = ? AND deleted_at IS NULL AND parent_file_id IS NULL ORDER BY name ASC',
      [accountId, folderId]
    );
    return rows;
  }
}

async function searchFiles(accountId, query) {
  const [rows] = await db.query(
    'SELECT * FROM files WHERE account_id = ? AND name LIKE ? AND deleted_at IS NULL AND parent_file_id IS NULL ORDER BY name ASC LIMIT 200',
    [accountId, `%${query}%`]
  );
  return rows;
}

async function renameFile(id, newName) {
  return db.query('UPDATE files SET name = ?, updated_at = ? WHERE id = ?', [newName, now(), id]);
}

async function moveFile(id, folderId) {
  return db.query('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?', [folderId || null, now(), id]);
}

async function deleteFile(id) {
  return db.query('DELETE FROM files WHERE id = ?', [id]);
}

/** Statistik agregat per akun (jumlah file & total byte) untuk dashboard. */
async function accountStats(accountId) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM files WHERE account_id = ? AND deleted_at IS NULL AND parent_file_id IS NULL',
    [accountId]
  );
  return rows[0] || { count: 0, total: 0 };
}

// ---------- Recycle Bin / Trash & Versioning ----------

async function listTrashFolders(accountId) {
  const [rows] = await db.query(
    'SELECT * FROM folders WHERE account_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    [accountId]
  );
  return rows;
}

async function listTrashFiles(accountId) {
  const [rows] = await db.query(
    'SELECT * FROM files WHERE account_id = ? AND deleted_at IS NOT NULL AND parent_file_id IS NULL ORDER BY deleted_at DESC',
    [accountId]
  );
  return rows;
}

async function softDeleteFolder(id) {
  return db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [now(), id]);
}

async function softDeleteFile(id) {
  return db.query('UPDATE files SET deleted_at = ? WHERE id = ?', [now(), id]);
}

async function restoreFolder(id) {
  return db.query('UPDATE folders SET deleted_at = NULL WHERE id = ?', [id]);
}

async function restoreFile(id) {
  return db.query('UPDATE files SET deleted_at = NULL WHERE id = ?', [id]);
}

async function getFileVersions(fileId) {
  const [rows] = await db.query(
    'SELECT * FROM files WHERE parent_file_id = ? ORDER BY created_at DESC',
    [fileId]
  );
  return rows;
}

async function findActiveFileByName(accountId, folderId, name) {
  const [rows] = await db.query(
    'SELECT * FROM files WHERE account_id = ? AND folder_id ' + (folderId ? '= ?' : 'IS NULL') + ' AND name = ? AND deleted_at IS NULL AND parent_file_id IS NULL',
    folderId ? [accountId, folderId, name] : [accountId, name]
  );
  return rows[0] || null;
}

module.exports = {
  // accounts
  createAccount,
  getAccount,
  getAccountByPhone,
  listAccounts,
  updateAccountSession,
  updateAccountLabel,
  updateAccountStoragePeer,
  updateAccountPassword,
  updateAccountNotesSecurity,
  deleteAccount,
  // folders
  createFolder,
  listFolders,
  getFolder,
  getFolderByUuid,
  listAllFolders,
  renameFolder,
  deleteFolder,
  // files
  createFileWithChunks,
  getFile,
  getFileByUuid,
  getFileChunks,
  listFiles,
  searchFiles,
  renameFile,
  moveFile,
  deleteFile,
  accountStats,
  // Recycle Bin & Versioning
  listTrashFolders,
  listTrashFiles,
  softDeleteFolder,
  softDeleteFile,
  restoreFolder,
  restoreFile,
  getFileVersions,
  findActiveFileByName,
};
