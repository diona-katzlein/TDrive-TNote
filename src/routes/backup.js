'use strict';

const express = require('express');
const fs = require('fs');
const router = express.Router();

const auditService = require('../services/auditService');
const backupService = require('../services/backupService');
const jobQueue = require('../services/jobQueue');
const { requireAdmin } = require('../middleware/restrictAccess');

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    const config = backupService.getDbConfig();
    res.render('backup', {
      title: 'Backup Database',
      backups,
      dbConfig: {
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        encrypted: true,
        scheduleEnabled: process.env.BACKUP_SCHEDULE_ENABLED === 'true',
        intervalHours: Number(process.env.BACKUP_INTERVAL_HOURS || 24),
        retentionCount: Number(process.env.BACKUP_RETENTION_COUNT || 14),
        secondaryEnabled: Boolean(process.env.BACKUP_SECONDARY_DIR),
        restoreEnabled: process.env.BACKUP_RESTORE_ENABLED === 'true',
      },
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Gagal memuat halaman backup`, err);
    res.status(500).send(`Gagal memuat halaman backup. ID referensi: ${req.id || 'tidak tersedia'}`);
  }
});

router.post('/create', async (req, res) => {
  try {
    const jobUuid = await jobQueue.enqueue('backup.create', { triggerType: 'manual' });
    await auditService.log(req, 'DATABASE_BACKUP_QUEUED', `Menjadwalkan backup database terenkripsi (Job UUID: ${jobUuid})`);
    res.redirect('/backup?notice=' + encodeURIComponent(`Backup terenkripsi dijadwalkan. Job: ${jobUuid}`));
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Penjadwalan backup manual gagal`, err);
    res.redirect('/backup?error=' + encodeURIComponent(`Backup gagal dijadwalkan. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

router.post('/verify/:filename', async (req, res) => {
  const filePath = backupService.resolveBackupPath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.redirect('/backup?error=' + encodeURIComponent('File backup tidak ditemukan.'));
  }
  try {
    await backupService.verifyBackup(filePath);
    await auditService.log(req, 'VERIFY_DATABASE_BACKUP', `Memverifikasi backup terenkripsi: ${req.params.filename}`);
    return res.redirect('/backup?notice=' + encodeURIComponent(`Backup berhasil didekripsi dan diverifikasi: ${req.params.filename}`));
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Verifikasi backup gagal`, err);
    return res.redirect('/backup?error=' + encodeURIComponent(`Verifikasi backup gagal. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

router.post('/simulate/:filename', async (req, res) => {
  try {
    const result = await backupService.simulateRestore(req.params.filename);
    await auditService.log(req, 'SIMULATE_DATABASE_RESTORE', `Simulasi restore berhasil untuk ${req.params.filename}: ${result.tables} tabel.`);
    return res.redirect('/backup?notice=' + encodeURIComponent(`Simulasi restore berhasil: ${result.tables} tabel berhasil diimpor ke database terisolasi lalu dibersihkan.`));
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Simulasi restore gagal`, err);
    return res.redirect('/backup?error=' + encodeURIComponent(`Simulasi restore gagal. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

router.post('/restore/:filename', async (req, res) => {
  try {
    await backupService.restoreBackup(req.params.filename, String(req.body.database_confirmation || ''));
    await auditService.log(req, 'RESTORE_DATABASE', `Restore database dari backup terenkripsi: ${req.params.filename}`);
    return res.redirect('/backup?notice=' + encodeURIComponent('Restore database selesai. Restart aplikasi dan lakukan pemeriksaan integritas.'));
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Restore database gagal`, err);
    return res.redirect('/backup?error=' + encodeURIComponent(`Restore database ditolak atau gagal. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

router.get('/download/:filename', (req, res) => {
  const filePath = backupService.resolveBackupPath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File backup tidak ditemukan.');
  res.download(filePath, req.params.filename);
});

router.post('/delete/:filename', async (req, res) => {
  try {
    await backupService.removeBackup(req.params.filename);
    await auditService.log(req, 'DELETE_BACKUP', `Menghapus file backup terenkripsi: ${req.params.filename}`);
    res.redirect('/backup?notice=' + encodeURIComponent(`Backup "${req.params.filename}" berhasil dihapus.`));
  } catch (err) {
    console.error(`[${req.id || 'no-request-id'}] Penghapusan backup gagal`, err);
    res.redirect('/backup?error=' + encodeURIComponent(`Gagal menghapus backup. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

module.exports = router;
