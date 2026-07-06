'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');
const { requireActiveAccount } = require('../middleware/activeAccount');
const { requireAdmin } = require('../middleware/restrictAccess');

// Gunakan requireAdmin agar hanya admin/pemilik terdaftar yang bisa masuk
router.use(requireActiveAccount);
router.use(requireAdmin);

// Tampilkan log audit trail global
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    
    let logs;
    if (q) {
      const [rows] = await db.query(
        'SELECT * FROM audit_logs WHERE user_phone LIKE ? OR action LIKE ? OR details LIKE ? OR ip_address LIKE ? ORDER BY created_at DESC LIMIT 200',
        [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
      );
      logs = rows;
    } else {
      const [rows] = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
      logs = rows;
    }

    res.render('audit/logs', {
      title: 'Global Audit Trail Logs',
      logs,
      query: q,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    res.status(500).send('Gagal memuat log audit: ' + err.message);
  }
});

module.exports = router;
