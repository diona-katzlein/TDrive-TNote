'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { classify, parseRange, sendPreview, remoteBytes } = require('../src/services/previewService');

function response() {
  const res = new EventEmitter();
  res.headers = {}; res.statusCode = 200; res.body = [];
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.removeHeader = k => { delete res.headers[k.toLowerCase()]; };
  res.status = code => { res.statusCode = code; return res; };
  res.type = type => { res.setHeader('Content-Type', type); return res; };
  res.send = body => { res.body.push(body); return res; };
  res.write = bytes => { res.headersSent = true; res.body.push(bytes); return true; };
  res.end = () => { res.ended = true; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

test('Office and media classification uses original extensions for chunk metadata', () => {
  for (const ext of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
    assert.equal(classify({ name: 'REPORT.' + ext.toUpperCase(), mime: 'application/octet-stream' }).kind, 'office');
  }
  assert.equal(classify({ name: 'clip.mp4', mime: 'application/octet-stream' }).mime, 'video/mp4');
  assert.equal(classify({ name: 'unknown', mime: 'application/pdf' }).ext, 'pdf');
  for (const name of ['evil.html', 'evil.svg', 'evil.js']) assert.equal(classify({ name }).kind, 'unsupported');
});

test('single byte ranges include suffix, open end, clamping and rejection', () => {
  assert.deepEqual(parseRange('bytes=3-5', 10), { start: 3, end: 5, partial: true });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=0-100', 10), { start: 0, end: 9, partial: true });
  for (const value of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-']) assert.equal(parseRange(value, 10), null);
  assert.equal(parseRange('bytes=0-', 0), null);
});

test('safe fallback and ownership checks do not access storage', async () => {
  for (const [file, code] of [
    [{ account_id: 2, name: 'x.pdf', size: 1 }, 404],
    [{ account_id: 1, name: '<script>.html', size: 1 }, 415],
    [{ account_id: 1, name: 'x.pdf', size: 1, deleted_at: 1 }, 404],
    [{ account_id: 1, name: 'x.docx', size: 33 * 1024 * 1024 }, 413],
  ]) {
    const res = response();
    await sendPreview({ headers: {}, method: 'GET' }, res, file, { id: 1 });
    assert.equal(res.statusCode, code);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'text/plain');
    assert.ok(!res.body.join('').includes('<script>'));
  }
});

test('missing local converter fails closed without leaking filenames', async () => {
  const previous = process.env.TDRIVE_PREVIEW_CONVERTER;
  delete process.env.TDRIVE_PREVIEW_CONVERTER;
  try {
    const res = response();
    await sendPreview({ headers: {}, method: 'GET' }, res,
      { id: 1, account_id: 1, name: '<secret>.xlsx', size: 10 }, { id: 1 });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.join(''), /not configured/);
    assert.ok(!res.body.join('').includes('<secret>'));
  } finally {
    if (previous === undefined) delete process.env.TDRIVE_PREVIEW_CONVERTER;
    else process.env.TDRIVE_PREVIEW_CONVERTER = previous;
  }
});

test('chunk-aware ranges use chunk peers and produce exact HTTP responses', async () => {
  const stubs = {
    '../src/services/fileService': { getFileChunks: async () => [{ size: 5, peer: 'one', message_id: 1 }, { size: 5, peer: 'two', message_id: 2 }] },
    '../src/services/storageService': { resolvePeer: (_a, peer) => peer },
  };
  const peers = [];
  stubs['../src/services/telegramManager'] = { getClient: async () => ({
    getMessages: async (peer, { ids }) => { peers.push(peer); return [{ media: ids[0] }]; },
    iterDownload: async function* ({ file, offset }) {
      assert.equal(Number(offset), 0);
      yield Buffer.from(file === 1 ? 'abcde' : 'fghij');
    },
  }) };
  const saved = [];
  for (const [name, exports] of Object.entries(stubs)) {
    const id = require.resolve(name); saved.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  try {
    const file = { id: 1, account_id: 1, name: 'clip.mp4', size: 10 };
    const res = response();
    await sendPreview({ headers: { range: 'bytes=3-7' }, method: 'GET' }, res, file, { id: 1 });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], 'bytes 3-7/10');
    assert.equal(res.headers['content-length'], 5);
    assert.equal(Buffer.concat(res.body).toString(), 'defgh');
    assert.deepEqual(peers, ['one', 'two']);
    const head = response();
    await sendPreview({ headers: {}, method: 'HEAD' }, head, file, { id: 1 });
    assert.equal(head.headers['content-length'], 10); assert.equal(head.body.length, 0);
    assert.equal(peers.length, 2);
    const invalid = response();
    await sendPreview({ headers: { range: 'bytes=99-' }, method: 'GET' }, invalid, file, { id: 1 });
    assert.equal(invalid.statusCode, 416); assert.equal(invalid.headers['content-range'], 'bytes */10');
    const bytes = [];
    for await (const b of remoteBytes({ id: 1 }, file, 7, 9, new AbortController().signal)) bytes.push(b);
    assert.equal(Buffer.concat(bytes).toString(), 'hij');
    assert.deepEqual(peers, ['one', 'two', 'two']);
  } finally {
    for (const [id, entry] of saved) { if (entry) require.cache[id] = entry; else delete require.cache[id]; }
  }
});

test('route delegation remains after authorization, not in download paths', () => {
  const fs = require('fs');
  const files = fs.readFileSync(require.resolve('../src/routes/files'), 'utf8');
  const download = files.slice(files.indexOf("router.get('/file/:uuid/download'"), files.indexOf("router.get('/file/:uuid/preview'"));
  assert.ok(!download.includes('sendPreview'));
  assert.ok(download.includes('attachment;'));
  const share = fs.readFileSync(require.resolve('../src/routes/share'), 'utf8');
  const evidence = share.slice(share.indexOf("router.get('/:uuid/kinerja-evidence/"), share.indexOf('// Download Shared File'));
  assert.ok(evidence.indexOf('sendPreview') > evidence.indexOf('unlockedShares'));
  assert.ok(evidence.indexOf('sendPreview') > evidence.indexOf('getAccount'));
  assert.ok(!share.includes('mammoth.convertToHtml'));
});
