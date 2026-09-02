'use strict';

const express = require('express');
const router = express.Router();
const healthService = require('../services/healthService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);
router.get('/', async (req, res) => {
  try {
    const health = await healthService.dashboard(req.activeAccount);
    await healthService.notifyProblems(req.activeAccount, health).catch(() => {});
    res.render('health', { title: 'Storage Health', health, csrfToken: res.locals.csrfToken });
  } catch (error) {
    console.error(`[${req.id || 'no-request-id'}] Health dashboard failed`, error);
    res.status(500).send(`Dashboard gagal dimuat. ID referensi: ${req.id || 'tidak tersedia'}`);
  }
});
module.exports = router;
