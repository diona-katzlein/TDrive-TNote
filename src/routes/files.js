'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const fileService = require('../services/fileService');
const storageService = require('../services/storageService');
const { requireActiveAccount } = require('../middleware/activeAccount');

// Direktori temp untuk upload (streaming ke disk, bukan memori).
const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
const MAX_UPLOAD_MB = Number(process.env.TDRIVE_MAX_UPLOAD_MB) || 10240; // default 10 GB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    cb(null, TMP_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

router.use(requireActiveAccount);

// Browse drive: daftar folder + file pada folder tertentu
router.get('/', (req, res) => {
  const accountId = req.activeAccount.id;
  const folderId = req.query.folder ? Number(req.query.folder) : null;
  const q = (req.query.q || '').trim();

  const currentFolder = folderId ? fileService.getFolder(folderId) : null;
  const folders = q ? [] : fileService.listFolders(accountId, folderId);
  const files = q
    ? fileService.searchFiles(accountId, q)
    : fileService.listFiles(accountId, folderId);

  res.render('files/browser', {
    title: 'Drive',
    folders,
    files,
    currentFolder,
    allFolders: fileService.listAllFolders(accountId),
    stats: fileService.accountStats(accountId),
    query: q,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// Upload file (streaming dari disk, chunking otomatis untuk file besar)
router.post('/upload', upload.single('file'), async (req, res) => {
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  const tempPath = req.file && req.file.path;
  try {
    if (!req.file) throw new Error('Tidak ada file yang dipilih.');
    await storageService.uploadFile(req.activeAccount, {
      tempPath,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      folderId,
    });
    res.redirect(folderId ? `/drive?folder=${folderId}` : '/drive');
  } catch (err) {
    const back = folderId ? `/drive?folder=${folderId}` : '/drive';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
});

// Download file (streaming reassembly)
router.get('/:id/download', async (req, res) => {
  const file = fileService.getFile(Number(req.params.id));
  if (!file || file.account_id !== req.activeAccount.id) {
    return res.status(404).send('File tidak ditemukan.');
  }
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  try {
    await storageService.downloadToStream(req.activeAccount, file, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).send('Gagal mengunduh: ' + err.message);
    } else {
      res.destroy(err);
    }
  }
});

// Rename file
router.post('/:id/rename', (req, res) => {
  const file = fileService.getFile(Number(req.params.id));
  if (file && file.account_id === req.activeAccount.id && req.body.name) {
    fileService.renameFile(file.id, req.body.name.trim());
  }
  const folderId = file && file.folder_id ? file.folder_id : null;
  res.redirect(folderId ? `/drive?folder=${folderId}` : '/drive');
});

// Pindahkan file ke folder lain (FR-13). Target kosong = root.
router.post('/:id/move', (req, res) => {
  const file = fileService.getFile(Number(req.params.id));
  if (file && file.account_id === req.activeAccount.id) {
    const targetId = req.body.folder_id ? Number(req.body.folder_id) : null;
    if (targetId) {
      // Validasi: folder tujuan harus milik akun yang sama.
      const target = fileService.getFolder(targetId);
      if (target && target.account_id === req.activeAccount.id) {
        fileService.moveFile(file.id, targetId);
      }
    } else {
      fileService.moveFile(file.id, null);
    }
  }
  const back = req.body.from ? Number(req.body.from) : null;
  res.redirect(back ? `/drive?folder=${back}` : '/drive');
});

// Verifikasi integritas file via SHA-256 (FR-19).
router.get('/:id/verify', async (req, res) => {
  const file = fileService.getFile(Number(req.params.id));
  if (!file || file.account_id !== req.activeAccount.id) {
    return res.status(404).send('File tidak ditemukan.');
  }
  const back = file.folder_id ? `/drive?folder=${file.folder_id}` : '/drive';
  try {
    const r = await storageService.verifyIntegrity(req.activeAccount, file);
    const msg = r.expected
      ? r.ok
        ? `Integritas "${file.name}" OK (SHA-256 cocok).`
        : `PERINGATAN: "${file.name}" TIDAK cocok! tersimpan=${r.expected.slice(0, 12)}… aktual=${r.actual.slice(0, 12)}…`
      : `"${file.name}": tidak ada checksum tersimpan; SHA-256 aktual=${r.actual.slice(0, 12)}…`;
    const key = r.ok ? 'notice' : 'error';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  }
});

// Hapus file (metadata + pesan Telegram)
router.post('/:id/delete', async (req, res) => {
  const file = fileService.getFile(Number(req.params.id));
  if (file && file.account_id === req.activeAccount.id) {
    try {
      await storageService.deleteRemote(req.activeAccount, file);
    } catch (_) {
      /* abaikan error remote */
    }
    fileService.deleteFile(file.id);
  }
  const folderId = file && file.folder_id ? file.folder_id : null;
  res.redirect(folderId ? `/drive?folder=${folderId}` : '/drive');
});

module.exports = router;
