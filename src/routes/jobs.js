'use strict';

const express = require('express');
const router = express.Router();
const jobQueue = require('../services/jobQueue');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

router.get('/', async (req, res) => {
  try {
    res.render('jobs', {
      title: 'Background Jobs',
      jobs: await jobQueue.list(req.activeAccount.id),
      notice: req.query.notice || null,
      error: req.query.error || null,
      csrfToken: res.locals.csrfToken,
    });
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Job list failed`, error);
    res.status(500).send(`Gagal memuat job. ID referensi: ${req.id || 'tidak tersedia'}`);
  }
});

router.post('/:uuid/retry', async (req, res) => {
  const retried = await jobQueue.retry(req.params.uuid, req.activeAccount.id);
  res.redirect(`/jobs?${retried ? 'notice=Job dijadwalkan ulang.' : 'error=Job tidak dapat dijadwalkan ulang.'}`);
});

module.exports = router;
