'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const noteService = require('../services/noteService');
const { requireActiveAccount } = require('../middleware/activeAccount');

const KINDS = new Set(['all', 'file', 'folder', 'note', 'kinerja', 'shortlink']);
const SORTS = new Set(['newest', 'oldest', 'name', 'size_desc', 'size_asc']);

router.use(requireActiveAccount);

function boundedText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function parseDate(value) {
  const text = boundedText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function parseSizeMb(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, 1024 * 1024) : null;
}

function parseFilters(source = {}) {
  const kind = boundedText(source.kind, 20);
  const sort = boundedText(source.sort, 20);
  return {
    kind: KINDS.has(kind) ? kind : 'all',
    sort: SORTS.has(sort) ? sort : 'newest',
    mime: boundedText(source.mime, 100),
    category: boundedText(source.category, 100),
    dateFrom: parseDate(source.date_from || source.dateFrom),
    dateTo: parseDate(source.date_to || source.dateTo),
    minSizeMb: parseSizeMb(source.min_size_mb != null ? source.min_size_mb : source.minSizeMb),
    maxSizeMb: parseSizeMb(source.max_size_mb != null ? source.max_size_mb : source.maxSizeMb),
  };
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function orderFor(kind, sort) {
  if (sort === 'oldest') return kind === 'kinerja' ? 'k.activity_date ASC, k.id ASC' : 'created_at ASC';
  if (sort === 'name') return kind === 'kinerja' ? 'k.title ASC' : 'name ASC';
  if (kind === 'file' && sort === 'size_desc') return 'size DESC, updated_at DESC';
  if (kind === 'file' && sort === 'size_asc') return 'size ASC, updated_at DESC';
  return kind === 'kinerja' ? 'k.activity_date DESC, k.id DESC' : 'updated_at DESC';
}

async function searchStructured(accountId, query, filters) {
  const results = [];
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const include = (kind) => filters.kind === 'all' || filters.kind === kind;
  const tasks = [];

  if (include('file')) {
    const where = ['account_id = ?', 'deleted_at IS NULL', 'parent_file_id IS NULL', "name LIKE ? ESCAPE '\\\\'"];
    const params = [accountId, like];
    if (filters.mime) { where.push('mime LIKE ?'); params.push(`${filters.mime}%`); }
    if (filters.dateFrom) { where.push('created_at >= ?'); params.push(new Date(`${filters.dateFrom}T00:00:00Z`).getTime()); }
    if (filters.dateTo) { where.push('created_at < ?'); params.push(new Date(`${filters.dateTo}T00:00:00Z`).getTime() + 86400000); }
    if (filters.minSizeMb != null) { where.push('size >= ?'); params.push(Math.round(filters.minSizeMb * 1024 * 1024)); }
    if (filters.maxSizeMb != null) { where.push('size <= ?'); params.push(Math.round(filters.maxSizeMb * 1024 * 1024)); }
    tasks.push(db.query(`SELECT uuid, name, size, mime, updated_at, 'file' AS kind FROM files WHERE ${where.join(' AND ')} ORDER BY ${orderFor('file', filters.sort)} LIMIT 50`, params)
      .then(([rows]) => rows.map((item) => ({ ...item, detail: item.mime, url: `/drive/file/${item.uuid}/download` }))));
  }

  if (include('folder')) {
    tasks.push(db.query(`SELECT uuid, name, created_at AS updated_at, 'folder' AS kind FROM folders WHERE account_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\\\' ORDER BY ${orderFor('folder', filters.sort)} LIMIT 30`, [accountId, like])
      .then(([rows]) => rows.map((item) => ({ ...item, url: `/drive/folder/${item.uuid}` }))));
  }

  if (include('kinerja')) {
    const where = ['k.account_id = ?', "(k.title LIKE ? ESCAPE '\\\\' OR k.description LIKE ? ESCAPE '\\\\')"];
    const params = [accountId, like, like];
    if (filters.dateFrom) { where.push('k.activity_date >= ?'); params.push(filters.dateFrom); }
    if (filters.dateTo) { where.push('k.activity_date <= ?'); params.push(filters.dateTo); }
    tasks.push(db.query(`SELECT k.uuid, k.title AS name, DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS activity_date, k.updated_at, 'kinerja' AS kind FROM kinerja_reports k WHERE ${where.join(' AND ')} ORDER BY ${orderFor('kinerja', filters.sort)} LIMIT 50`, params)
      .then(([rows]) => rows.map((item) => ({ ...item, detail: item.activity_date, url: `/kinerja/date/${item.activity_date}` }))));
  }

  if (include('shortlink')) {
    tasks.push(db.query(`SELECT short_code, original_url AS name, created_at AS updated_at, 'shortlink' AS kind FROM shortlinks WHERE account_id = ? AND (short_code LIKE ? ESCAPE '\\\\' OR original_url LIKE ? ESCAPE '\\\\') ORDER BY ${orderFor('shortlink', filters.sort)} LIMIT 30`, [accountId, like, like])
      .then(([rows]) => rows.map((item) => ({ ...item, url: `/s/${item.short_code}` }))));
  }

  const groups = await Promise.all(tasks);
  groups.forEach((group) => results.push(...group));
  return results;
}

router.get('/', async (req, res) => {
  const query = boundedText(req.query.q, 100);
  let filters = parseFilters(req.query);
  const results = [];
  try {
    if (req.query.saved) {
      const [savedRows] = await db.query('SELECT query_text, filters FROM saved_search_filters WHERE uuid = ? AND account_id = ? LIMIT 1', [boundedText(req.query.saved, 36), req.activeAccount.id]);
      if (savedRows.length) {
        filters = parseFilters(safeJson(savedRows[0].filters));
        if (!req.query.q) req.query.q = savedRows[0].query_text || '';
      }
    }
    const effectiveQuery = boundedText(req.query.q || query, 100);
    if (effectiveQuery.length >= 2) {
      results.push(...await searchStructured(req.activeAccount.id, effectiveQuery, filters));
      if ((filters.kind === 'all' || filters.kind === 'note') && req.session.notesPassphrase) {
        const key = Buffer.from(req.session.notesPassphrase, 'hex');
        const notes = await noteService.searchNotes(req.activeAccount.id, effectiveQuery, key);
        results.push(...notes.filter((note) => !filters.category || String(note.category || '').toLowerCase().includes(filters.category.toLowerCase())).slice(0, 30)
          .map((note) => ({ kind: 'note', name: note.title, detail: note.category, updated_at: note.updated_at, url: `/notes/${note.uuid}` })));
      }
      await db.query('INSERT INTO search_history (account_id, query_text, filters, searched_at) VALUES (?, ?, ?, ?)', [req.activeAccount.id, effectiveQuery, JSON.stringify(filters), Date.now()]);
      await db.query('DELETE FROM search_history WHERE account_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM search_history WHERE account_id = ? ORDER BY searched_at DESC LIMIT 20) recent)', [req.activeAccount.id, req.activeAccount.id]);
    }
    const [[recent], [saved]] = await Promise.all([
      db.query('SELECT query_text, filters, MAX(searched_at) AS searched_at FROM search_history WHERE account_id = ? GROUP BY query_text, filters ORDER BY searched_at DESC LIMIT 10', [req.activeAccount.id]),
      db.query('SELECT uuid, name, query_text, filters FROM saved_search_filters WHERE account_id = ? ORDER BY updated_at DESC LIMIT 30', [req.activeAccount.id]),
    ]);
    res.render('search', {
      title: 'Universal Search', query: effectiveQuery, filters, results, recent,
      saved: saved.map((item) => ({ ...item, filters: safeJson(item.filters) })),
      notesLocked: !req.session.notesPassphrase,
      csrfToken: res.locals.csrfToken,
    });
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Universal search failed`, error);
    res.status(500).send(`Pencarian gagal. ID referensi: ${req.id || 'tidak tersedia'}`);
  }
});

router.post('/saved', async (req, res) => {
  const name = boundedText(req.body.name, 80);
  const query = boundedText(req.body.q, 100);
  const filters = parseFilters(req.body);
  if (!name) return res.status(400).send('Nama filter wajib diisi.');
  try {
    const now = Date.now();
    await db.query(`INSERT INTO saved_search_filters (uuid, account_id, name, query_text, filters, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE query_text = VALUES(query_text), filters = VALUES(filters), updated_at = VALUES(updated_at)`,
    [crypto.randomUUID(), req.activeAccount.id, name, query, JSON.stringify(filters), now, now]);
    res.redirect('/search?notice=' + encodeURIComponent('Filter tersimpan.'));
  } catch (error) {
    res.status(500).send(`Gagal menyimpan filter. ID referensi: ${req.id}`);
  }
});

router.post('/saved/:uuid/delete', async (req, res) => {
  await db.query('DELETE FROM saved_search_filters WHERE uuid = ? AND account_id = ?', [boundedText(req.params.uuid, 36), req.activeAccount.id]);
  res.redirect('/search');
});

module.exports = router;
