'use strict';

const db = require('../db');
const backupService = require('./backupService');
const fileService = require('./fileService');
const jobQueue = require('./jobQueue');
const reconciliationService = require('./reconciliationService');
const storageService = require('./storageService');

async function accountFor(payload) {
  const account = await fileService.getAccount(Number(payload.accountId));
  if (!account) throw new Error('Account no longer exists.');
  return account;
}

function registerJobHandlers() {
  jobQueue.register('backup.create', async (payload, context) => {
    await context.progress(10);
    const result = await backupService.createBackup(payload.triggerType || 'queued');
    await context.progress(95, { filename: result.filename });
    return result;
  });

  jobQueue.register('storage.verify', async (payload, context) => {
    const account = await accountFor(payload);
    const file = await fileService.getFile(Number(payload.fileId));
    if (!file || Number(file.account_id) !== Number(account.id)) return { skipped: 'file_missing' };
    await context.progress(10);
    const result = await storageService.verifyIntegrity(account, file);
    if (!file.sha256 && result.size === Number(file.size)) {
      await db.query('UPDATE files SET sha256 = ?, updated_at = ? WHERE id = ? AND account_id = ? AND sha256 IS NULL', [result.actual, Date.now(), file.id, account.id]);
    }
    if (!result.ok) throw new Error('Remote file integrity mismatch.');
    return result;
  });

  jobQueue.register('storage.delete-file', async (payload, context) => {
    const account = await accountFor(payload);
    const file = await fileService.getFile(Number(payload.fileId));
    if (!file || Number(file.account_id) !== Number(account.id)) return { skipped: 'file_missing' };
    await context.progress(20);
    await storageService.deleteRemote(account, file);
    await context.progress(80);
    await db.query("DELETE FROM shares WHERE item_type = 'file' AND item_id = ?", [file.id]);
    await fileService.deleteFile(file.id);
    return { deleted: file.uuid };
  });

  jobQueue.register('storage.delete-note-message', async (payload) => {
    const account = await accountFor(payload);
    if (!payload.messageId) return { skipped: 'message_missing' };
    await storageService.deleteNoteMessage(account, Number(payload.messageId), payload.peer || null);
    return { deleted: Number(payload.messageId) };
  });

  jobQueue.register('storage.reconcile', async (payload, context) => {
    const account = await accountFor(payload);
    await context.progress(5);
    return reconciliationService.reconcileAccount(account, {
      maxFiles: payload.maxFiles,
      verifyRemote: payload.verifyRemote !== false,
      repairMissingHashes: payload.repairMissingHashes === true,
      repairBrokenEvidence: payload.repairBrokenEvidence === true,
    });
  });
}

module.exports = { registerJobHandlers };
