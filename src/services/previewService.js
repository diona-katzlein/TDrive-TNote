'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { once } = require('events');

const OFFICE = {
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const NATIVE = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
};
const MAX_DOCUMENT = 32 * 1024 * 1024;
const MAX_PDF = 64 * 1024 * 1024;
const MAX_ACTIVE = 4;
const DEADLINE_MS = 120000;
let active = 0;

function classify(file) {
  const ext = path.extname(String(file.name || '')).slice(1).toLowerCase();
  const mime = String(file.mime || '').split(';')[0].trim().toLowerCase();
  // Original filename takes precedence: chunk uploads often have generic metadata.
  if (OFFICE[ext]) return { kind: 'office', ext, mime: OFFICE[ext] };
  if (NATIVE[ext]) return { kind: 'native', ext, mime: NATIVE[ext] };
  for (const [suffix, type] of Object.entries(OFFICE)) if (type === mime) return { kind: 'office', ext: suffix, mime };
  for (const [suffix, type] of Object.entries(NATIVE)) if (type === mime) return { kind: 'native', ext: suffix, mime };
  return { kind: 'unsupported' };
}

function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

function secureHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
}

function unavailable(res, status, message) {
  res.removeHeader('Content-Length');
  res.removeHeader('Content-Range');
  res.removeHeader('Content-Disposition');
  return res.status(status).type('text/plain').send(message + ' Download the original file instead.');
}

// Race each external operation against the request lifetime; never keep a slot forever.
function wait(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function write(writable, bytes, signal) {
  if (signal.aborted) throw signal.reason;
  if (!writable.write(bytes)) await wait(once(writable, 'drain'), signal);
}

// Reads only intersecting chunks, aligning Telegram requests to 512 KiB boundaries.
async function* remoteBytes(account, file, start, end, signal) {
  const fileService = require('./fileService');
  const telegram = require('./telegramManager');
  const { resolvePeer } = require('./storageService');
  const bigInt = require('big-integer');
  const chunks = await wait(fileService.getFileChunks(file.id), signal);
  let total = 0;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(Number(chunk.size)) || Number(chunk.size) <= 0) throw new Error('Invalid chunk size');
    total += Number(chunk.size);
  }
  if (total !== Number(file.size)) throw new Error('Incomplete file metadata');
  const client = await wait(telegram.getClient(account), signal);
  let base = 0;
  for (const chunk of chunks) {
    const length = Number(chunk.size);
    const localStart = Math.max(0, start - base);
    const localEnd = Math.min(length - 1, end - base);
    base += length;
    if (localStart > localEnd) continue;
    const peer = resolvePeer(account, chunk.peer);
    const messages = await wait(client.getMessages(peer, { ids: [chunk.message_id] }), signal);
    if (!messages[0] || !messages[0].media) throw new Error('Missing storage message');
    const block = 512 * 1024;
    let position = Math.floor(localStart / block) * block;
    const iterator = client.iterDownload({ file: messages[0].media, offset: bigInt(position), requestSize: block })[Symbol.asyncIterator]();
    try {
      while (position <= localEnd) {
        const next = await wait(iterator.next(), signal);
        if (next.done) throw new Error('Truncated storage message');
        const bytes = Buffer.from(next.value);
        if (!bytes.length) throw new Error('Empty storage block');
        const from = Math.max(0, localStart - position);
        const to = Math.min(bytes.length, localEnd - position + 1);
        if (to > from) yield bytes.subarray(from, to);
        position += bytes.length;
      }
    } finally {
      if (iterator.return) Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}

async function convert(input, directory, signal) {
  // This executable MUST be an administrator-provided sandbox wrapper, not bare soffice.
  const executable = process.env.TDRIVE_PREVIEW_CONVERTER;
  if (!executable) throw new Error('Conversion disabled');
  const profile = path.join(directory, 'profile');
  await fs.promises.mkdir(path.join(profile, 'user'), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'),
    '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>', { mode: 0o600 });
  const args = ['-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf', '--outdir', directory, input];
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'ignore', cwd: directory });
  const kill = () => child.kill('SIGKILL');
  signal.addEventListener('abort', kill, { once: true });
  const monitor = setInterval(() => {
    fs.promises.stat(path.join(directory, 'source.pdf')).then(stat => {
      if (stat.size > MAX_PDF) kill();
    }).catch(() => {});
  }, 200);
  try {
    const [code] = await wait(once(child, 'close'), signal);
    if (code !== 0) throw new Error('Conversion failed');
  } finally {
    clearInterval(monitor);
    signal.removeEventListener('abort', kill);
    kill();
  }
  const output = path.join(directory, 'source.pdf');
  const stat = await fs.promises.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PDF || stat.size < 5) throw new Error('Invalid conversion output');
  const handle = await fs.promises.open(output, 'r');
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString() !== '%PDF-') throw new Error('Invalid PDF');
  } finally { await handle.close(); }
  return { output, size: stat.size };
}

/** Call only AFTER route authorization. All internal byte requests repeat that authorization. */
async function sendPreview(req, res, file, account) {
  secureHeaders(res);
  if (!file || !account || String(file.account_id) !== String(account.id) || file.deleted_at) {
    return unavailable(res, 404, 'File unavailable.');
  }
  const type = classify(file);
  if (type.kind === 'unsupported') return unavailable(res, 415, 'This file type cannot be safely previewed.');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) return unavailable(res, 422, 'Invalid file metadata.');
  if (type.kind === 'office' && size > MAX_DOCUMENT) return unavailable(res, 413, 'Document exceeds the 32 MiB preview limit.');
  if (type.kind === 'office' && !process.env.TDRIVE_PREVIEW_CONVERTER) return unavailable(res, 503, 'Local Office preview conversion is not configured.');
  if (active >= MAX_ACTIVE) { res.setHeader('Retry-After', '5'); return unavailable(res, 503, 'Preview service is busy.'); }
  active++;
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort(new Error('Preview cancelled'));
  const timer = setTimeout(abort, DEADLINE_MS);
  res.once('close', abort);
  let directory;
  try {
    let output;
    let responseSize = size;
    if (type.kind === 'office') {
      directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tdrive-preview-'));
      await fs.promises.chmod(directory, 0o700);
      const input = path.join(directory, 'source.' + type.ext);
      const handle = await fs.promises.open(input, 'wx', 0o600);
      try {
        let received = 0;
        for await (const bytes of remoteBytes(account, file, 0, size - 1, signal)) {
          received += bytes.length;
          if (received > MAX_DOCUMENT) throw new Error('Document too large');
          await handle.writeFile(bytes);
        }
        if (received !== size) throw new Error('Incomplete document');
      } finally { await handle.close(); }
      ({ output, size: responseSize } = await convert(input, directory, signal));
    }
    // No validators are emitted; If-Range therefore falls back to a full response.
    const range = parseRange(req.headers['if-range'] ? null : req.headers.range, responseSize);
    if (!range) {
      res.setHeader('Content-Range', `bytes */${responseSize}`);
      return res.status(416).end();
    }
    res.status(range.partial ? 206 : 200);
    res.setHeader('Content-Type', output ? 'application/pdf' : type.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', Math.max(0, range.end - range.start + 1));
    res.setHeader('Content-Disposition', `inline; filename="preview.${output ? 'pdf' : type.ext}"`);
    if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${responseSize}`);
    if (req.method !== 'HEAD' && responseSize > 0) {
      const source = output
        ? fs.createReadStream(output, { start: range.start, end: range.end, signal })
        : remoteBytes(account, file, range.start, range.end, signal);
      for await (const bytes of source) await write(res, bytes, signal);
    }
    res.end();
  } catch (_) {
    if (!res.destroyed && !res.headersSent) unavailable(res, 503, 'Preview could not be generated (unsupported, protected, damaged, or timed out).');
    else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(timer);
    res.removeListener('close', abort);
    controller.abort(new Error('Preview finished'));
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    active--;
  }
}

module.exports = { sendPreview, classify, parseRange, remoteBytes };
