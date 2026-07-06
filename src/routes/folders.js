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

// Hapus folder (cascade file & subfolder via FK - IDOR-safe menggunakan UUID)
router.post('/:uuid/delete', async (req, res) => {
  const { uuid } = req.params;
  
  try {
    const folder = await fileService.getFolderByUuid(uuid);
    if (!folder || folder.account_id !== req.activeAccount.id) {
      throw new Error('Folder tidak ditemukan.');
    }

    // Ambil detail folder induk sebelum menghapus untuk redirect
    let parentFolderUuid = null;
    if (folder.parent_id) {
      const parent = await fileService.getFolder(folder.parent_id);
      if (parent) parentFolderUuid = parent.uuid;
    }

    // Fungsi rekursif untuk menghapus file di Telegram sebelum folder dihapus di DB
    async function deleteFolderContents(fId) {
      // Hapus berkas di folder ini
      const files = await fileService.listFiles(req.activeAccount.id, fId);
      for (const file of files) {
        try {
          await storageService.deleteRemote(req.activeAccount, file);
        } catch (_) {}
        // Hapus share link terkait berkas
        await db.query("DELETE FROM shares WHERE item_type = 'file' AND item_id = ?", [file.id]);
      }

      // Cari subfolder dan lakukan rekursi
      const subfolders = await fileService.listFolders(req.activeAccount.id, fId);
      for (const sf of subfolders) {
        await deleteFolderContents(sf.id);
        // Hapus share link terkait subfolder
        await db.query("DELETE FROM shares WHERE item_type = 'folder' AND item_id = ?", [sf.id]);
      }
    }

    // Mulai proses penghapusan isi folder secara remote
    await deleteFolderContents(folder.id);

    // Hapus share link terkait folder utama ini
    await db.query("DELETE FROM shares WHERE item_type = 'folder' AND item_id = ?", [folder.id]);

    // Hapus folder dari database (ini akan memicu delete cascade pada files & subfolders di DB)
    await fileService.deleteFolder(folder.id);

    await auditService.log(req, 'DELETE_FOLDER', `Menghapus folder dan seluruh isinya: "${folder.name}" (UUID: ${folder.uuid})`);

    const redirectPath = parentFolderUuid ? `/drive/folder/${parentFolderUuid}` : '/drive';
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send('Gagal menghapus folder: ' + err.message);
  }
});

module.exports = router;
