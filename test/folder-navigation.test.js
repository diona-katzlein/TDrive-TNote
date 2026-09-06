'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fileService = require('../src/services/fileService');
const honeypot = require('../src/middleware/honeypot');

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      send(body) { resolve({ next: false, status: this.statusCode, body }); },
    };
    middleware(req, response, () => resolve({ next: true, status: response.statusCode }));
  });
}

test('folder navigation builds complete ancestry and readable destination paths', () => {
  const folders = [
    { id: 3, uuid: 'c', parent_id: 2, name: 'Laporan' },
    { id: 1, uuid: 'a', parent_id: null, name: 'Divisi' },
    { id: 2, uuid: 'b', parent_id: 1, name: '2026' },
    { id: 4, uuid: 'd', parent_id: null, name: 'Arsip' },
  ];

  const result = fileService.buildFolderNavigation(folders, folders[0]);

  assert.deepEqual(result.breadcrumbs.map((folder) => folder.name), ['Divisi', '2026', 'Laporan']);
  assert.equal(result.parentFolder.uuid, 'b');
  assert.deepEqual(result.folders.map((folder) => folder.path), [
    'Arsip',
    'Divisi',
    'Divisi / 2026',
    'Divisi / 2026 / Laporan',
  ]);
});

test('folder navigation stops safely when corrupt ancestry contains a cycle', () => {
  const folders = [
    { id: 1, uuid: 'a', parent_id: 2, name: 'Satu' },
    { id: 2, uuid: 'b', parent_id: 1, name: 'Dua' },
  ];

  const result = fileService.buildFolderNavigation(folders, folders[0]);
  assert.equal(result.breadcrumbs.length, 2);
  assert.equal(result.folders.length, 2);
});

test('honeypot ignores autofilled website only for share creation', async () => {
  const share = await runMiddleware(honeypot, {
    method: 'POST',
    path: '/share/create',
    body: { website: 'https://autofilled.example' },
  });
  const other = await runMiddleware(honeypot, {
    method: 'POST',
    path: '/folders',
    body: { website: 'https://bot.example' },
    ip: '127.0.0.1',
    socket: {},
  });

  assert.equal(share.next, true);
  assert.equal(other.next, false);
  assert.equal(other.status, 400);
});
