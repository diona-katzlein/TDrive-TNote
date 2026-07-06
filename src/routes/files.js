'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const db = require('../db');
const fileService = require('../services/fileService');
const storageService = require('../services/storageService');
const auditService = require('../services/auditService');
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

/**
 * Helper untuk merender halaman browser file/folder
 */
async function renderBrowser(req, res, folderUuid = null) {
  try {
    const accountId = req.activeAccount.id;
    const q = (req.query.q || '').trim();

    let currentFolder = null;
    let folderId = null;
    if (folderUuid) {
      currentFolder = await fileService.getFolderByUuid(folderUuid);
      if (!currentFolder || currentFolder.account_id !== accountId) {
        return res.status(404).send('Folder tidak ditemukan.');
      }
      folderId = currentFolder.id;
    }

    const folders = q ? [] : await fileService.listFolders(accountId, folderId);
    const files = q
      ? await fileService.searchFiles(accountId, q)
      : await fileService.listFiles(accountId, folderId);

    // Ambil daftar share aktif untuk akun ini agar bisa dirender di UI
    const [shares] = await db.query(
      `SELECT s.uuid, s.item_type, s.item_id 
       FROM shares s
       LEFT JOIN files f ON s.item_type = 'file' AND s.item_id = f.id
       LEFT JOIN folders fd ON s.item_type = 'folder' AND s.item_id = fd.id
       WHERE f.account_id = ? OR fd.account_id = ?`,
      [accountId, accountId]
    );

    const sharesMap = { file: {}, folder: {} };
    for (const s of shares) {
      if (sharesMap[s.item_type]) {
        sharesMap[s.item_type][s.item_id] = s.uuid;
      }
    }

    res.render('files/browser', {
      title: currentFolder ? currentFolder.name : 'Drive',
      folders,
      files,
      currentFolder,
      allFolders: await fileService.listAllFolders(accountId),
      stats: await fileService.accountStats(accountId),
      sharesMap,
      query: q,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat Drive: ' + err.message);
  }
}

// Browse Root Drive
router.get('/', (req, res) => renderBrowser(req, res, null));

// Browse Subfolder Drive (IDOR-safe menggunakan UUID)
router.get('/folder/:uuid', (req, res) => renderBrowser(req, res, req.params.uuid));

// Upload File (streaming dari disk, chunking otomatis untuk file besar)
router.post('/upload', upload.single('file'), async (req, res) => {
  const folderUuid = req.body.folder_uuid || null;
  const tempPath = req.file && req.file.path;
  
  try {
    if (!req.file) throw new Error('Tidak ada file yang dipilih.');
    
    let folderId = null;
    if (folderUuid) {
      const folder = await fileService.getFolderByUuid(folderUuid);
      if (!folder || folder.account_id !== req.activeAccount.id) {
        throw new Error('Folder tujuan tidak ditemukan.');
      }
      folderId = folder.id;
    }

    const uploadedFile = await storageService.uploadFile(req.activeAccount, {
      tempPath,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      folderId,
    });

    await auditService.log(req, 'UPLOAD_FILE', `Mengunggah berkas: ${req.file.originalname} (${req.file.size} bytes, File UUID: ${uploadedFile.uuid})`);

    const redirectPath = folderUuid ? `/drive/folder/${folderUuid}` : '/drive';
    res.redirect(redirectPath);
  } catch (err) {
    const back = folderUuid ? `/drive/folder/${folderUuid}` : '/drive';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
});

// Download File (IDOR-safe menggunakan UUID)
router.get('/file/:uuid/download', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      return res.status(404).send('File tidak ditemukan.');
    }

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    
    await auditService.log(req, 'DOWNLOAD_FILE', `Mengunduh berkas: ${file.name} (UUID: ${file.uuid})`);
    
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

// Rename File (IDOR-safe menggunakan UUID)
router.post('/file/:uuid/rename', async (req, res) => {
  const { uuid } = req.params;
  const newName = (req.body.name || '').trim();
  try {
    const file = await fileService.getFileByUuid(uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      throw new Error('File tidak ditemukan.');
    }
    if (!newName) throw new Error('Nama file tidak boleh kosong.');

    const oldName = file.name;
    await fileService.renameFile(file.id, newName);

    await auditService.log(req, 'RENAME_FILE', `Mengubah nama berkas dari "${oldName}" menjadi "${newName}" (UUID: ${file.uuid})`);

    let redirectPath = '/drive';
    if (file.folder_id) {
      const folder = await fileService.getFolder(file.folder_id);
      if (folder) redirectPath = `/drive/folder/${folder.uuid}`;
    }
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Gagal mengubah nama file: ' + err.message);
  }
});

// Pindahkan File ke Folder lain (IDOR-safe menggunakan UUID)
router.post('/file/:uuid/move', async (req, res) => {
  const { uuid } = req.params;
  const targetFolderUuid = req.body.folder_uuid || null;
  const currentFolderUuid = req.body.from_uuid || null;

  try {
    const file = await fileService.getFileByUuid(uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      throw new Error('File tidak ditemukan.');
    }

    let targetFolderId = null;
    let targetFolderName = 'root';
    if (targetFolderUuid) {
      const targetFolder = await fileService.getFolderByUuid(targetFolderUuid);
      if (!targetFolder || targetFolder.account_id !== req.activeAccount.id) {
        throw new Error('Folder tujuan tidak ditemukan.');
      }
      targetFolderId = targetFolder.id;
      targetFolderName = targetFolder.name;
    }

    await fileService.moveFile(file.id, targetFolderId);

    await auditService.log(req, 'MOVE_FILE', `Memindahkan berkas "${file.name}" ke folder "${targetFolderName}" (File UUID: ${file.uuid})`);

    const back = currentFolderUuid ? `/drive/folder/${currentFolderUuid}` : '/drive';
    res.redirect(back);
  } catch (err) {
    res.status(500).send('Gagal memindahkan file: ' + err.message);
  }
});

// Verifikasi Integritas File (IDOR-safe menggunakan UUID)
router.get('/file/:uuid/verify', async (req, res) => {
  let file;
  try {
    file = await fileService.getFileByUuid(req.params.uuid);
  } catch (e) {
    return res.status(500).send('Gagal mengambil file.');
  }

  if (!file || file.account_id !== req.activeAccount.id) {
    return res.status(404).send('File tidak ditemukan.');
  }

  let back = '/drive';
  if (file.folder_id) {
    const folder = await fileService.getFolder(file.folder_id);
    if (folder) back = `/drive/folder/${folder.uuid}`;
  }

  try {
    const r = await storageService.verifyIntegrity(req.activeAccount, file);
    const msg = r.expected
      ? r.ok
        ? `Integritas "${file.name}" OK (SHA-256 cocok).`
        : `PERINGATAN: Checksum "${file.name}" tidak cocok!`
      : `"${file.name}": tidak ada checksum tersimpan.`;
    
    await auditService.log(req, 'VERIFY_FILE', `Verifikasi integritas file "${file.name}": ${r.ok ? 'SUCCESS' : 'FAILED'} (File UUID: ${file.uuid})`);

    const key = r.ok ? 'notice' : 'error';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  }
});

// Hapus File (IDOR-safe menggunakan UUID)
router.post('/file/:uuid/delete', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (file && file.account_id === req.activeAccount.id) {
      try {
        await storageService.deleteRemote(req.activeAccount, file);
      } catch (_) {
        /* abaikan error remote */
      }
      
      // Hapus share link terkait berkas
      await db.query("DELETE FROM shares WHERE item_type = 'file' AND item_id = ?", [file.id]);
      
      await fileService.deleteFile(file.id);
      await auditService.log(req, 'DELETE_FILE', `Menghapus berkas: ${file.name} (UUID: ${file.uuid})`);
    }

    let redirectPath = '/drive';
    if (file && file.folder_id) {
      const folder = await fileService.getFolder(file.folder_id);
      if (folder) redirectPath = `/drive/folder/${folder.uuid}`;
    }
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Gagal menghapus file: ' + err.message);
  }
});

module.exports = router;
