'use strict';

const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');
const { requireActiveAccount } = require('../middleware/activeAccount');

router.use(requireActiveAccount);

router.get('/', async (req, res) => {
  const notifications = await notificationService.list(req.activeAccount.id, req.session.userPhone);
  res.render('notifications', {
    title: 'Notifikasi', notifications, csrfToken: res.locals.csrfToken,
  });
});

router.post('/:id/read', async (req, res) => {
  await notificationService.markRead(Number(req.params.id), req.activeAccount.id, req.session.userPhone);
  res.redirect('/notifications');
});

router.post('/read-all', async (req, res) => {
  await notificationService.markAllRead(req.activeAccount.id, req.session.userPhone);
  res.redirect('/notifications');
});

module.exports = router;
