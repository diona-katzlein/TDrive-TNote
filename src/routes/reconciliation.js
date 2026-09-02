'use strict';

const express = require('express');
const router = express.Router();

const auditService = require('../services/auditService');
const reconciliationService = require('../services/reconciliationService');
const jobQueue = require('../services/jobQueue');
const { requireAdmin } = require('../middleware/restrictAccess');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireAdmin);
router.use(requireActiveAccount);

router.get('/', async (req, res) => {
  try {
    const runs = await reconciliationService.listRuns(req.activeAccount.id);
    res.render('reconciliation', {
      title: 'Rekonsiliasi Penyimpanan',
      runs,
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Gagal memuat rekonsiliasi`, error);
    res.status(500).send(`Gagal memuat rekonsiliasi. ID referensi: ${req.id || 'tidak tersedia'}`);
  }
});

router.post('/run', async (req, res) => {
  try {
    const jobUuid = await jobQueue.enqueue(
      'storage.reconcile',
      {
        accountId: req.activeAccount.id,
        maxFiles: req.body.max_files,
        verifyRemote: req.body.verify_remote === '1',
        repairMissingHashes: req.body.repair_missing_hashes === '1',
        repairBrokenEvidence: req.body.repair_broken_evidence === '1',
      },
      { accountId: req.activeAccount.id, maxAttempts: 3 }
    );
    await auditService.log(
      req,
      'STORAGE_RECONCILIATION_QUEUED',
      `Menjadwalkan rekonsiliasi akun ${req.activeAccount.id} (Job UUID: ${jobUuid}).`
    );
    res.redirect('/reconciliation?notice=' + encodeURIComponent(`Rekonsiliasi dijadwalkan. Job: ${jobUuid}`));
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Penjadwalan rekonsiliasi gagal`, error);
    res.redirect('/reconciliation?error=' + encodeURIComponent(`Rekonsiliasi gagal dijadwalkan. ID referensi: ${req.id || 'tidak tersedia'}`));
  }
});

module.exports = router;
