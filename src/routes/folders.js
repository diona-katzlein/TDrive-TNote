'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');
const fileService = require('../services/fileService');
const auditService = require('../services/auditService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

// Buat folder baru (IDOR-safe)
router.post('/', async (req, res) => {
  const { name, parent_uuid } = req.body;
  
  try {
    let parentId = null;
    if (parent_uuid) {
      const parentFolder = await fileService.getFolderByUuid(parent_uuid);
      if (!parentFolder || parentFolder.account_id !== req.activeAccount.id) {
        throw new Error('Folder induk tidak ditemukan.');
      }
      parentId = parentFolder.id;
    }

    if (name && name.trim()) {
      const newFolder = await fileService.createFolder(req.activeAccount.id, parentId, name.trim());
      await auditService.log(req, 'CREATE_FOLDER', `Membuat folder baru: "${name.trim()}" (Folder UUID: ${newFolder.uuid})`);
    }

    const redirectPath = parent_uuid ? `/drive/folder/${parent_uuid}` : '/drive';
    res.redirect(redirectPath);
  } catch (err) {
    const back = parent_uuid ? `/drive/folder/${parent_uuid}` : '/drive';
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  }
});

// Rename folder (IDOR-safe menggunakan UUID)
router.post('/:uuid/rename', async (req, res) => {
  const { uuid } = req.params;
  const newName = (req.body.name || '').trim();
  
  try {
    const folder = await fileService.getFolderByUuid(uuid);
    if (!folder || folder.account_id !== req.activeAccount.id) {
      throw new Error('Folder tidak ditemukan.');
    }
    if (!newName) throw new Error('Nama folder tidak boleh kosong.');

    const oldName = folder.name;
    await fileService.renameFolder(folder.id, newName);

    await auditService.log(req, 'RENAME_FOLDER', `Mengubah nama folder dari "${oldName}" menjadi "${newName}" (Folder UUID: ${folder.uuid})`);

    let redirectPath = '/drive';
    if (folder.parent_id) {
      const parent = await fileService.getFolder(folder.parent_id);
      if (parent) redirectPath = `/drive/folder/${parent.uuid}`;
    }
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Gagal mengubah nama folder: ' + err.message);
  }
});

// Soft Delete Folder (Masuk Keranjang Sampah)
router.post('/:uuid/delete', async (req, res) => {
  const { uuid } = req.params;
  
  try {
    const folder = await fileService.getFolderByUuid(uuid);
    if (!folder || folder.account_id !== req.activeAccount.id) {
      throw new Error('Folder tidak ditemukan.');
    }

    // Fungsi rekursif untuk soft-delete isi folder
    async function softDeleteFolderContents(fId) {
      // Soft-delete files
      await db.query('UPDATE files SET deleted_at = ? WHERE folder_id = ? AND deleted_at IS NULL', [Date.now(), fId]);
      
      // Ambil subfolder
      const [subfolders] = await db.query('SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL', [fId]);
      for (const sf of subfolders) {
        await softDeleteFolderContents(sf.id);
        await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [Date.now(), sf.id]);
      }
    }

    await softDeleteFolderContents(folder.id);
    await fileService.softDeleteFolder(folder.id);

    await auditService.log(req, 'DELETE_FOLDER_SOFT', `Memindahkan folder ke keranjang sampah: "${folder.name}" (UUID: ${folder.uuid})`);

    let redirectPath = '/drive';
    if (folder.parent_id) {
      const parent = await fileService.getFolder(folder.parent_id);
      if (parent) redirectPath = `/drive/folder/${parent.uuid}`;
    }
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Gagal menghapus folder: ' + err.message);
  }
});

// Restore Folder
router.post('/:uuid/restore', async (req, res) => {
  const { uuid } = req.params;
  
  try {
    const folder = await fileService.getFolderByUuid(uuid);
    if (!folder || folder.account_id !== req.activeAccount.id) {
      throw new Error('Folder tidak ditemukan.');
    }

    // Fungsi rekursif untuk restore isi folder
    async function restoreFolderContents(fId) {
      await db.query('UPDATE files SET deleted_at = NULL WHERE folder_id = ?', [fId]);
      
      const [subfolders] = await db.query('SELECT * FROM folders WHERE parent_id = ?', [fId]);
      for (const sf of subfolders) {
        await restoreFolderContents(sf.id);
        await db.query('UPDATE folders SET deleted_at = NULL WHERE id = ?', [sf.id]);
      }
    }

    await restoreFolderContents(folder.id);
    await fileService.restoreFolder(folder.id);

    await auditService.log(req, 'RESTORE_FOLDER', `Memulihkan folder "${folder.name}" dari tempat sampah.`);
    res.redirect('/drive/trash?notice=' + encodeURIComponent('Folder berhasil dipulihkan.'));
  } catch (err) {
    res.redirect('/drive/trash?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
