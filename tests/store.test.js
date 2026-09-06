'use strict';
/* Tests for app/store.js — storage layer, encryption migration, pruning. */

const test = require('node:test');
const assert = require('node:assert');
const { createWindow, loadScripts } = require('./helpers/harness');

/* ---------- helpers ---------- */

function memAdapter(initialKv, opts) {
  const o = opts || {};
  const kv = new Map(Object.entries(initialKv || {}));
  let clipWriteFailures = o.failClipWrites || 0;
  const writes = [];
  return {
    backend: 'test',
    capacityBytes: o.capacityBytes || null,
    writes,
    kv,
    loadSync() {
      return { kv: Object.fromEntries(kv), usage: { kvBytes: 0, blobBytes: 0, backend: 'test' } };
    },
    async set(key, value) {
      writes.push(key);
      if (key === 'novaclip.clips' && clipWriteFailures > 0) {
        clipWriteFailures--;
        return { ok: false, error: 'QuotaExceededError' };
      }
      kv.set(key, value);
      return { ok: true };
    },
    async del(key) { kv.delete(key); return { ok: true }; },
    async usage() { return { kvBytes: 0, blobBytes: 0, backend: 'test' }; },
    async imagePut(id, dataUrl) {
      if (o.failImagePut) return { ok: false, error: 'QuotaExceededError' };
      kv.set('novaclip.blob.' + id, dataUrl);
      return { ok: true, id };
    },
    async imageGet(id) { return kv.get('novaclip.blob.' + id) || null; },
    async imageDel(id) { kv.delete('novaclip.blob.' + id); return { ok: true }; },
  };
}

function bootStore(adapter, seed) {
  const { window } = createWindow();
  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  window.Bridge.storage = adapter;
  if (seed) adapter.kv.set('novaclip.clips', JSON.stringify(seed));
  return window;
}

// Clips are stored newest-first, so index 0 is the most recent.
function seedClips(n) {
  const out = [];
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    out.push({ id: 'c' + i, type: 'text', text: 'clip number ' + i, ts: base - i * 1000, copies: 0 });
  }
  return out;
}

function storedClips(adapter) {
  const raw = adapter.kv.get('novaclip.clips');
  return raw ? JSON.parse(raw) : null;
}

/* ---------- dedup / capture correctness ---------- */

test('dedup does not collapse different texts of equal length', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 'a', type: 'text', text: 'hello123', ts: 1, copies: 0 });
  await Store.addClip({ id: 'b', type: 'text', text: 'world456', ts: 2, copies: 0 });

  assert.strictEqual(Store.getClips().length, 2);
});

test('dedup does not collapse different images (text is undefined for both)', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 'i1', type: 'image', data: 'data:image/png;base64,AAAA', ts: 1, copies: 0 });
  await Store.addClip({ id: 'i2', type: 'image', data: 'data:image/png;base64,BBBB', ts: 2, copies: 0 });

  assert.strictEqual(Store.getClips().length, 2);
});

test('dedup still collapses an identical repeated copy', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 'a', type: 'text', text: 'same', ts: 1, copies: 0 });
  const again = await Store.addClip({ id: 'b', type: 'text', text: 'same', ts: 2, copies: 0 });

  assert.strictEqual(Store.getClips().length, 1);
  assert.strictEqual(again.id, 'a');
  assert.strictEqual(again.copies, 1);
});

/* ---------- persistence / pruning ---------- */

test('persistClips returns the result of the retry after pruning', async () => {
  // Two failed writes, then success: the old code returned the *first*
  // (failed) result even though the retry succeeded.
  const adapter = memAdapter({}, { failClipWrites: 2 });
  const window = bootStore(adapter, seedClips(12));
  const Store = window.Store;

  assert.strictEqual(Store.getClips().length, 12);
  const ok = await Store.persistClips();

  assert.strictEqual(ok, true, 'retry result must be propagated');
  assert.ok(Store.getClips().length < 12, 'clips should have been pruned to make room');
});

test('persistClips reports false when nothing can be pruned', async () => {
  const adapter = memAdapter({}, { failClipWrites: 99 });
  const pinned = seedClips(3).map((c) => Object.assign({}, c, { pinned: true }));
  const window = bootStore(adapter, pinned);
  const Store = window.Store;

  const ok = await Store.persistClips();
  assert.strictEqual(ok, false);
  assert.strictEqual(Store.getClips().length, 3, 'pinned clips must never be pruned');
});

test('pruning removes the OLDEST clips, not the newest', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(10));
  const Store = window.Store;

  const removed = Store.pruneOldClips();
  assert.strictEqual(removed, true);

  const ids = Store.getClips().map((c) => c.id);
  assert.ok(ids.includes('c0'), 'newest clip must survive');
  assert.ok(!ids.includes('c9'), 'oldest clip must be the one dropped');
});

/* ---------- images ---------- */

test('image bytes are externalised into the blob store, not the clips document', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const dataUrl = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');

  await Store.addClip({ id: 'img1', type: 'image', data: dataUrl, ts: 1, copies: 0 });

  const rows = storedClips(adapter);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].imageId, 'row should reference a blob id');
  assert.strictEqual(rows[0].data, undefined, 'base64 must not live in the clips document');

  const blobKeys = Array.from(adapter.kv.keys()).filter((k) => k.indexOf('novaclip.blob.') === 0);
  assert.strictEqual(blobKeys.length, 1);
  assert.strictEqual(adapter.kv.get(blobKeys[0]), dataUrl);
});

test('getImageData reads the blob back on demand', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const dataUrl = 'data:image/png;base64,' + Buffer.from('another-image').toString('base64');

  await Store.addClip({ id: 'img1', type: 'image', data: dataUrl, ts: 1, copies: 0 });

  // Simulate a cold start: memory mirror reloaded from the backend.
  Store.clearCache();
  const rows = Store.getClips();
  assert.strictEqual(rows[0].data, undefined);

  const loaded = await Store.getImageData(rows[0]);
  assert.strictEqual(loaded, dataUrl);
});

test('thumbnails are externalised too — no base64 survives in the clips document', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const full = 'data:image/png;base64,' + Buffer.from('full-image-bytes').toString('base64');
  const thumb = 'data:image/png;base64,' + Buffer.from('tiny-thumb').toString('base64');

  await Store.addClip({ id: 'img1', type: 'image', data: full, thumb, ts: 1, copies: 0 });

  const row = storedClips(adapter)[0];
  assert.strictEqual(row.data, undefined, 'full image must not be in the document');
  assert.strictEqual(row.thumb, undefined, 'thumbnail must not be in the document');
  assert.ok(row.imageId && row.thumbId);
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + row.imageId), full);
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + row.thumbId), thumb);

  // Cold start: the thumbnail is fetched from its own blob on demand.
  Store.clearCache();
  const cold = Store.getClips()[0];
  assert.strictEqual(cold.thumb, undefined);
  assert.strictEqual(await Store.getImageThumb(cold), thumb);
});

test('deleting a clip removes both of its blobs', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 'img1', type: 'image', data: 'data:image/png;base64,QUJD', thumb: 'data:image/png;base64,REVG', ts: 1, copies: 0 });
  const row = storedClips(adapter)[0];
  assert.strictEqual(Array.from(adapter.kv.keys()).filter((k) => k.indexOf('novaclip.blob.') === 0).length, 2);

  await Store.deleteClip('img1');
  assert.strictEqual(Array.from(adapter.kv.keys()).filter((k) => k.indexOf('novaclip.blob.') === 0).length, 0);
});

/* ---------- encryption ---------- */

const PW = 'correct horse battery staple';

test('enableEncryption migrates the whole history and leaves no plaintext', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const img = 'data:image/png;base64,' + Buffer.from('secret-image').toString('base64');

  await Store.addClip({ id: 't1', type: 'text', text: 'top secret alpha', ts: 3, copies: 0 });
  await Store.addClip({ id: 't2', type: 'text', text: 'top secret beta', ts: 2, copies: 0 });
  await Store.addClip({ id: 'i1', type: 'image', data: img, thumb: 'data:image/png;base64,dGh1bWI', ts: 1, copies: 0 });

  const progress = [];
  const res = await Store.enableEncryption(PW, { onProgress: (d, a) => progress.push([d, a]) });

  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.migrated, 3);
  assert.strictEqual(progress.length, 3, 'progress should be reported per clip');
  assert.strictEqual(Store.isEncrypted(), true);

  const raw = adapter.kv.get('novaclip.clips');
  assert.ok(raw.indexOf('top secret alpha') === -1, 'plaintext text must be gone');
  assert.ok(raw.indexOf('top secret beta') === -1, 'plaintext text must be gone');
  assert.ok(raw.indexOf('secret-image') === -1, 'plaintext image bytes must be gone');
  assert.ok(raw.indexOf('dGh1bWI') === -1, 'plaintext thumbnail must be gone from the document');

  // The plaintext blob must have been deleted too.
  const blobKeys = Array.from(adapter.kv.keys()).filter((k) => k.indexOf('novaclip.blob.') === 0);
  assert.strictEqual(blobKeys.length, 0, 'plaintext image blob must be removed');

  // Round-trip check.
  const dec = await Store.getClipsDecrypted(PW);
  const texts = dec.map((c) => c.text).filter(Boolean).sort();
  assert.deepStrictEqual([...texts], ['top secret alpha', 'top secret beta']);
  const image = dec.find((c) => c.type === 'image');
  assert.strictEqual(image.data, img);
});

test('enableEncryption is a no-op when already enabled, and rejects an empty password', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(2));
  const Store = window.Store;

  const noPw = await Store.enableEncryption('');
  assert.strictEqual(noPw.ok, false);
  assert.strictEqual(noPw.error, 'NO_PASSWORD');

  const first = await Store.enableEncryption(PW);
  assert.strictEqual(first.ok, true);

  const second = await Store.enableEncryption(PW);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.already, true);
  assert.strictEqual(second.migrated, 0);
});

test('disableEncryption refuses a wrong password and keeps the history encrypted', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(3));
  const Store = window.Store;

  await Store.enableEncryption(PW);
  const res = await Store.disableEncryption('wrong password');

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'BAD_PASSWORD');
  assert.strictEqual(Store.isEncrypted(), true);
  assert.ok(adapter.kv.get('novaclip.clips').indexOf('clip number 0') === -1);
});

test('disableEncryption restores plaintext and clears the verifier', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(3));
  const Store = window.Store;

  await Store.enableEncryption(PW);
  const res = await Store.disableEncryption(PW);

  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.migrated, 3);
  assert.strictEqual(Store.isEncrypted(), false);
  const raw = adapter.kv.get('novaclip.clips');
  assert.ok(raw.indexOf('clip number 0') !== -1, 'plaintext should be back');
  assert.strictEqual(adapter.kv.get('novaclip.encrypted'), undefined);
});

test('updateClip re-encrypts text on an encrypted history', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(1));
  const Store = window.Store;

  await Store.enableEncryption(PW);
  const updated = await Store.updateClip('c0', { text: 'brand new secret' }, PW);
  assert.ok(updated);

  const raw = adapter.kv.get('novaclip.clips');
  assert.ok(raw.indexOf('brand new secret') === -1, 'new plaintext must not be written');
  const dec = await Store.getClipsDecrypted(PW);
  assert.strictEqual(dec[0].text, 'brand new secret');
});

test('updateClip refuses to rewrite an encrypted clip without the password', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(1));
  const Store = window.Store;

  await Store.enableEncryption(PW);
  const res = await Store.updateClip('c0', { text: 'nope' });
  assert.strictEqual(res, null);
  const dec = await Store.getClipsDecrypted(PW);
  assert.strictEqual(dec[0].text, 'clip number 0');
});

test('all clips of one password share a salt, so unlocking costs one derivation', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  const a = await Store.encryptText('one', PW);
  const b = await Store.encryptText('two', PW);

  assert.strictEqual(a.salt, b.salt, 'a shared salt avoids N PBKDF2 runs');
  assert.notStrictEqual(a.iv, b.iv, 'each clip still gets a unique IV');
  assert.notStrictEqual(a.data, b.data);
});

test('import re-encrypts when the device encrypts at rest', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(1));
  const Store = window.Store;

  await Store.enableEncryption(PW);
  const payload = JSON.stringify({ app: 'novaclip', version: 2, encrypted: false, clips: [
    { id: 'x1', type: 'text', text: 'imported secret', ts: 1, copies: 0 },
  ] });

  const n = await Store.importAll(payload, PW);
  assert.strictEqual(n, 1);
  assert.ok(adapter.kv.get('novaclip.clips').indexOf('imported secret') === -1);
  const dec = await Store.getClipsDecrypted(PW);
  assert.ok(dec.some((c) => c.text === 'imported secret'));
});

test('export resolves image blobs into a self-contained document', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const img = 'data:image/png;base64,' + Buffer.from('export-me').toString('base64');

  await Store.addClip({ id: 'i1', type: 'image', data: img, ts: 1, copies: 0 });
  Store.clearCache();

  const json = await Store.exportAll();
  assert.ok(json.indexOf('export-me') !== -1 || json.indexOf(Buffer.from('export-me').toString('base64')) !== -1);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.clips[0].data, img);
});

/* Credential-shaped fixtures are assembled at runtime on purpose: a literal
   secret-shaped string committed to the repo is (correctly) rejected by GitHub
   push protection. Detection still runs on the fully assembled value. */
const fx = (...parts) => parts.join('');

/* ---------- sensitive content detection ---------- */

test('detects the token formats the old heuristic missed', () => {
  const { window } = createWindow();
  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  const detect = window.Store.detectSensitiveContent;

  const cases = [
    [fx('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'), 'GITHUB_TOKEN'],
    [fx('github', '_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), 'GITHUB_TOKEN'],
    [fx('xox', 'b-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx'), 'SLACK_TOKEN'],
    [fx('AIza', 'SyA1234567890abcdefghijklmnopqrstuv'), 'API_KEY'],
    [fx('sk_', 'live_4eC39HqLyjWDarjtT1zdp7dc'), 'API_KEY'],
    [fx('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'), 'PRIVATE_KEY'],
    [fx('postgres', '://user:pass@db.internal:5432/app'), 'DB_CONNECTION'],
    [fx('https://deploy', ':s3cr3t@example.com/hook'), 'URL_CREDENTIALS'],
    [fx('password = ', '"hunter2secret"'), 'PASSWORD'],
    [fx('Authorization: ', 'Bearer abcdefghijklmnopqrstuvwxyz'), 'BEARER_TOKEN'],
    [fx('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), 'JWT'],
    [fx('AKIA', 'IOSFODNN7EXAMPLE'), 'AWS_ACCESS_KEY'],
  ];

  for (const [text, label] of cases) {
    const res = detect(text);
    assert.ok(res.sensitive, 'expected sensitive: ' + text);
    assert.ok(res.types.includes(label), 'expected ' + label + ' in ' + res.types.join(',') + ' for: ' + text);
  }
});

test('credit card detection is Luhn-validated', () => {
  const { window } = createWindow();
  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  const detect = window.Store.detectSensitiveContent;

  assert.ok(detect(fx('card ', '4111 1111 1111 1111', ' ok')).types.includes('CREDIT_CARD'));
  const bogus = detect('order 1234567890123456 placed');
  assert.ok(!bogus.types.includes('CREDIT_CARD'), 'non-Luhn digit runs must not be flagged as cards');
});

test('ordinary prose is not flagged', () => {
  const { window } = createWindow();
  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  const detect = window.Store.detectSensitiveContent;

  const res = detect('The quick brown fox jumps over the lazy dog while it rains.');
  assert.strictEqual(res.sensitive, false);
  assert.strictEqual(res.heuristic, true, 'the result must advertise that it is heuristic');
});

test('high-entropy blobs are flagged even without a known prefix', () => {
  const { window } = createWindow();
  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  const res = window.Store.detectSensitiveContent(fx('secret=', '9fK3pQ7zX2mV8bN4rT6yW1cL5dH0aGjE'));
  assert.ok(res.types.includes('HIGH_ENTROPY'));
});
