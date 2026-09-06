'use strict';
/* Tests for electron/storage.js — the main-process persistent store. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, parseDataUrl, safeName } = require('../electron/storage');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novaclip-store-'));
}

function dataUrl(bytes, mime) {
  return 'data:' + (mime || 'image/png') + ';base64,' + Buffer.from(bytes).toString('base64');
}

test('falls back to the JSON file backend when better-sqlite3 is absent', () => {
  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  assert.strictEqual(store.backend, 'file');
  assert.strictEqual(store.dir, dir);
});

test('auto mode picks sqlite when available, otherwise file', () => {
  const store = createStore(tmpDir());
  assert.ok(store.backend === 'sqlite' || store.backend === 'file');
});

test('kv round-trips and survives a reopen', () => {
  const dir = tmpDir();
  const a = createStore(dir, { prefer: 'file' });
  a.set('novaclip.clips', '[{"id":"c1"}]');
  a.set('novaclip.settings', '{"lang":"en"}');
  a.flush();

  assert.strictEqual(a.get('novaclip.clips'), '[{"id":"c1"}]');

  const b = createStore(dir, { prefer: 'file' });
  assert.strictEqual(b.get('novaclip.clips'), '[{"id":"c1"}]');
  assert.strictEqual(b.get('novaclip.settings'), '{"lang":"en"}');
  assert.strictEqual(b.get('missing'), null);
  assert.deepStrictEqual(Object.keys(b.getAll()).sort(), ['novaclip.clips', 'novaclip.settings']);
});

test('del removes a key and persists the removal', () => {
  const dir = tmpDir();
  const a = createStore(dir, { prefer: 'file' });
  a.set('k', '"v"');
  a.flush();
  a.del('k');
  a.flush();

  const b = createStore(dir, { prefer: 'file' });
  assert.strictEqual(b.get('k'), null);
});

test('the store file is written atomically (no .tmp leftovers)', () => {
  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  for (let i = 0; i < 25; i++) store.set('k' + i, JSON.stringify({ i }));
  store.flush();

  const files = fs.readdirSync(dir);
  assert.ok(files.includes('store.json'), 'store.json must exist: ' + files.join(','));
  assert.strictEqual(files.filter((f) => f.endsWith('.tmp')).length, 0, 'temp files must be renamed away');
});

test('a corrupt store file does not brick startup', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'store.json'), '{"kv":{"a":"1"');   // truncated JSON

  const store = createStore(dir, { prefer: 'file' });
  assert.deepStrictEqual(store.getAll(), {});
  store.set('b', '"2"');
  store.flush();

  const reopened = createStore(dir, { prefer: 'file' });
  assert.strictEqual(reopened.get('b'), '"2"');
  assert.ok(
    fs.readdirSync(dir).some((f) => f.indexOf('store.json.corrupt-') === 0),
    'the broken document should be preserved for manual recovery'
  );
});

test('acknowledged kv writes survive a crash without an explicit flush', () => {
  // The JSON backend used to debounce writes by ~25 ms; a process crash inside
  // that window could lose the last write. Writes are now synchronous and
  // atomic, so an acknowledged set must already be on disk.
  const dir = tmpDir();
  const a = createStore(dir, { prefer: 'file' });
  a.set('novaclip.clips', '[{"id":"c1"}]');
  a.set('novaclip.settings', '{"lang":"fa"}');
  // No flush()/close(): simulate the process dying right after the writes.

  const b = createStore(dir, { prefer: 'file' });   // "next boot"
  assert.strictEqual(b.get('novaclip.clips'), '[{"id":"c1"}]');
  assert.strictEqual(b.get('novaclip.settings'), '{"lang":"fa"}');
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0,
    'no half-written temp files may remain');
});

test('a deleted key survives a crash without an explicit flush', () => {
  const dir = tmpDir();
  const a = createStore(dir, { prefer: 'file' });
  a.set('k', 'value');
  a.del('k');

  const b = createStore(dir, { prefer: 'file' });
  assert.strictEqual(b.get('k'), null);
  assert.deepStrictEqual(Object.keys(b.getAll()), []);
});

test('blob writes are durable immediately (no flush needed)', () => {
  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);

  store.putBlob('img1', dataUrl(payload));          // no flush

  const reopened = createStore(dir, { prefer: 'file' });
  assert.strictEqual(reopened.getBlob('img1'), dataUrl(payload));
  assert.ok(fs.readFileSync(path.join(dir, 'blobs', 'img1')).equals(payload));
});

test('stale temp files left by a crashed write are cleaned up on open', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ version: 2, kv: { keep: 'me' } }));
  // A crash between writing the temp file and renaming it leaves garbage like
  // this; the document itself is never torn thanks to the atomic rename.
  fs.writeFileSync(path.join(dir, 'store.json.1234.99999999.tmp'), '{"half":');

  const store = createStore(dir, { prefer: 'file' });
  assert.strictEqual(store.get('keep'), 'me');
  store.set('b', '"2"');
  store.flush();

  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0,
    'stale temp files must be removed');
});

test('blobs round-trip as binary with their mime type', () => {
  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

  const id = store.putBlob('img1', dataUrl(payload));
  assert.strictEqual(id, 'img1');

  const back = store.getBlob('img1');
  assert.strictEqual(back, dataUrl(payload));

  // Stored on disk as raw bytes, not base64 text.
  const raw = fs.readFileSync(path.join(dir, 'blobs', 'img1'));
  assert.ok(raw.equals(payload), 'blob should be stored decoded');

  store.delBlob('img1');
  assert.strictEqual(store.getBlob('img1'), null);
});

test('blob ids cannot escape the blob directory', () => {
  for (const evil of ['../../etc/passwd', '..', '/', 'a/b', '\\..\\win', '....//x']) {
    const n = safeName(evil);
    assert.ok(n.indexOf('/') === -1 && n.indexOf('\\') === -1, 'no separators: ' + evil + ' -> ' + n);
    assert.ok(n.indexOf('..') === -1, 'no traversal: ' + evil + ' -> ' + n);
    assert.ok(path.resolve(path.join('blobs', n)).indexOf(path.resolve('blobs')) === 0, 'stays inside blobs/: ' + n);
  }

  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  const id = store.putBlob('../../evil', dataUrl('x'));
  store.flush();
  assert.ok(fs.existsSync(path.join(dir, 'blobs', id)));
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f === 'evil').length, 0);
});

test('invalid data URLs are rejected', () => {
  const store = createStore(tmpDir(), { prefer: 'file' });
  assert.throws(() => store.putBlob('x', 'not a data url'), /invalid data URL/);
  assert.strictEqual(parseDataUrl('data:image/png;base64,QUJD').mime, 'image/png');
  assert.strictEqual(parseDataUrl('nope'), null);
});

test('usage reports kv and blob bytes separately', () => {
  const dir = tmpDir();
  const store = createStore(dir, { prefer: 'file' });
  store.set('novaclip.clips', JSON.stringify({ pad: 'x'.repeat(1000) }));
  store.putBlob('b1', dataUrl(Buffer.alloc(500, 7)));
  store.flush();

  const u = store.usage();
  assert.strictEqual(u.backend, 'file');
  assert.ok(u.kvBytes > 1000, 'kv bytes should count the document: ' + u.kvBytes);
  assert.ok(u.blobBytes >= 500, 'blob bytes should count the image: ' + u.blobBytes);
});
