'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const vm = require('vm');
const dbPath = require.resolve('../src/db');
const calls = [];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query: async (sql, params) => { calls.push({ sql, params }); return [[{ id: 1 }]]; },
  getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: async (sql, params) => { calls.push({ sql, params }); return [{ insertId: 1 }]; } })
} };
const service = require('../src/services/fileService');

test('captions validate type/length, preserve literal markup, and normalize lines', () => {
  assert.equal(service.normalizeCaption(), '');
  assert.equal(service.normalizeCaption('  <script>"\r\nhi  '), '<script>"\nhi');
  for (const value of [[], {}, 5, 'x'.repeat(2001)]) assert.throws(() => service.normalizeCaption(value));
  assert.equal(service.normalizeCaption('x'.repeat(2000)).length, 2000);
});
test('file creation persists caption atomically and edits scope ownership', async () => {
  calls.length = 0;
  await service.createFileWithChunks({ accountId: 2, name: 'test.pdf', size: 1, caption: 'example' }, []);
  assert.match(calls[0].sql, /INSERT INTO files.*caption/s);
  assert.equal(calls[0].params.at(-1), 'example');
  await service.updateFileCaption(1, 2, '');
  assert.match(calls.at(-1).sql, /account_id = \? AND deleted_at IS NULL/);
  assert.deepEqual(calls.at(-1).params.filter((_, i) => i !== 1), ['', 1, 2]);
});
test('all EJS templates compile', () => {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (filename.endsWith('.ejs')) ejs.compile(fs.readFileSync(filename, 'utf8'), { filename });
    }
  }
  walk(path.join(__dirname, '../src/views'));
});
test('public views escape hostile captions and names; legacy HTML injection is gone', () => {
  const hostile = '\"><script>alert(1)</script>\n\'&';
  const file = { name: hostile, caption: hostile, uuid: 'file-id', size: 1 };
  for (const view of ['file', 'folder']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/views/shares', view + '.ejs'), 'utf8');
    const html = ejs.render(source, { file, files: [file], uuid: 'share-id', folder: { name: 'Folder' }, currentSubfolder: null, subfolders: [], include: () => '', formatSize: String, formatDate: String });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes(ejs.escapeXML('<script>')));
    assert.ok(html.includes('data-file-preview='));
    assert.ok(!source.includes('docx-preview'));
  }
  new vm.Script(fs.readFileSync(path.join(__dirname, '../public/js/file-preview.js'), 'utf8'));
});
test('both upload flows carry validated captions and sessions reject metadata changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
  assert.equal((source.match(/normalizeCaption\(req.body.caption\)/g) || []).length, 3);
  assert.match(source, /caption: session.caption/);
  assert.match(source, /session.caption \|\| ''\) !== caption/);
  for (const schema of ['migrations.sql', 'migrations-mariadb.sql']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../src/db', schema), 'utf8'), /CREATE TABLE IF NOT EXISTS files \(\s+caption\s+TEXT/);
  }
});
