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
const { csvCell, validMonth } = require('../services/phase2Validation');
const { requireActiveAccount } = require('../middleware/activeAccount');

const router = express.Router();
const TMP_DIR = path.join(process.cwd(), 'data', 'tmp', 'kinerja');
const MAX_IMAGE_MB = Number(process.env.TKINERJA_MAX_FILE_MB) || Number(process.env.TKINERJA_MAX_IMAGE_MB) || 20;
const DOCUMENT_MIMES = {
  '.pdf': 'application/pdf',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MAX_EVIDENCE_FILES = Number(process.env.TKINERJA_MAX_EVIDENCE_FILES) || 20;

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
    const documentMime = DOCUMENT_MIMES[path.extname(file.originalname).toLowerCase()];
    if (documentMime) {
      // Browsers may send generic MIME types for Office files; store a canonical type.
      file.mimetype = documentMime;
    } else if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Bukti dukung harus berupa gambar, PDF, Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx), atau Word (.doc, .docx).'));
    }
    cb(null, true);
  },
});

router.use(requireActiveAccount);

function parseEvidenceUpload(req, res, next) {
  upload.array('evidence', MAX_EVIDENCE_FILES)(req, res, (err) => {
    if (!err) return next();
    for (const file of req.files || []) fs.promises.unlink(file.path).catch(() => {});
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Salah satu bukti melebihi batas ${MAX_IMAGE_MB} MB.`
      : (err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Maksimum ${MAX_EVIDENCE_FILES} berkas bukti per laporan.`
        : (err.message || 'Gagal memproses berkas bukti.'));
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
    `SELECT k.*, DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS activity_date
     FROM kinerja_reports k WHERE k.uuid = ? AND k.account_id = ?`,
    [uuid, accountId]
  );
  const report = rows[0] || null;
  if (!report) return null;
  const [evidence] = await db.query(
    `SELECT ke.id AS evidence_id, f.id AS file_id, f.uuid, f.name, f.mime
     FROM kinerja_evidence ke INNER JOIN files f ON f.id = ke.file_id
     WHERE ke.report_id = ? ORDER BY ke.sort_order, ke.id`,
    [report.id]
  );
  report.evidence = evidence;
  report.evidence_file_id = evidence[0] ? evidence[0].file_id : null;
  return report;
}

async function monthlyRecap(accountId, year, month) {
  const [reports] = await db.query(
    `SELECT DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS activity_date,
            k.title, k.start_time, k.end_time, k.description,
            TIMESTAMPDIFF(MINUTE, CONCAT(k.activity_date, ' ', k.start_time), CONCAT(k.activity_date, ' ', k.end_time)) AS duration_minutes,
            COUNT(ke.id) AS evidence_count
     FROM kinerja_reports k
     LEFT JOIN kinerja_evidence ke ON ke.report_id = k.id
     WHERE k.account_id = ? AND YEAR(k.activity_date) = ? AND MONTH(k.activity_date) = ?
     GROUP BY k.id ORDER BY k.activity_date, k.start_time`,
    [accountId, Number(year), Number(month)]
  );
  return {
    reports,
    totalMinutes: reports.reduce((sum, report) => sum + Number(report.duration_minutes || 0), 0),
    totalEvidence: reports.reduce((sum, report) => sum + Number(report.evidence_count || 0), 0),
  };
}

async function uploadEvidenceFiles(req, folderId) {
  const uploaded = [];
  try {
    for (let index = 0; index < (req.files || []).length; index++) {
      const source = req.files[index];
      const file = await storageService.uploadFile(req.activeAccount, {
        tempPath: source.path,
        filename: `Bukti-${Date.now()}-${index + 1}-${source.originalname}`,
        mime: source.mimetype,
        size: source.size,
        folderId,
        storagePeer: req.body.storage_peer || null,
      });
      uploaded.push(file);
    }
    return uploaded;
  } catch (err) {
    for (const file of uploaded) {
      await storageService.deleteRemote(req.activeAccount, file).catch(() => {});
      await fileService.deleteFile(file.id).catch(() => {});
    }
    throw err;
  }
}

async function deleteEvidenceFile(account, fileId) {
  const file = await fileService.getFile(fileId);
  if (!file) return;
  await storageService.deleteRemote(account, file).catch(() => {});
  await fileService.deleteFile(file.id);
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
    recap: data.recap || null,
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

router.get('/export/:year/:month.csv', async (req, res) => {
  const year = String(req.params.year);
  const month = String(req.params.month).padStart(2, '0');
  if (!validMonth(year, month)) return res.status(400).send('Bulan tidak valid.');
  try {
    const recap = await monthlyRecap(req.activeAccount.id, year, month);
    const rows = [
      ['Tanggal', 'Kegiatan', 'Mulai', 'Selesai', 'Durasi (menit)', 'Jumlah bukti', 'Deskripsi'],
      ...recap.reports.map((report) => [report.activity_date, report.title, String(report.start_time).slice(0, 5), String(report.end_time).slice(0, 5), report.duration_minutes, report.evidence_count, report.description]),
      ['', 'TOTAL', '', '', recap.totalMinutes, recap.totalEvidence, ''],
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tkinerja-${year}-${month}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Export TKinerja gagal`, error);
    return res.status(500).send('Export TKinerja gagal.');
  }
});

router.get('/export/:year/:month/print', async (req, res) => {
  const year = String(req.params.year);
  const month = String(req.params.month).padStart(2, '0');
  if (!validMonth(year, month)) return res.status(400).send('Bulan tidak valid.');
  try {
    const recap = await monthlyRecap(req.activeAccount.id, year, month);
    return res.render('kinerja/monthly-print', {
      title: `Rekap TKinerja ${MONTHS[Number(month) - 1]} ${year}`,
      year, month, monthName: MONTHS[Number(month) - 1], recap,
    });
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Rekap cetak TKinerja gagal`, error);
    return res.status(500).send('Rekap cetak TKinerja gagal.');
  }
});

router.get('/month/:year/:month', async (req, res) => {
  const year = String(req.params.year);
  const month = String(req.params.month).padStart(2, '0');
  if (!validMonth(year, month)) return res.status(400).send('Bulan tidak valid.');
  try {
    const [dates] = await db.query(
      `SELECT DATE_FORMAT(k.activity_date, '%Y-%m-%d') AS date_key, COUNT(DISTINCT k.id) AS report_count,
              COUNT(ke.id) AS evidence_count
       FROM kinerja_reports k
       LEFT JOIN kinerja_evidence ke ON ke.report_id = k.id
       WHERE k.account_id = ? AND YEAR(k.activity_date) = ? AND MONTH(k.activity_date) = ?
       GROUP BY k.activity_date ORDER BY k.activity_date DESC`,
      [req.activeAccount.id, Number(year), Number(month)]
    );
    const selectedMonth = { year, month, folder_name: `Kinerja-${MONTHS[Number(month) - 1]}` };
    const recap = await monthlyRecap(req.activeAccount.id, year, month);
    return renderKinerja(res, req, { title: `${selectedMonth.folder_name} ${year}`, viewMode: 'dates', dates, selectedMonth, recap });
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
              (SELECT f.uuid FROM kinerja_evidence ke INNER JOIN files f ON f.id = ke.file_id
               WHERE ke.report_id = k.id ORDER BY ke.sort_order, ke.id LIMIT 1) AS evidence_uuid,
              (SELECT f.mime FROM kinerja_evidence ke INNER JOIN files f ON f.id = ke.file_id
               WHERE ke.report_id = k.id ORDER BY ke.sort_order, ke.id LIMIT 1) AS evidence_mime,
              (SELECT COUNT(*) FROM kinerja_evidence ke WHERE ke.report_id = k.id) AS evidence_count,
              s.uuid AS share_uuid, sl.short_code
       FROM kinerja_reports k
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
  maxImageMb: MAX_IMAGE_MB, maxEvidenceFiles: MAX_EVIDENCE_FILES, csrfToken: res.locals.csrfToken,
}));

router.post('/', parseEvidenceUpload, async (req, res) => {
  try {
    const input = validateInput(req.body);
    const folder = await ensureDateFolder(req.activeAccount.id, input.activityDate);
    const evidence = await uploadEvidenceFiles(req, folder.id);
    const uuid = crypto.randomUUID();
    const now = Date.now();
    try {
      const [result] = await db.query(
        `INSERT INTO kinerja_reports
         (uuid, account_id, folder_id, evidence_file_id, activity_date, title, start_time, end_time, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid, req.activeAccount.id, folder.id, evidence[0] ? evidence[0].id : null, input.activityDate,
          input.title, input.startTime, input.endTime, input.description || null, now, now]
      );
      for (let index = 0; index < evidence.length; index++) {
        await db.query('INSERT INTO kinerja_evidence (report_id, file_id, sort_order, created_at) VALUES (?, ?, ?, ?)',
          [result.insertId, evidence[index].id, index, now]);
      }
    } catch (err) {
      await db.query('DELETE FROM kinerja_reports WHERE uuid = ?', [uuid]).catch(() => {});
      for (const file of evidence) await deleteEvidenceFile(req.activeAccount, file.id);
      throw err;
    }
    await auditService.log(req, 'CREATE_KINERJA', `Membuat laporan TKinerja "${input.title}" (${uuid})`).catch((auditErr) => {
      console.error('[TKinerja] Laporan tersimpan, tetapi audit log gagal:', auditErr.message);
    });
    return redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil dibuat dan dirapikan ke folder tanggal.');
  } catch (err) {
    console.error('[TKinerja] Gagal membuat laporan:', err);
    return redirectWith(res, '/kinerja/new', 'error', err.message || 'Laporan gagal disimpan.');
  } finally {
    for (const file of req.files || []) fs.promises.unlink(file.path).catch(() => {});
  }
});

router.get('/:uuid/edit', async (req, res) => {
  const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
  if (!report) return res.status(404).send('Laporan tidak ditemukan.');
  const activityDate = String(report.activity_date).slice(0, 10);
  res.render('kinerja/form', {
    title: 'Edit Laporan TKinerja', report, error: req.query.error || null, notice: req.query.notice || null,
    returnUrl: /^\d{4}-\d{2}-\d{2}$/.test(activityDate) ? `/kinerja/date/${activityDate}` : '/kinerja',
    maxImageMb: MAX_IMAGE_MB, maxEvidenceFiles: MAX_EVIDENCE_FILES, csrfToken: res.locals.csrfToken,
  });
});

router.post('/:uuid', parseEvidenceUpload, async (req, res) => {
  let report;
  try {
    report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    if (!report) throw new Error('Laporan tidak ditemukan.');
    const input = validateInput(req.body);
    if (report.evidence.length + (req.files || []).length > MAX_EVIDENCE_FILES) {
      throw new Error(`Maksimum ${MAX_EVIDENCE_FILES} berkas bukti per laporan.`);
    }
    const folder = await ensureDateFolder(req.activeAccount.id, input.activityDate);
    const evidence = await uploadEvidenceFiles(req, folder.id);
    await db.query(
      `UPDATE kinerja_reports SET folder_id = ?, activity_date = ?, title = ?,
       start_time = ?, end_time = ?, description = ?, updated_at = ? WHERE id = ?`,
      [folder.id, input.activityDate, input.title, input.startTime, input.endTime,
        input.description || null, Date.now(), report.id]
    );
    try {
      for (let index = 0; index < evidence.length; index++) {
        await db.query('INSERT INTO kinerja_evidence (report_id, file_id, sort_order, created_at) VALUES (?, ?, ?, ?)',
          [report.id, evidence[index].id, report.evidence.length + index, Date.now()]);
      }
      if (!report.evidence_file_id && evidence[0]) {
        await db.query('UPDATE kinerja_reports SET evidence_file_id = ? WHERE id = ?', [evidence[0].id, report.id]);
      }
    } catch (err) {
      for (const file of evidence) await deleteEvidenceFile(req.activeAccount, file.id);
      throw err;
    }
    await auditService.log(req, 'UPDATE_KINERJA', `Memperbarui laporan TKinerja "${input.title}" (${report.uuid})`).catch((auditErr) => {
      console.error('[TKinerja] Laporan diperbarui, tetapi audit log gagal:', auditErr.message);
    });
    return redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil diperbarui.');
  } catch (err) {
    console.error('[TKinerja] Gagal memperbarui laporan:', err);
    return redirectWith(res, `/kinerja/${req.params.uuid}/edit`, 'error', err.message || 'Laporan gagal diperbarui.');
  } finally {
    for (const file of req.files || []) fs.promises.unlink(file.path).catch(() => {});
  }
});

router.get('/:uuid/evidence/:evidenceId?', async (req, res) => {
  try {
    const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    const evidence = report && (req.params.evidenceId
      ? report.evidence.find((item) => String(item.evidence_id) === String(req.params.evidenceId))
      : report.evidence[0]);
    if (!evidence) return res.status(404).send('Bukti tidak ditemukan.');
    const file = await fileService.getFile(evidence.file_id);
    if (!file || String(file.account_id) !== String(req.activeAccount.id) || file.deleted_at) {
      return res.status(404).send('Bukti tidak ditemukan.');
    }
    if (req.query.preview === '1') {
      return await require('../services/previewService').sendPreview(req, res, file, req.activeAccount);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    await storageService.downloadToStream(req.activeAccount, file, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Gagal memuat bukti: ' + err.message);
  }
});

router.post('/:uuid/evidence/:evidenceId/delete', async (req, res) => {
  try {
    const report = await getOwnedReport(req.params.uuid, req.activeAccount.id);
    const evidence = report && report.evidence.find((item) => String(item.evidence_id) === String(req.params.evidenceId));
    if (!evidence) throw new Error('Bukti tidak ditemukan.');
    await db.query('DELETE FROM kinerja_evidence WHERE id = ? AND report_id = ?', [evidence.evidence_id, report.id]);
    await deleteEvidenceFile(req.activeAccount, evidence.file_id);
    const remaining = report.evidence.filter((item) => item.evidence_id !== evidence.evidence_id);
    await db.query('UPDATE kinerja_reports SET evidence_file_id = ?, updated_at = ? WHERE id = ?',
      [remaining[0] ? remaining[0].file_id : null, Date.now(), report.id]);
    return redirectWith(res, `/kinerja/${report.uuid}/edit`, 'notice', 'Bukti berhasil dihapus.');
  } catch (err) {
    return redirectWith(res, `/kinerja/${req.params.uuid}/edit`, 'error', err.message);
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
    for (const evidence of report.evidence) await deleteEvidenceFile(req.activeAccount, evidence.file_id);
    await auditService.log(req, 'DELETE_KINERJA', `Menghapus laporan TKinerja "${report.title}" (${report.uuid})`);
    redirectWith(res, '/kinerja', 'notice', 'Laporan kinerja berhasil dihapus.');
  } catch (err) {
    redirectWith(res, '/kinerja', 'error', err.message);
  }
});

module.exports = router;
