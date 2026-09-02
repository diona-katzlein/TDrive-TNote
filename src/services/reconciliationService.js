'use strict';

const db = require('../db');
const storageService = require('./storageService');

let running = false;

function publicError(error) {
  const message = String(error && error.message || 'Unknown reconciliation error');
  if (/Pesan chunk hilang/i.test(message)) return 'Telegram message or media is missing.';
  return 'Telegram verification failed.';
}

function inspectMetadata(file, chunks) {
  const issues = [];
  if (!chunks.length) issues.push({ code: 'NO_CHUNKS', detail: 'File has no chunk mapping.' });

  let expectedIndex = 0;
  let mappedSize = 0;
  for (const chunk of chunks) {
    if (Number(chunk.part_index) !== expectedIndex) {
      issues.push({ code: 'CHUNK_ORDER', detail: `Expected part ${expectedIndex}, found ${chunk.part_index}.` });
      expectedIndex = Number(chunk.part_index);
    }
    expectedIndex += 1;
    mappedSize += Number(chunk.size || 0);
  }
  if (mappedSize !== Number(file.size)) {
    issues.push({ code: 'MAPPED_SIZE', detail: `Mapped size ${mappedSize} differs from file size ${file.size}.` });
  }
  const shouldBeChunked = chunks.length > 1 ? 1 : 0;
  if (Number(file.is_chunked) !== shouldBeChunked) {
    issues.push({ code: 'CHUNK_FLAG', detail: `is_chunked=${file.is_chunked}, expected ${shouldBeChunked}.` });
  }
  return issues;
}

async function createRun(accountId) {
  const [result] = await db.query(
    `INSERT INTO reconciliation_runs
      (account_id, status, files_checked, chunks_checked, issues_found, created_at)
     VALUES (?, 'running', 0, 0, 0, ?)`,
    [accountId, Date.now()]
  );
  return result.insertId;
}

async function completeRun(id, status, counters, details) {
  await db.query(
    `UPDATE reconciliation_runs
       SET status = ?, files_checked = ?, chunks_checked = ?, issues_found = ?,
           details = ?, completed_at = ?
     WHERE id = ?`,
    [status, counters.files, counters.chunks, counters.issues, JSON.stringify(details), Date.now(), id]
  );
}

async function reconcileAccount(account, options = {}) {
  if (running) throw new Error('A reconciliation process is already running.');
  running = true;
  const runId = await createRun(account.id);
  const counters = { files: 0, chunks: 0, issues: 0 };
  const details = [];
  const maxFiles = Math.max(1, Math.min(Number(options.maxFiles || process.env.RECONCILIATION_MAX_FILES || 100), 1000));
  const verifyRemote = options.verifyRemote !== false;
  const repairMissingHashes = options.repairMissingHashes === true;
  const repairBrokenEvidence = options.repairBrokenEvidence === true;

  try {
    const [files] = await db.query(
      `SELECT * FROM files
       WHERE account_id = ? AND deleted_at IS NULL AND parent_file_id IS NULL
       ORDER BY id ASC LIMIT ?`,
      [account.id, maxFiles]
    );

    for (const file of files) {
      const [chunks] = await db.query(
        'SELECT * FROM file_chunks WHERE file_id = ? ORDER BY part_index ASC',
        [file.id]
      );
      counters.files += 1;
      counters.chunks += chunks.length;
      const issues = inspectMetadata(file, chunks);
      let remote = null;
      let repaired = false;

      if (verifyRemote && chunks.length && !issues.some((issue) => issue.code === 'MAPPED_SIZE')) {
        try {
          remote = await storageService.verifyIntegrity(account, file);
          if (remote.size !== Number(file.size)) {
            issues.push({ code: 'REMOTE_SIZE', detail: `Telegram size ${remote.size} differs from file size ${file.size}.` });
          } else if (file.sha256 && !remote.ok) {
            issues.push({ code: 'HASH_MISMATCH', detail: 'Telegram content hash differs from database metadata.' });
          } else if (!file.sha256) {
            issues.push({ code: 'MISSING_HASH', detail: 'Database SHA-256 metadata is missing.' });
            if (repairMissingHashes) {
              await db.query('UPDATE files SET sha256 = ?, updated_at = ? WHERE id = ? AND account_id = ? AND sha256 IS NULL', [remote.actual, Date.now(), file.id, account.id]);
              repaired = true;
              issues.splice(issues.findIndex((issue) => issue.code === 'MISSING_HASH'), 1);
            }
          }
        } catch (error) {
          issues.push({ code: 'REMOTE_UNAVAILABLE', detail: publicError(error) });
        }
      }

      counters.issues += issues.length;
      if (issues.length || repaired) {
        details.push({
          fileId: file.id,
          uuid: file.uuid,
          name: file.name,
          issues,
          repaired: repaired ? ['MISSING_HASH'] : [],
        });
      }
    }

    const [brokenEvidence] = await db.query(
      `SELECT ke.id, ke.report_id, ke.file_id,
              CASE WHEN f.id IS NULL THEN 'FILE_MISSING' ELSE 'CROSS_ACCOUNT_FILE' END AS reason
       FROM kinerja_evidence ke
       INNER JOIN kinerja_reports kr ON kr.id = ke.report_id
       LEFT JOIN files f ON f.id = ke.file_id
       WHERE kr.account_id = ? AND (f.id IS NULL OR f.account_id <> kr.account_id)`,
      [account.id]
    );
    for (const evidence of brokenEvidence) {
      const repaired = [];
      if (repairBrokenEvidence) {
        await db.query(
          `DELETE ke FROM kinerja_evidence ke
           INNER JOIN kinerja_reports kr ON kr.id = ke.report_id
           WHERE ke.id = ? AND kr.account_id = ?`,
          [evidence.id, account.id]
        );
        repaired.push('BROKEN_EVIDENCE_REMOVED');
      }
      counters.issues += repairBrokenEvidence ? 0 : 1;
      details.push({
        code: 'BROKEN_EVIDENCE',
        detail: `Evidence junction ${evidence.id} references ${evidence.reason.toLowerCase()}.`,
        evidenceId: evidence.id,
        reportId: evidence.report_id,
        fileId: evidence.file_id,
        repaired,
      });
    }

    const staleCutoff = Date.now() - Math.max(5, Number(process.env.UPLOAD_STALE_MINUTES || 60)) * 60 * 1000;
    const [incompleteUploads] = await db.query(
      `SELECT upload_id, filename, received_chunks, total_chunks, status, updated_at, error_message
       FROM upload_sessions
       WHERE account_id = ? AND status IN ('receiving', 'failed')
         AND (status = 'failed' OR updated_at < ?)
       ORDER BY updated_at ASC LIMIT 200`,
      [account.id, staleCutoff]
    );
    for (const upload of incompleteUploads) {
      counters.issues += 1;
      details.push({
        code: 'INCOMPLETE_UPLOAD',
        detail: `${upload.filename}: ${upload.received_chunks}/${upload.total_chunks} chunks (${upload.status}).`,
        uploadId: upload.upload_id,
        error: upload.error_message || null,
      });
    }

    await completeRun(runId, counters.issues ? 'issues_found' : 'success', counters, details);
    return { id: runId, status: counters.issues ? 'issues_found' : 'success', ...counters, details };
  } catch (error) {
    details.push({ code: 'RUN_FAILED', detail: publicError(error) });
    await completeRun(runId, 'failed', counters, details);
    throw error;
  } finally {
    running = false;
  }
}

async function listRuns(accountId, limit = 20) {
  const [rows] = await db.query(
    `SELECT * FROM reconciliation_runs
     WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
    [accountId, Math.max(1, Math.min(Number(limit), 100))]
  );
  return rows.map((row) => {
    let details = [];
    try { details = JSON.parse(row.details || '[]'); } catch (_) { details = []; }
    return { ...row, details };
  });
}

module.exports = { inspectMetadata, listRuns, reconcileAccount };
