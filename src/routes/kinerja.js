'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const db = require('../db');
const fileService = require('../services/fileService');
const storageService = require('../services/storageService');
const auditService = require('../services/auditService');
const { requireActiveAccount } = require('../middleware/activeAccount');

const router = express.Router();
const TMP_DIR = path.join(process.cwd(), 'data', 'tmp', 'kinerja');
const MAX_IMAGE_MB = Number(process.env.TKINERJA_MAX_IMAGE_MB) || 20;
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      cb(null, TMP_DIR);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    },
  }),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Bukti dukung hanya boleh berupa gambar.'));
    }
    cb(null, true);
  },
});

router.use(requireActiveAccount);

function parseEvidenceUpload(req, res, next) {
  upload.single('evidence')(req, res, (err) => {
    if (!err) return next();
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Ukuran bukti gambar melebihi batas ${MAX_IMAGE_MB} MB.`
      : (err.message || 'Gagal memproses bukti gambar.');
    const target = req.params && req.params.uuid ? `/kinerja/${req.params.uuid}/edit` : '/kinerja/new';
    return redirectWith(res, target, 'error', message);
  });
}

function redirectWith(res, target, type, message) {
  const separator = target.includes('?') ? '&' : '?';
  return res.redirect(`${target}${separator}${type}=${encodeURIComponent(message)}`);
}

function validateInput(body) {
  const title = String(body.title || '').trim();
  const activityDate = String(body.activity_date || '').trim();
  const startTime = String(body.start_time || '').trim();
  const endTime = String(body.end_time || '').trim();
  const description = String(body.description || '').trim();

  if (!title) throw new Error('Judul kegiatan wajib diisi.');
  if (title.length > 255) throw new Error('Judul kegiatan maksimal 255 karakter.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate)) throw new Error('Tanggal kegiatan tidak valid.');
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) throw new Error('Jam mulai dan selesai wajib diisi.');
  if (endTime <= startTime) throw new Error('Jam selesai harus lebih akhir dari jam mulai.');
  return { title, activityDate, startTime, endTime, description };
}

async function findOrCreateFolder(accountId, parentId, name) {
  const params = parentId == null ? [accountId, name] : [accountId, parentId, name];
  const sql = parentId == null
    ? 'SELECT * FROM folders WHERE account_id = ? AND parent_id IS NULL AND name = ? AND deleted_at IS NULL LIMIT 1'
    : 'SELECT * FROM folders WHERE account_id = ? AND parent_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1';
  const [rows] = await db.query(sql, params);
  return rows[0] || fileService.createFolder(accountId, parentId, name);
}

async function ensureDateFolder(accountId, activityDate) {
  const [year, month, day] = activityDate.split('-');
  const monthFolder = await findOrCreateFolder(accountId, null, `Kinerja-${MONTHS[Number(month) - 1]}`);
  return findOrCreateFolder(accountId, monthFolder.id, `${day}-${month}-${year}`);
}

async function getOwnedReport(uuid, accountId) {
  const [rows] = await db.query(
    `SELECT k.*, DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS activity_date,
            f.uuid AS evidence_uuid, f.name AS evidence_name, f.mime AS evidence_mime
     FROM kinerja_reports k
     LEFT JOIN files f ON f.id = k.evidence_file_id
     WHERE k.uuid = ? AND k.account_id = ?`,
    [uuid, accountId]
  );
  return rows[0] || null;
}

async function uploadEvidence(req, folderId) {
  if (!req.file) return null;
  return storageService.uploadFile(req.activeAccount, {
    tempPath: req.file.path,
    filename: `Bukti-${Date.now()}-${req.file.originalname}`,
    mime: req.file.mimetype,
    size: req.file.size,
    folderId,
    storagePeer: req.body.storage_peer || null,
  });
}

function renderKinerja(res, req, data) {
  return res.render('kinerja/list', {
    title: data.title,
    viewMode: data.viewMode,
    months: data.months || [],
    dates: data.dates || [],
    reports: data.reports || [],
    selectedMonth: data.selectedMonth || null,
    selectedDate: data.selectedDate || null,
    notice: req.query.notice || null,
    error: req.query.error || null,
    createdPassword: req.query.created_pass || null,
    createdShareUuid: req.query.created_share_uuid || null,
    domain: `${req.protocol}://${req.get('host')}`,
    csrfToken: res.locals.csrfToken,
  });
}

router.get('/', async (req, res) => {
  try {
    const [months] = await db.query(
      `SELECT DATE_FORMAT(activity_date, '%Y-%m') AS month_key,
              YEAR(activity_date) AS year_number, MONTH(activity_date) AS month_number,
              COUNT(*) AS report_count, COUNT(DISTINCT activity_date) AS date_count
       FROM kinerja_reports WHERE account_id = ?
       GROUP BY YEAR(activity_date), MONTH(activity_date)
       ORDER BY YEAR(activity_date) DESC, MONTH(activity_date) DESC`,
      [req.activeAccount.id]
    );
    months.forEach((month) => { month.folder_name = `Kinerja-${MONTHS[Number(month.month_number) - 1]}`; });
    return renderKinerja(res, req, { title: 'TKinerja · Bulan', viewMode: 'months', months });
  } catch (err) {
    return res.status(500).send('Gagal memuat TKinerja: ' + err.message);
  }
});

router.get('/month/:year/:month', async (req, res) => {
  const year = String(req.params.year);
  const month = String(req.params.month).padStart(2, '0');
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return res.status(400).send('Bulan tidak valid.');
  try {
    const [dates] = await db.query(
      `SELECT DATE_FORMAT(activity_date, '%Y-%m-%d') AS date_key, COUNT(*) AS report_count,
              SUM(evidence_file_id IS NOT NULL) AS evidence_count
       FROM kinerja_reports
       WHERE account_id = ? AND YEAR(activity_date) = ? AND MONTH(activity_date) = ?
       GROUP BY activity_date ORDER BY activity_date DESC`,
      [req.activeAccount.id, Number(year), Number(month)]
    );
    const selectedMonth = { year, month, folder_name: `Kinerja-${MONTHS[Number(month) - 1]}` };
    return renderKinerja(res, req, { title: `${selectedMonth.folder_name} ${year}`, viewMode: 'dates', dates, selectedMonth });
  } catch (err) {
    return res.status(500).send('Gagal memuat tanggal TKinerja: ' + err.message);
  }
});

router.get('/date/:date', async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date)) return res.status(400).send('Tanggal tidak valid.');
  try {
    const [reports] = await db.query(
      `SELECT k.*, DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS activity_date,
              f.uuid AS evidence_uuid, f.name AS evidence_name,
              s.uuid AS share_uuid, sl.short_code
       FROM kinerja_reports k
       LEFT JOIN files f ON f.id = k.evidence_file_id
       LEFT JOIN shares s ON s.item_type = 'kinerja' AND s.item_id = k.id
       LEFT JOIN shortlinks sl ON sl.account_id = k.account_id AND sl.original_url LIKE CONCAT('%/share/', s.uuid, '%')
       WHERE k.account_id = ? AND k.activity_date = ?
       ORDER BY k.start_time DESC`,
      [req.activeAccount.id, date]
    );
    const [year, month, day] = date.split('-');
    return renderKinerja(res, req, {
      title: `TKinerja · ${day}-${month}-${year}`,
      viewMode: 'reports', reports,
      selectedDate: { key: date, label: `${day}-${month}-${year}` },
      selectedMonth: { year, month, folder_name: `Kinerja-${MONTHS[Number(month) - 1]}` },
    });
  } catch (err) {
    return res.status(500).send('Gagal memuat laporan TKinerja: ' + err.message);
  }
});

router.get('/new', (req, res) => res.render('kinerja/form', {
  title: 'Buat Laporan TKinerja', report: null, error: req.query.error || null,
  maxImageMb: MAX_IMAGE_MB, csrfToken: res.locals.csrfToken,
}));

router.post('/', parseEvidenceUpload, async (req, res) => {
  try {
    const input = validateInput(req.body);
    const folder = await ensureDateFolder(req.activeAccount.id, input.activityDate);
    const evidence = await uploadEvidence(req, folder.id);
    const uuid = crypto.randomUUID();
    const now = Date.now();
    await db.query(
      `INSERT INTO kinerja_reports
       (uuid, account_id, folder_id, evidence_file_id, activity_date, title, start_time, end_time, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, req.activeAccount.id, folder.id, evidence ? evidence.id : null, input.activityDate,
        input.title, input.startTime, input.endTime, input.description || null, now, now]
    );
    await auditService.log(req, 'CREATE_KINERJA', `Membuat laporan TKinerja "${input.title}" (${uuid})`).catch((auditErr) => {
      console.error('[TKinerja] Laporan tersimpan, tetapi audit log gagal:', auditErr.message);
    });
    return redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil dibuat dan dirapikan ke folder tanggal.');
  } catch (err) {
    console.error('[TKinerja] Gagal membuat laporan:', err);
    return redirectWith(res, '/kinerja/new', 'error', err.message || 'Laporan gagal disimpan.');
  } finally {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

router.get('/:uuid/edit', async (req, res) => {
  const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
  if (!report) return res.status(404).send('Laporan tidak ditemukan.');
  res.render('kinerja/form', {
    title: 'Edit Laporan TKinerja', report, error: req.query.error || null,
    maxImageMb: MAX_IMAGE_MB, csrfToken: res.locals.csrfToken,
  });
});

router.post('/:uuid', parseEvidenceUpload, async (req, res) => {
  let report;
  try {
    report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    if (!report) throw new Error('Laporan tidak ditemukan.');
    const input = validateInput(req.body);
    const folder = await ensureDateFolder(req.activeAccount.id, input.activityDate);
    const evidence = await uploadEvidence(req, folder.id);
    let evidenceId = report.evidence_file_id;
    if (evidence) evidenceId = evidence.id;
    if (req.body.remove_evidence === '1') evidenceId = null;

    await db.query(
      `UPDATE kinerja_reports SET folder_id = ?, evidence_file_id = ?, activity_date = ?, title = ?,
       start_time = ?, end_time = ?, description = ?, updated_at = ? WHERE id = ?`,
      [folder.id, evidenceId, input.activityDate, input.title, input.startTime, input.endTime,
        input.description || null, Date.now(), report.id]
    );
    if (report.evidence_file_id && report.evidence_file_id !== evidenceId) {
      const oldFile = await fileService.getFile(report.evidence_file_id);
      if (oldFile) {
        await storageService.deleteRemote(req.activeAccount, oldFile).catch(() => {});
        await fileService.deleteFile(oldFile.id);
      }
    }
    await auditService.log(req, 'UPDATE_KINERJA', `Memperbarui laporan TKinerja "${input.title}" (${report.uuid})`).catch((auditErr) => {
      console.error('[TKinerja] Laporan diperbarui, tetapi audit log gagal:', auditErr.message);
    });
    return redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil diperbarui.');
  } catch (err) {
    console.error('[TKinerja] Gagal memperbarui laporan:', err);
    return redirectWith(res, `/kinerja/${req.params.uuid}/edit`, 'error', err.message || 'Laporan gagal diperbarui.');
  } finally {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

router.get('/:uuid/evidence', async (req, res) => {
  try {
    const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    if (!report || !report.evidence_file_id) return res.status(404).send('Bukti tidak ditemukan.');
    const file = await fileService.getFile(report.evidence_file_id);
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    await storageService.downloadToStream(req.activeAccount, file, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Gagal memuat bukti: ' + err.message);
  }
});

router.post('/:uuid/delete', async (req, res) => {
  try {
    const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    if (!report) throw new Error('Laporan tidak ditemukan.');
    const [shares] = await db.query("SELECT uuid FROM shares WHERE item_type = 'kinerja' AND item_id = ?", [report.id]);
    for (const share of shares) await db.query('DELETE FROM shortlinks WHERE original_url LIKE ?', [`%/share/${share.uuid}%`]);
    await db.query("DELETE FROM shares WHERE item_type = 'kinerja' AND item_id = ?", [report.id]);
    await db.query('DELETE FROM kinerja_reports WHERE id = ?', [report.id]);
    if (report.evidence_file_id) {
      const file = await fileService.getFile(report.evidence_file_id);
      if (file) {
        await storageService.deleteRemote(req.activeAccount, file).catch(() => {});
        await fileService.deleteFile(file.id);
      }
    }
    await auditService.log(req, 'DELETE_KINERJA', `Menghapus laporan TKinerja "${report.title}" (${report.uuid})`);
    redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil dihapus.');
  } catch (err) {
    redirectWith(res, '/kinerja', 'error', err.message);
  }
});

module.exports = router;
