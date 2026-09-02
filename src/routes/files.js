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
const jobQueue = require('../services/jobQueue');
const { requireActiveAccount } = require('../middleware/activeAccount');

const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
const MAX_UPLOAD_MB = Number(process.env.TDRIVE_MAX_UPLOAD_MB) || 10240; // 10 GB

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

// Pengalihan otomatis /drive/folder ke /drive/
router.get('/folder', (req, res) => res.redirect('/drive'));
router.get('/folder/', (req, res) => res.redirect('/drive'));

/**
 * Helper render browser file
 */
async function renderBrowser(req, res, folderUuid = null) {
  try {
    const accountId = req.activeAccount.id;
    const q = (req.query.q || '').trim();

    let currentFolder = null;
    let folderId = null;
    if (folderUuid) {
      currentFolder = await fileService.getFolderByUuid(folderUuid);
      if (!currentFolder || currentFolder.account_id !== accountId || currentFolder.deleted_at !== null) {
        return res.status(404).send('Folder tidak ditemukan.');
      }
      folderId = currentFolder.id;
    }

    const folders = q ? [] : await fileService.listFolders(accountId, folderId);
    const files = q
      ? await fileService.searchFiles(accountId, q)
      : await fileService.listFiles(accountId, folderId);

    // Ambil daftar share aktif
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

    const [channels] = await db.query(
      'SELECT * FROM user_channels WHERE account_id = ? ORDER BY created_at DESC',
      [accountId]
    );

    res.render('files/browser', {
      title: currentFolder ? currentFolder.name : 'Drive',
      folders,
      files,
      currentFolder,
      allFolders: await fileService.listAllFolders(accountId),
      stats: await fileService.accountStats(accountId),
      sharesMap,
      channels,
      query: q,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat Drive: ' + err.message);
  }
}

router.get('/', (req, res) => renderBrowser(req, res, null));
router.get('/folder/:uuid', (req, res) => renderBrowser(req, res, req.params.uuid));

// Upload File (dengan penanganan Versi Berkas jika nama duplikat)
router.post('/upload', upload.array('files'), async (req, res) => {
  const folderUuid = req.body.folder_uuid || null;
  const files = req.files || [];
  
  try {
    if (files.length === 0) throw new Error('Tidak ada file yang dipilih.');
    
    let folderId = null;
    if (folderUuid) {
      const folder = await fileService.getFolderByUuid(folderUuid);
      if (!folder || folder.account_id !== req.activeAccount.id) {
        throw new Error('Folder tujuan tidak ditemukan.');
      }
      folderId = folder.id;
    }

    for (const file of files) {
      const tempPath = file.path;
      try {
        // Periksa apakah berkas dengan nama yang sama sudah ada di direktori tersebut
        const existingFile = await fileService.findActiveFileByName(req.activeAccount.id, folderId, file.originalname);

        const uploadedFile = await storageService.uploadFile(req.activeAccount, {
          tempPath,
          filename: file.originalname,
          mime: file.mimetype,
          size: file.size,
          folderId,
          storagePeer: req.body.storage_peer || null,
        });

        // Jika sudah ada berkas bernama sama, jadikan yang lama sebagai versi riwayat
        if (existingFile) {
          await db.query('UPDATE files SET parent_file_id = ?, folder_id = NULL WHERE id = ?', [uploadedFile.id, existingFile.id]);
          await db.query('UPDATE files SET parent_file_id = ? WHERE parent_file_id = ? AND id != ?', [uploadedFile.id, existingFile.id, uploadedFile.id]);
          await auditService.log(req, 'VERSION_CREATE', `Mengarsipkan versi lama berkas "${file.originalname}" (ID: ${existingFile.id}) menjadi riwayat dari berkas baru (ID: ${uploadedFile.id})`);
        }

        await auditService.log(req, 'UPLOAD_FILE', `Mengunggah berkas: ${file.originalname} (${file.size} bytes, UUID: ${uploadedFile.uuid})`);
      } finally {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
      }
    }

    const redirectPath = folderUuid ? `/drive/folder/${folderUuid}` : '/drive';
    res.redirect(redirectPath);
  } catch (err) {
    // Bersihkan file sisa jika terjadi error di tengah jalan
    for (const f of files) {
      if (f.path) fs.promises.unlink(f.path).catch(() => {});
    }
    const back = folderUuid ? `/drive/folder/${folderUuid}` : '/drive';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  }
});

// Chunked Upload (Menghindari limit Cloudflare 100MB)
const chunkUpload = multer({ dest: path.join(process.cwd(), 'data', 'tmp', 'chunks') });
router.post('/upload-chunk', chunkUpload.single('chunk'), async (req, res) => {
  const { chunk_index, total_chunks, upload_id, filename, folder_uuid } = req.body;
  const chunkFile = req.file;
  const uploadId = String(upload_id || '');
  const total = Number(total_chunks);
  const index = Number(chunk_index);

  try {
    if (!chunkFile) throw new Error('Berkas chunk kosong.');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(uploadId)) throw new Error('Upload ID tidak valid.');
    if (!Number.isInteger(total) || total < 1 || total > 100000) throw new Error('Jumlah chunk tidak valid.');
    if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error('Index chunk tidak valid.');
    if (!filename || String(filename).length > 255) throw new Error('Nama file tidak valid.');

    const now = Date.now();
    await db.query(
      `INSERT INTO upload_sessions
       (upload_id, account_id, filename, folder_uuid, total_chunks, received_chunks, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'receiving', ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
      [uploadId, req.activeAccount.id, String(filename), folder_uuid || null, total, now, now]
    );
    const [ownedSessions] = await db.query('SELECT account_id FROM upload_sessions WHERE upload_id = ? LIMIT 1', [uploadId]);
    if (!ownedSessions.length || Number(ownedSessions[0].account_id) !== Number(req.activeAccount.id)) throw new Error('Upload session tidak ditemukan.');

    const chunkDir = path.join(process.cwd(), 'data', 'tmp', 'uploads', uploadId);
    fs.mkdirSync(chunkDir, { recursive: true });

    const chunkPath = path.join(chunkDir, `part_${chunk_index}`);
    fs.renameSync(chunkFile.path, chunkPath);

    // Cek apakah semua chunk sudah terkumpul
    const files = fs.readdirSync(chunkDir).filter((name) => /^part_\d+$/.test(name));
    await db.query(
      `UPDATE upload_sessions SET received_chunks = ?, status = 'receiving', error_message = NULL, updated_at = ?
       WHERE upload_id = ? AND account_id = ?`,
      [files.length, Date.now(), uploadId, req.activeAccount.id]
    );
    if (files.length === total) {
      // Satukan chunks
      const assembledPath = path.join(process.cwd(), 'data', 'tmp', `${Date.now()}-${filename}`);
      const writeStream = fs.createWriteStream(assembledPath);

      for (let i = 0; i < total; i++) {
        const partPath = path.join(chunkDir, `part_${i}`);
        if (!fs.existsSync(partPath)) {
          throw new Error(`Chunk part_${i} hilang dari penyimpanan temp.`);
        }
        const partData = fs.readFileSync(partPath);
        writeStream.write(partData);
        fs.unlinkSync(partPath);
      }
      writeStream.end();

      await new Promise((resolve) => writeStream.on('finish', resolve));
      try {
        fs.rmdirSync(chunkDir);
      } catch (_) {}

      try {
        let folderId = null;
        if (folder_uuid) {
          const folder = await fileService.getFolderByUuid(folder_uuid);
          if (folder && folder.account_id === req.activeAccount.id) {
            folderId = folder.id;
          }
        }

        const existingFile = await fileService.findActiveFileByName(req.activeAccount.id, folderId, filename);

        const uploadedFile = await storageService.uploadFile(req.activeAccount, {
          tempPath: assembledPath,
          filename,
          mime: 'application/octet-stream',
          size: fs.statSync(assembledPath).size,
          folderId,
          storagePeer: req.body.storage_peer || null,
        });

        if (existingFile) {
          await db.query('UPDATE files SET parent_file_id = ?, folder_id = NULL WHERE id = ?', [uploadedFile.id, existingFile.id]);
          await db.query('UPDATE files SET parent_file_id = ? WHERE parent_file_id = ? AND id != ?', [uploadedFile.id, existingFile.id, uploadedFile.id]);
          await auditService.log(req, 'VERSION_CREATE', `Mengarsipkan versi lama berkas "${filename}" (ID: ${existingFile.id}) menjadi riwayat dari berkas baru (ID: ${uploadedFile.id})`);
        }

        await auditService.log(req, 'UPLOAD_FILE_CHUNKED', `Mengunggah berkas besar (chunked): ${filename} (${uploadedFile.size} bytes, UUID: ${uploadedFile.uuid})`);
        fs.unlinkSync(assembledPath);
        await db.query(
          `UPDATE upload_sessions SET status = 'completed', received_chunks = total_chunks,
           error_message = NULL, completed_at = ?, updated_at = ? WHERE upload_id = ? AND account_id = ?`,
          [Date.now(), Date.now(), uploadId, req.activeAccount.id]
        );

        return res.json({ success: true, file: uploadedFile });
      } catch (err) {
        if (fs.existsSync(assembledPath)) fs.unlinkSync(assembledPath);
        throw err;
      }
    } else {
      return res.json({ success: true, message: `Chunk ${index + 1}/${total} diterima.` });
    }
  } catch (err) {
    if (chunkFile && fs.existsSync(chunkFile.path)) fs.unlinkSync(chunkFile.path).catch(() => {});
    if (/^[A-Za-z0-9_-]{8,100}$/.test(uploadId)) {
      await db.query(
        `UPDATE upload_sessions SET status = 'failed', error_message = ?, updated_at = ?
         WHERE upload_id = ? AND account_id = ?`,
        [String(err.message || err).slice(0, 500), Date.now(), uploadId, req.activeAccount.id]
      ).catch(() => {});
    }
    console.error(`[${req.id || 'no-request-id'}] Chunk upload gagal`, err);
    return res.status(500).send('Upload chunk gagal.');
  }
});

// Download File
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

// In-Browser Media Preview & Streaming (Image, PDF, Video, Audio)
router.get('/file/:uuid/preview', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      return res.status(404).send('File tidak ditemukan.');
    }

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    
    await auditService.log(req, 'PREVIEW_FILE', `Melakukan preview berkas media: ${file.name} (UUID: ${file.uuid})`);
    await storageService.downloadToStream(req.activeAccount, file, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).send('Preview gagal: ' + err.message);
    } else {
      res.destroy(err);
    }
  }
});

// Rename File
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

// Ambil data detail chunk (message_id, peer target) untuk shortlink Telegram t.me
router.get('/file/:uuid/link-data', async (req, res) => {
  const { uuid } = req.params;
  try {
    const file = await fileService.getFileByUuid(uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      return res.status(404).json({ error: 'Berkas tidak ditemukan.' });
    }

    // Ambil data chunk pertama (part_index = 0)
    const [chunks] = await db.query(
      'SELECT message_id, peer FROM file_chunks WHERE file_id = ? AND part_index = 0',
      [file.id]
    );

    if (chunks.length === 0) {
      return res.json({ success: false, message: 'Chunk berkas belum diunggah.' });
    }

    res.json({
      success: true,
      message_id: chunks[0].message_id,
      peer: chunks[0].peer
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pindahkan File
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

// Aksi massal dengan validasi kepemilikan ulang pada setiap item.
router.post('/bulk', async (req, res) => {
  const fileUuids = [...new Set([].concat(req.body.file_uuids || []).filter(Boolean))].slice(0, 200);
  const folderUuids = [...new Set([].concat(req.body.folder_uuids || []).filter(Boolean))].slice(0, 100);
  const action = req.body.action;
  const back = req.body.back && /^\/drive(?:\/folder\/[a-f0-9-]+)?$/i.test(req.body.back)
    ? req.body.back
    : '/drive';

  try {
    let affected = 0;
    if (action === 'verify') {
      for (const uuid of fileUuids) {
        const file = await fileService.getFileByUuid(uuid);
        if (!file || Number(file.account_id) !== Number(req.activeAccount.id) || file.deleted_at) continue;
        await jobQueue.enqueue(
          'storage.verify',
          { accountId: req.activeAccount.id, fileId: file.id },
          { accountId: req.activeAccount.id }
        );
        affected += 1;
      }
    } else if (action === 'delete') {
      for (const uuid of fileUuids) {
        const file = await fileService.getFileByUuid(uuid);
        if (!file || Number(file.account_id) !== Number(req.activeAccount.id) || file.deleted_at) continue;
        await fileService.softDeleteFile(file.id);
        affected += 1;
      }
      for (const uuid of folderUuids) {
        const folder = await fileService.getFolderByUuid(uuid);
        if (!folder || Number(folder.account_id) !== Number(req.activeAccount.id) || folder.deleted_at) continue;
        const pending = [folder.id];
        while (pending.length) {
          const folderId = pending.pop();
          await db.query('UPDATE files SET deleted_at = ? WHERE account_id = ? AND folder_id = ? AND deleted_at IS NULL', [Date.now(), req.activeAccount.id, folderId]);
          const [children] = await db.query('SELECT id FROM folders WHERE account_id = ? AND parent_id = ? AND deleted_at IS NULL', [req.activeAccount.id, folderId]);
          pending.push(...children.map((child) => child.id));
          await db.query('UPDATE folders SET deleted_at = ? WHERE account_id = ? AND id = ?', [Date.now(), req.activeAccount.id, folderId]);
        }
        affected += 1;
      }
    } else {
      return res.redirect(`${back}?error=${encodeURIComponent('Aksi massal tidak valid.')}`);
    }

    await auditService.log(req, `BULK_${action.toUpperCase()}`, `Aksi massal ${action}: ${affected} item milik akun ${req.activeAccount.id}.`);
    return res.redirect(`${back}?notice=${encodeURIComponent(`${affected} item diproses.`)}`);
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Aksi massal gagal`, error);
    return res.redirect(`${back}?error=${encodeURIComponent('Aksi massal gagal diproses.')}`);
  }
});

// Verifikasi Integritas File
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
    const jobUuid = await jobQueue.enqueue(
      'storage.verify',
      { accountId: req.activeAccount.id, fileId: file.id },
      { accountId: req.activeAccount.id }
    );
    await auditService.log(req, 'VERIFY_FILE_QUEUED', `Menjadwalkan verifikasi integritas file "${file.name}" (File UUID: ${file.uuid}, Job UUID: ${jobUuid})`);
    const msg = `Verifikasi integritas "${file.name}" dijadwalkan. Job: ${jobUuid}`;
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Gagal menjadwalkan verifikasi`, err);
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent('Gagal menjadwalkan verifikasi integritas.')}`);
  }
});

// Soft Delete File (Masuk Keranjang Sampah)
router.post('/file/:uuid/delete', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (file && file.account_id === req.activeAccount.id) {
      await fileService.softDeleteFile(file.id);
      await auditService.log(req, 'DELETE_FILE_SOFT', `Memindahkan berkas ke keranjang sampah: ${file.name} (UUID: ${file.uuid})`);
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

// ----------------------------------------------------
// MANAJEMEN SAMPAH (RECYCLE BIN)
// ----------------------------------------------------

router.get('/trash', async (req, res) => {
  try {
    const accountId = req.activeAccount.id;
    const folders = await fileService.listTrashFolders(accountId);
    const files = await fileService.listTrashFiles(accountId);

    res.render('files/trash', {
      title: 'Keranjang Sampah',
      folders,
      files,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat tempat sampah: ' + err.message);
  }
});

// Pulihkan Berkas
router.post('/file/:uuid/restore', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      throw new Error('Berkas tidak ditemukan.');
    }
    await fileService.restoreFile(file.id);
    await auditService.log(req, 'RESTORE_FILE', `Memulihkan berkas "${file.name}" dari tempat sampah.`);
    res.redirect('/drive/trash?notice=' + encodeURIComponent('Berkas berhasil dipulihkan.'));
  } catch (err) {
    res.redirect('/drive/trash?error=' + encodeURIComponent(err.message));
  }
});

// Hapus Berkas Permanen
router.post('/file/:uuid/delete-permanent', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      throw new Error('Berkas tidak ditemukan.');
    }
    
    const jobUuid = await jobQueue.enqueue(
      'storage.delete-file',
      { accountId: req.activeAccount.id, fileId: file.id },
      { accountId: req.activeAccount.id }
    );
    await auditService.log(req, 'DELETE_FILE_PERMANENT_QUEUED', `Menjadwalkan penghapusan permanen: ${file.name} (UUID: ${file.uuid}, Job UUID: ${jobUuid})`);

    res.redirect('/drive/trash?notice=' + encodeURIComponent(`Penghapusan permanen dijadwalkan. Job: ${jobUuid}`));
  } catch (err) {
    res.redirect('/drive/trash?error=' + encodeURIComponent(err.message));
  }
});

// Kosongkan Tempat Sampah
router.post('/trash/empty', async (req, res) => {
  try {
    const accountId = req.activeAccount.id;
    
    // Pertahankan metadata file sampai worker berhasil menghapus konten remote.
    const files = await fileService.listTrashFiles(accountId);
    const jobs = [];
    for (const file of files) {
      jobs.push(await jobQueue.enqueue(
        'storage.delete-file',
        { accountId, fileId: file.id },
        { accountId }
      ));
    }

    // Ambil folder-folder terhapus dan hapus records
    const folders = await fileService.listTrashFolders(accountId);
    for (const f of folders) {
      await db.query("DELETE FROM shares WHERE item_type = 'folder' AND item_id = ?", [f.id]);
      await fileService.deleteFolder(f.id);
    }

    await auditService.log(req, 'EMPTY_TRASH_QUEUED', `Menjadwalkan ${jobs.length} penghapusan file remote dan menghapus metadata folder sampah.`);
    res.redirect('/drive/trash?notice=' + encodeURIComponent(`${jobs.length} penghapusan file dijadwalkan; folder sampah telah dibersihkan.`));
  } catch (err) {
    res.redirect('/drive/trash?error=' + encodeURIComponent(err.message));
  }
});

// ----------------------------------------------------
// RIWAYAT VERSI BERKAS (VERSIONING)
// ----------------------------------------------------

router.get('/file/:uuid/versions', async (req, res) => {
  try {
    const file = await fileService.getFileByUuid(req.params.uuid);
    if (!file || file.account_id !== req.activeAccount.id) {
      return res.status(404).send('Berkas tidak ditemukan.');
    }

    const versions = await fileService.getFileVersions(file.id);

    res.render('files/versions', {
      title: 'Riwayat Versi: ' + file.name,
      file,
      versions,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat riwayat versi: ' + err.message);
  }
});

// Pulihkan Versi Lama Menjadi Aktif
router.post('/file/:uuid/versions/:version_uuid/restore', async (req, res) => {
  try {
    const activeFile = await fileService.getFileByUuid(req.params.uuid);
    const versionToRestore = await fileService.getFileByUuid(req.params.version_uuid);
    
    if (!activeFile || !versionToRestore || activeFile.account_id !== req.activeAccount.id) {
      throw new Error('Berkas atau versi tidak ditemukan.');
    }

    // Lakukan swapping relasi agar versi lama menjadi active (parent_file_id = NULL)
    // dan activeFile saat ini terdorong menjadi versi riwayat dari berkas tersebut
    await db.query('UPDATE files SET parent_file_id = ?, folder_id = NULL WHERE id = ?', [versionToRestore.id, activeFile.id]);
    await db.query('UPDATE files SET parent_file_id = NULL, folder_id = ? WHERE id = ?', [activeFile.folder_id, versionToRestore.id]);
    await db.query('UPDATE files SET parent_file_id = ? WHERE parent_file_id = ? AND id != ?', [versionToRestore.id, activeFile.id, versionToRestore.id]);

    await auditService.log(req, 'RESTORE_VERSION', `Memulihkan berkas versi lama (ID: ${versionToRestore.id}) menjadi aktif menggantikan berkas (ID: ${activeFile.id}).`);
    res.redirect(`/drive/file/${versionToRestore.uuid}/versions`);
  } catch (err) {
    res.redirect('/drive?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
