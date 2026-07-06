'use strict';

const crypto = require('crypto');
const db = require('../db');
const noteCrypto = require('./noteCryptoService');

const now = () => Date.now();

/**
 * noteService — CRUD catatan (TNote) di MariaDB dengan enkripsi E2E.
 * Isi catatan disimpan terenkripsi di DB dan disinkronkan ke Telegram (terenkripsi).
 */

/**
 * Membuat catatan baru terenkripsi.
 */
async function createNote(accountId, { title, body, category }, encryptionKey) {
  const ts = now();
  const u = crypto.randomUUID();
  
  // Enkripsi kolom data menggunakan kunci E2E
  const encTitle = noteCrypto.encrypt(title || 'Tanpa Judul', encryptionKey);
  const encBody = noteCrypto.encrypt(body || '', encryptionKey);
  const encCategory = noteCrypto.encrypt(category || 'General', encryptionKey);

  const [result] = await db.query(
    'INSERT INTO notes (account_id, title, body, category, uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [accountId, encTitle, encBody, encCategory, u, ts, ts]
  );
  return getNote(result.insertId, encryptionKey);
}

/**
 * Mendapatkan satu catatan dan mendekripsinya.
 */
async function getNote(id, encryptionKey) {
  const [rows] = await db.query('SELECT * FROM notes WHERE id = ?', [id]);
  const note = rows[0];
  if (!note) return null;

  try {
    note.title = noteCrypto.decrypt(note.title, encryptionKey);
    note.body = noteCrypto.decrypt(note.body, encryptionKey);
    note.category = noteCrypto.decrypt(note.category, encryptionKey);
  } catch (err) {
    note.title = '[Gagal Mendekripsi Judul]';
    note.body = '[Gagal mendekripsi isi catatan. Sandi enkripsi mungkin salah atau berubah.]';
    note.category = 'General';
    note.decryptionError = true;
  }
  return note;
}

/**
 * Mendapatkan satu catatan berdasarkan UUID dan mendekripsinya.
 */
async function getNoteByUuid(uuid, encryptionKey) {
  const [rows] = await db.query('SELECT * FROM notes WHERE uuid = ?', [uuid]);
  const note = rows[0];
  if (!note) return null;

  try {
    note.title = noteCrypto.decrypt(note.title, encryptionKey);
    note.body = noteCrypto.decrypt(note.body, encryptionKey);
    note.category = noteCrypto.decrypt(note.category, encryptionKey);
  } catch (err) {
    note.title = '[Gagal Mendekripsi Judul]';
    note.body = '[Gagal mendekripsi isi catatan. Sandi enkripsi mungkin salah atau berubah.]';
    note.category = 'General';
    note.decryptionError = true;
  }
  return note;
}

/**
 * Mendapatkan daftar semua catatan dan mendekripsinya.
 */
async function listNotes(accountId, encryptionKey) {
  const [rows] = await db.query(
    'SELECT * FROM notes WHERE account_id = ? ORDER BY updated_at DESC',
    [accountId]
  );

  const decryptedNotes = [];
  for (const note of rows) {
    try {
      note.title = noteCrypto.decrypt(note.title, encryptionKey);
      note.body = noteCrypto.decrypt(note.body, encryptionKey);
      note.category = noteCrypto.decrypt(note.category, encryptionKey);
    } catch (err) {
      note.title = '[Gagal Mendekripsi]';
      note.body = '[Gagal mendekripsi isi]';
      note.category = 'General';
      note.decryptionError = true;
    }
    decryptedNotes.push(note);
  }
  return decryptedNotes;
}

/**
 * Mencari catatan secara lokal (in-memory) dari catatan terdekripsi.
 */
async function searchNotes(accountId, query, encryptionKey) {
  const notes = await listNotes(accountId, encryptionKey);
  const q = String(query).toLowerCase().trim();
  if (!q) return notes;

  return notes.filter((n) => {
    return (
      (n.title && n.title.toLowerCase().includes(q)) ||
      (n.body && n.body.toLowerCase().includes(q)) ||
      (n.category && n.category.toLowerCase().includes(q))
    );
  });
}

/**
 * Memperbarui catatan terenkripsi.
 */
async function updateNote(id, { title, body, category }, encryptionKey) {
  const encTitle = noteCrypto.encrypt(title || 'Tanpa Judul', encryptionKey);
  const encBody = noteCrypto.encrypt(body || '', encryptionKey);
  const encCategory = noteCrypto.encrypt(category || 'General', encryptionKey);

  return db.query(
    'UPDATE notes SET title = ?, body = ?, category = ?, updated_at = ? WHERE id = ?',
    [encTitle, encBody, encCategory, now(), id]
  );
}

/**
 * Tandai catatan sudah tersinkron ke Telegram (simpan message_id + peer).
 */
async function setNoteSync(id, messageId, peer) {
  return db.query(
    'UPDATE notes SET message_id = ?, peer = ?, synced = 1 WHERE id = ?',
    [messageId != null ? Number(messageId) : null, peer || 'me', id]
  );
}

/**
 * Tandai catatan belum tersinkron (mis. sync gagal).
 */
async function markUnsynced(id) {
  return db.query('UPDATE notes SET synced = 0 WHERE id = ?', [id]);
}

async function deleteNote(id) {
  return db.query('DELETE FROM notes WHERE id = ?', [id]);
}

async function noteStats(accountId) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS count FROM notes WHERE account_id = ?',
    [accountId]
  );
  return rows[0] || { count: 0 };
}

module.exports = {
  createNote,
  getNote,
  getNoteByUuid,
  listNotes,
  searchNotes,
  updateNote,
  setNoteSync,
  markUnsynced,
  deleteNote,
  noteStats,
};
