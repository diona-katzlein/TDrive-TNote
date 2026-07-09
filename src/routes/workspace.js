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
const accountService = require('../services/accountService');
const { requireActiveAccount } = require('../middleware/activeAccount');

const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
const MAX_UPLOAD_MB = Number(process.env.TDRIVE_MAX_UPLOAD_MB) || 10240;
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

// 1. POST /workspace/share-workspace (Membagikan akses folder/catatan ke pengguna lain)
router.post('/share-workspace', async (req, res) => {
  const { item_type, item_uuid, target_phone, permission } = req.body;
  const redirectBack = req.body.redirect || '/drive';

  try {
    if (!target_phone) throw new Error('Nomor telepon rekan tujuan wajib diisi.');
    const normalizedTarget = accountService.normPhone(target_phone);

    let itemId = null;
    let titleForAudit = '';

    if (item_type === 'folder') {
      const folder = await fileService.getFolderByUuid(item_uuid);
      if (!folder || folder.account_id !== req.activeAccount.id) throw new Error('Folder tidak ditemukan.');
      itemId = folder.id;
      titleForAudit = folder.name;
    } else if (item_type === 'note') {
      const [rows] = await db.query('SELECT * FROM notes WHERE uuid = ?', [item_uuid]);
      const note = rows[0];
      if (!note || note.account_id !== req.activeAccount.id) throw new Error('Catatan tidak ditemukan.');
      itemId = note.id;
      titleForAudit = note.title;
    } else {
      throw new Error('Tipe item tidak valid untuk kolaborasi.');
    }

    const [existing] = await db.query(
      'SELECT id FROM shared_workspaces WHERE owner_account_id = ? AND target_phone = ? AND item_type = ? AND item_id = ?',
      [req.activeAccount.id, normalizedTarget, item_type, itemId]
    );
    if (existing.length > 0) {
      throw new Error('Nomor tersebut sudah terdaftar dalam kolaborasi item ini.');
    }

    await db.query(
      `INSERT INTO shared_workspaces (owner_account_id, target_phone, item_type, item_id, permission, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.activeAccount.id,
        normalizedTarget,
        item_type,
        itemId,
        permission || 'read',
        Date.now()
      ]
    );

    await auditService.log(req, 'SHARE_WORKSPACE', `Membagikan akses kolaborasi ${item_type}: ${titleForAudit} kepada ${normalizedTarget} (${permission})`);
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('Undangan kolaborasi berhasil dikirim!'));
  } catch (err) {
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
  }
});

// Hapus kolaborator
router.post('/revoke-workspace/:id', async (req, res) => {
  const { id } = req.params;
  const redirectBack = req.body.redirect || '/drive';
  try {
    await db.query('DELETE FROM shared_workspaces WHERE id = ? AND owner_account_id = ?', [id, req.activeAccount.id]);
    await auditService.log(req, 'REVOKE_WORKSPACE_COLLABORATOR', `Menghapus kolaborator workspace ID: ${id}`);
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('Akses kolaborasi berhasil dicabut.'));
  } catch (err) {
    res.redirect(redirectBack + (redirectBack.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
  }
});

// 2. GET /workspace/shared-with-me (Daftar item yang dibagikan dengan saya)
router.get('/shared-with-me', async (req, res) => {
  try {
    const phone = accountService.normPhone(req.session.userPhone);
    const [folders] = await db.query(
      `SELECT sw.id as workspace_id, sw.permission, f.*, a.phone as owner_phone 
       FROM shared_workspaces sw 
       INNER JOIN folders f ON sw.item_id = f.id 
       INNER JOIN accounts a ON sw.owner_account_id = a.id 
       WHERE sw.target_phone = ? AND sw.item_type = 'folder' AND f.deleted_at IS NULL`,
      [phone]
    );

    const [notes] = await db.query(
      `SELECT sw.id as workspace_id, sw.permission, n.uuid, n.title, n.category, n.updated_at, a.phone as owner_phone 
       FROM shared_workspaces sw 
       INNER JOIN notes n ON sw.item_id = n.id 
       INNER JOIN accounts a ON sw.owner_account_id = a.id 
       WHERE sw.target_phone = ? AND sw.item_type = 'note'`,
      [phone]
    );

    const [mySharedWorkspaces] = await db.query(
      `SELECT sw.id, sw.target_phone, sw.item_type, sw.permission,
              COALESCE(f.name, 'E2E Note') as item_name
       FROM shared_workspaces sw
       LEFT JOIN folders f ON sw.item_type = 'folder' AND sw.item_id = f.id
       WHERE sw.owner_account_id = ?`,
      [req.activeAccount.id]
    );

    res.render('files/shared-with-me', {
      title: 'Dibagikan dengan Saya',
      folders,
      notes,
      mySharedWorkspaces,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat halaman kolaborasi: ' + err.message);
  }
});

// 3. GET /workspace/folder/:uuid (Browsing subfolder kolaborasi milik orang lain)
router.get('/folder/:uuid', async (req, res) => {
  const { uuid } = req.params;
  try {
    const phone = accountService.normPhone(req.session.userPhone);
    const subfolder = await fileService.getFolderByUuid(uuid);
    if (!subfolder || subfolder.deleted_at !== null) return res.status(404).send('Folder tidak ditemukan.');

    let current = subfolder;
    let allowed = false;
    let permission = 'read';
    let rootFolder = null;

    while (current) {
      const [swRows] = await db.query(
        'SELECT * FROM shared_workspaces WHERE target_phone = ? AND item_type = \'folder\' AND item_id = ?',
        [phone, current.id]
      );
      if (swRows.length > 0) {
        allowed = true;
        permission = swRows[0].permission;
        rootFolder = current;
        break;
      }
      if (!current.parent_id) break;
      current = await fileService.getFolder(current.parent_id);
    }

    if (!allowed) {
      return res.status(403).send('Akses ditolak (bukan anggota kolaborasi folder ini).');
    }

    const [subfolders] = await db.query('SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL', [subfolder.id]);
    const [files] = await db.query('SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL AND parent_file_id IS NULL', [subfolder.id]);

    const ownerAccount = await fileService.getAccount(subfolder.account_id);

    let parentFolderUuid = null;
    if (subfolder.id !== rootFolder.id && subfolder.parent_id) {
      const parent = await fileService.getFolder(subfolder.parent_id);
      if (parent) parentFolderUuid = parent.uuid;
    }

    res.render('files/shared-folder', {
      title: 'Workspace: ' + subfolder.name,
      subfolder,
      rootFolder,
      subfolders,
      files,
      ownerAccount,
      permission,
      parentFolderUuid,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Kesalahan memuat folder kolaborasi: ' + err.message);
  }
});

// 4. POST /workspace/folder/:uuid/upload (Upload file kolaboratif)
router.post('/folder/:uuid/upload', upload.single('file'), async (req, res) => {
  const { uuid } = req.params;
  const tempPath = req.file && req.file.path;
  const phone = req.session.userPhone;
  
  try {
    if (!req.file) throw new Error('Tidak ada berkas yang diunggah.');
    const subfolder = await fileService.getFolderByUuid(uuid);
    if (!subfolder) throw new Error('Folder tidak ditemukan.');
    
    // Validasi write access
    let current = subfolder;
    let allowed = false;
    while (current) {
      const [swRows] = await db.query(
        'SELECT * FROM shared_workspaces WHERE target_phone = ? AND item_type = \'folder\' AND item_id = ?',
        [phone, current.id]
      );
      if (swRows.length > 0) {
        if (swRows[0].permission === 'write') allowed = true;
        break;
      }
      if (!current.parent_id) break;
      current = await fileService.getFolder(current.parent_id);
    }
    
    if (!allowed) throw new Error('Anda tidak memiliki hak akses tulis (write) di workspace ini.');
    
    const ownerAccount = await fileService.getAccount(subfolder.account_id);
    
    // Periksa nama duplikat di folder owner
    const existingFile = await fileService.findActiveFileByName(ownerAccount.id, subfolder.id, req.file.originalname);

    const uploadedFile = await storageService.uploadFile(ownerAccount, {
      tempPath,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      folderId: subfolder.id,
    });

    if (existingFile) {
      await db.query('UPDATE files SET parent_file_id = ?, folder_id = NULL WHERE id = ?', [uploadedFile.id, existingFile.id]);
      await db.query('UPDATE files SET parent_file_id = ? WHERE parent_file_id = ? AND id != ?', [uploadedFile.id, existingFile.id, uploadedFile.id]);
    }
    
    await auditService.log(req, 'WORKSPACE_UPLOAD_FILE', `Mengunggah berkas kolaborasi "${req.file.originalname}" ke akun ${ownerAccount.phone} (File UUID: ${uploadedFile.uuid})`);
    res.redirect(`/workspace/folder/${uuid}`);
  } catch (err) {
    res.redirect(`/workspace/folder/${uuid}?error=${encodeURIComponent(err.message)}`);
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
});

// 5. POST /workspace/folder/:uuid/create-folder (Membuat folder kolaboratif)
router.post('/folder/:uuid/create-folder', async (req, res) => {
  const { uuid } = req.params;
  const { name } = req.body;
  const phone = req.session.userPhone;
  
  try {
    if (!name || !name.trim()) throw new Error('Nama folder tidak boleh kosong.');
    const subfolder = await fileService.getFolderByUuid(uuid);
    if (!subfolder) throw new Error('Folder tidak ditemukan.');
    
    // Validasi write access
    let current = subfolder;
    let allowed = false;
    while (current) {
      const [swRows] = await db.query(
        'SELECT * FROM shared_workspaces WHERE target_phone = ? AND item_type = \'folder\' AND item_id = ?',
        [phone, current.id]
      );
      if (swRows.length > 0) {
        if (swRows[0].permission === 'write') allowed = true;
        break;
      }
      if (!current.parent_id) break;
      current = await fileService.getFolder(current.parent_id);
    }
    
    if (!allowed) throw new Error('Akses tulis ditolak.');
    
    const newFolder = await fileService.createFolder(subfolder.account_id, subfolder.id, name.trim());
    await auditService.log(req, 'WORKSPACE_CREATE_FOLDER', `Membuat folder kolaborasi baru "${name.trim()}" (UUID: ${newFolder.uuid})`);
    
    res.redirect(`/workspace/folder/${uuid}`);
  } catch (err) {
    res.redirect(`/workspace/folder/${uuid}?error=${encodeURIComponent(err.message)}`);
  }
});

// 6. GET /workspace/file/:file_uuid/download (Unduh file kolaboratif)
router.get('/file/:file_uuid/download', async (req, res) => {
  const { file_uuid } = req.params;
  const phone = req.session.userPhone;
  
  try {
    const file = await fileService.getFileByUuid(file_uuid);
    if (!file) return res.status(404).send('Berkas tidak ditemukan.');
    
    let belongs = false;
    if (file.folder_id) {
      let current = await fileService.getFolder(file.folder_id);
      while (current) {
        const [swRows] = await db.query(
          'SELECT * FROM shared_workspaces WHERE target_phone = ? AND item_type = \'folder\' AND item_id = ?',
          [phone, current.id]
        );
        if (swRows.length > 0) {
          belongs = true;
          break;
        }
        if (!current.parent_id) break;
        current = await fileService.getFolder(current.parent_id);
      }
    }
    
    if (!belongs) return res.status(403).send('Akses ditolak.');
    
    const ownerAccount = await fileService.getAccount(file.account_id);
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    
    await auditService.log(req, 'WORKSPACE_DOWNLOAD_FILE', `Mengunduh berkas kolaborasi: ${file.name} (UUID: ${file.uuid})`);
    await storageService.downloadToStream(ownerAccount, file, res);
    res.end();
  } catch (err) {
    res.status(500).send('Gagal mengunduh: ' + err.message);
  }
});

// 7. POST /workspace/folder/:uuid/delete-file/:file_uuid (Hapus file kolaboratif)
router.post('/folder/:uuid/delete-file/:file_uuid', async (req, res) => {
  const { uuid, file_uuid } = req.params;
  const phone = req.session.userPhone;
  
  try {
    const file = await fileService.getFileByUuid(file_uuid);
    if (!file) throw new Error('Berkas tidak ditemukan.');
    
    const subfolder = await fileService.getFolderByUuid(uuid);
    let current = subfolder;
    let allowed = false;
    while (current) {
      const [swRows] = await db.query(
        'SELECT * FROM shared_workspaces WHERE target_phone = ? AND item_type = \'folder\' AND item_id = ?',
        [phone, current.id]
      );
      if (swRows.length > 0) {
        if (swRows[0].permission === 'write') allowed = true;
        break;
      }
      if (!current.parent_id) break;
      current = await fileService.getFolder(current.parent_id);
    }
    
    if (!allowed) throw new Error('Akses tulis ditolak.');
    
    // Lakukan soft delete ke tempat sampah akun pemilik
    await fileService.softDeleteFile(file.id);
    
    await auditService.log(req, 'WORKSPACE_DELETE_FILE', `Menghapus berkas kolaborasi (soft-delete): "${file.name}" (UUID: ${file.uuid})`);
    res.redirect(`/workspace/folder/${uuid}`);
  } catch (err) {
    res.redirect(`/workspace/folder/${uuid}?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
