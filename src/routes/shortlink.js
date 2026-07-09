'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const auditService = require('../services/auditService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

// Generator short code acak
function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// GET /shortlink - List TShort links
router.get('/', async (req, res) => {
  try {
    const [links] = await db.query(
      'SELECT * FROM shortlinks WHERE account_id = ? ORDER BY created_at DESC',
      [req.activeAccount.id]
    );

    res.render('shortlinks/list', {
      title: 'TShort · Penyingkat Tautan',
      links,
      domain: req.protocol + '://' + req.get('host'),
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    res.status(500).send('Gagal memuat shortlink: ' + err.message);
  }
});

// POST /shortlink - Buat shortlink baru
router.post('/', async (req, res) => {
  const { original_url, custom_code } = req.body;
  try {
    if (!original_url) throw new Error('Tautan asli wajib diisi.');
    
    let code = (custom_code || '').trim();
    if (code) {
      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(code)) {
        throw new Error('Custom code hanya boleh berisi alfanumerik, dash (-), dan underscore (_), panjang 3-20 karakter.');
      }
      const [existing] = await db.query('SELECT id FROM shortlinks WHERE short_code = ?', [code]);
      if (existing.length > 0) {
        throw new Error('Custom code tersebut sudah digunakan oleh pengguna lain.');
      }
    } else {
      // Loop untuk memastikan code unik
      let attempt = 0;
      while (attempt < 5) {
        code = generateShortCode();
        const [existing] = await db.query('SELECT id FROM shortlinks WHERE short_code = ?', [code]);
        if (existing.length === 0) break;
        attempt++;
      }
    }

    await db.query(
      'INSERT INTO shortlinks (account_id, short_code, original_url, clicks, created_at) VALUES (?, ?, ?, 0, ?)',
      [req.activeAccount.id, code, original_url, Date.now()]
    );

    await auditService.log(req, 'CREATE_SHORTLINK', `Membuat shortlink: /s/${code} -> ${original_url}`);
    res.redirect('/shortlink?notice=' + encodeURIComponent('Shortlink berhasil dibuat!'));
  } catch (err) {
    res.redirect('/shortlink?error=' + encodeURIComponent(err.message));
  }
});

// POST /shortlink/:id/delete - Hapus shortlink
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    const [links] = await db.query('SELECT * FROM shortlinks WHERE id = ? AND account_id = ?', [id, req.activeAccount.id]);
    const link = links[0];
    if (!link) throw new Error('Shortlink tidak ditemukan.');

    await db.query('DELETE FROM shortlinks WHERE id = ?', [id]);
    await auditService.log(req, 'DELETE_SHORTLINK', `Menghapus shortlink /s/${link.short_code}`);
    res.redirect('/shortlink?notice=' + encodeURIComponent('Shortlink berhasil dihapus.'));
  } catch (err) {
    res.redirect('/shortlink?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
