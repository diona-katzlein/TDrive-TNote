'use strict';

const db = require('../db');
const { encrypt } = require('./cryptoService');

const now = () => Date.now();

// ---------- Accounts ----------

const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (label, phone, api_id, api_hash, session_enc, session_iv, session_tag, storage_peer, status, created_at, updated_at)
  VALUES (@label, @phone, @api_id, @api_hash, @session_enc, @session_iv, @session_tag, @storage_peer, 'active', @created_at, @updated_at)
`);

function createAccount({ label, phone, apiId, apiHash, sessionStr, storagePeer }) {
  const { enc, iv, tag } = encrypt(sessionStr);
  const ts = now();
  const info = insertAccountStmt.run({
    label: label || phone,
    phone,
    api_id: Number(apiId),
    api_hash: String(apiHash),
    session_enc: enc,
    session_iv: iv,
    session_tag: tag,
    storage_peer: storagePeer || 'me',
    created_at: ts,
    updated_at: ts,
  });
  return getAccount(info.lastInsertRowid);
}

function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function getAccountByPhone(phone) {
  return db.prepare('SELECT * FROM accounts WHERE phone = ?').get(phone);
}

function listAccounts() {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
}

function updateAccountSession(id, sessionStr) {
  const { enc, iv, tag } = encrypt(sessionStr);
  return db
    .prepare(
      'UPDATE accounts SET session_enc = ?, session_iv = ?, session_tag = ?, updated_at = ? WHERE id = ?'
    )
    .run(enc, iv, tag, now(), id);
}

function updateAccountStoragePeer(id, storagePeer) {
  return db
    .prepare('UPDATE accounts SET storage_peer = ?, updated_at = ? WHERE id = ?')
    .run(storagePeer, now(), id);
}

function deleteAccount(id) {
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ---------- Folders ----------

function createFolder(accountId, parentId, name) {
  const info = db
    .prepare('INSERT INTO folders (account_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(accountId, parentId || null, name, now());
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid);
}

function listFolders(accountId, parentId) {
  return db
    .prepare(
      'SELECT * FROM folders WHERE account_id = ? AND parent_id IS ? ORDER BY name COLLATE NOCASE'
    )
    .all(accountId, parentId || null);
}

function getFolder(id) {
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

/** Semua folder pada satu akun (untuk dropdown "pindahkan ke"). */
function listAllFolders(accountId) {
  return db
    .prepare('SELECT id, parent_id, name FROM folders WHERE account_id = ? ORDER BY name COLLATE NOCASE')
    .all(accountId);
}

function renameFolder(id, newName) {
  return db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(newName, id);
}

function deleteFolder(id) {
  return db.prepare('DELETE FROM folders WHERE id = ?').run(id);
}

// ---------- Files ----------

/**
 * Simpan metadata file + daftar chunk secara atomik (transaksi).
 * @param {object} meta { accountId, folderId, name, size, mime, sha256, isChunked }
 * @param {Array}  chunks [{ partIndex, messageId, peer, size }]
 */
const insertFileTxn = db.transaction((meta, chunks) => {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO files (account_id, folder_id, name, size, mime, sha256, is_chunked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      meta.accountId,
      meta.folderId || null,
      meta.name,
      meta.size,
      meta.mime || null,
      meta.sha256 || null,
      meta.isChunked ? 1 : 0,
      ts,
      ts
    );
  const fileId = info.lastInsertRowid;
  const insChunk = db.prepare(
    'INSERT INTO file_chunks (file_id, part_index, message_id, peer, size) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of chunks) {
    insChunk.run(fileId, c.partIndex, c.messageId, c.peer || 'me', c.size);
  }
  return fileId;
});

function createFileWithChunks(meta, chunks) {
  const id = insertFileTxn(meta, chunks);
  return getFile(id);
}

function getFile(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

function getFileChunks(fileId) {
  return db
    .prepare('SELECT * FROM file_chunks WHERE file_id = ? ORDER BY part_index ASC')
    .all(fileId);
}

function listFiles(accountId, folderId) {
  return db
    .prepare(
      'SELECT * FROM files WHERE account_id = ? AND folder_id IS ? ORDER BY name COLLATE NOCASE'
    )
    .all(accountId, folderId || null);
}

function searchFiles(accountId, query) {
  return db
    .prepare(
      "SELECT * FROM files WHERE account_id = ? AND name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 200"
    )
    .all(accountId, `%${query}%`);
}

function renameFile(id, newName) {
  return db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(newName, now(), id);
}

function moveFile(id, folderId) {
  return db
    .prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?')
    .run(folderId || null, now(), id);
}

function deleteFile(id) {
  return db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

/** Statistik agregat per akun (jumlah file & total byte) untuk dashboard. */
function accountStats(accountId) {
  return db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM files WHERE account_id = ?')
    .get(accountId);
}

module.exports = {
  // accounts
  createAccount,
  getAccount,
  getAccountByPhone,
  listAccounts,
  updateAccountSession,
  updateAccountStoragePeer,
  deleteAccount,
  // folders
  createFolder,
  listFolders,
  getFolder,
  listAllFolders,
  renameFolder,
  deleteFolder,
  // files
  createFileWithChunks,
  getFile,
  getFileChunks,
  listFiles,
  searchFiles,
  renameFile,
  moveFile,
  deleteFile,
  accountStats,
};
