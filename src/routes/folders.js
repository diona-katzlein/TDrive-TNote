'use strict';

const express = require('express');
const router = express.Router();

const fileService = require('../services/fileService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

// Buat folder
router.post('/', (req, res) => {
  const { name, parent_id } = req.body;
  const parentId = parent_id ? Number(parent_id) : null;
  if (name && name.trim()) {
    try {
      fileService.createFolder(req.activeAccount.id, parentId, name.trim());
    } catch (_) {
      /* nama duplikat — abaikan diam-diam untuk scaffold */
    }
  }
  res.redirect(parentId ? `/drive?folder=${parentId}` : '/drive');
});

// Rename folder (FR-12)
router.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const folder = fileService.getFolder(id);
  if (folder && folder.account_id === req.activeAccount.id && req.body.name && req.body.name.trim()) {
    try {
      fileService.renameFolder(id, req.body.name.trim());
    } catch (_) {
      /* nama duplikat pada level yang sama — abaikan */
    }
  }
  const parentId = folder ? folder.parent_id : null;
  res.redirect(parentId ? `/drive?folder=${parentId}` : '/drive');
});

// Hapus folder (cascade file & subfolder via FK)
router.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const folder = fileService.getFolder(id);
  const parentId = folder ? folder.parent_id : null;
  fileService.deleteFolder(id);
  res.redirect(parentId ? `/drive?folder=${parentId}` : '/drive');
});

module.exports = router;
