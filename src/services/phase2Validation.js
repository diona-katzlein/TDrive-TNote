'use strict';

function validMonth(year, month) {
  return /^\d{4}$/.test(String(year)) && /^(0[1-9]|1[0-2])$/.test(String(month));
}

function csvCell(value) {
  let text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function validBackupFilename(filename) {
  return /^tdrive_backup_[\w-]+\.sql\.enc$/.test(filename || '');
}

function assertRestoreAllowed(enabled, confirmation, database) {
  if (enabled !== 'true') throw new Error('Database restore is disabled.');
  if (confirmation !== database) throw new Error('Database confirmation does not match.');
}

module.exports = {
  assertRestoreAllowed,
  csvCell,
  validBackupFilename,
  validMonth,
};
