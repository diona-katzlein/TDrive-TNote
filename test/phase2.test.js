'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRestoreAllowed,
  csvCell,
  validBackupFilename,
  validMonth,
} = require('../src/services/phase2Validation');

test('TKinerja export accepts only canonical year and month segments', () => {
  assert.equal(validMonth('2026', '01'), true);
  assert.equal(validMonth('2026', '12'), true);
  assert.equal(validMonth('26', '01'), false);
  assert.equal(validMonth('2026', '1'), false);
  assert.equal(validMonth('2026', '00'), false);
  assert.equal(validMonth('2026', '13'), false);
  assert.equal(validMonth('2026 OR 1=1', '01'), false);
});

test('Excel-compatible CSV cells neutralize formulas and preserve quoting', () => {
  assert.equal(csvCell('normal'), '"normal"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('line one\nline two'), '"line one line two"');
  assert.equal(csvCell('=HYPERLINK("https://example.invalid")'), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(csvCell('+1+1'), '"\'+1+1"');
  assert.equal(csvCell('-1+1'), '"\'-1+1"');
  assert.equal(csvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
  assert.equal(csvCell(null), '""');
});

test('backup artifact names reject traversal and unexpected extensions', () => {
  assert.equal(validBackupFilename('tdrive_backup_2026-09-02.sql.enc'), true);
  assert.equal(validBackupFilename('tdrive_backup_manual_123.sql.enc'), true);
  assert.equal(validBackupFilename('../tdrive_backup_2026.sql.enc'), false);
  assert.equal(validBackupFilename('tdrive_backup_2026.sql'), false);
  assert.equal(validBackupFilename('other_backup_2026.sql.enc'), false);
});

test('production restore requires both environment enablement and exact database confirmation', () => {
  assert.doesNotThrow(() => assertRestoreAllowed('true', 'tdriveprod', 'tdriveprod'));
  assert.throws(
    () => assertRestoreAllowed('false', 'tdriveprod', 'tdriveprod'),
    /restore is disabled/i
  );
  assert.throws(
    () => assertRestoreAllowed('true', 'tdrive', 'tdriveprod'),
    /confirmation does not match/i
  );
  assert.throws(
    () => assertRestoreAllowed('TRUE', 'tdriveprod', 'tdriveprod'),
    /restore is disabled/i
  );
});
