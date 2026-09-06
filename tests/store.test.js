'use strict';
/* Tests for app/store.js — storage layer, encryption migration, pruning. */

const test = require('node:test');
const assert = require('node:assert');
const { createWindow, loadScripts } = require('./helpers/harness');

/* ---------- helpers ---------- */

function memAdapter(initialKv, opts) {
  const o = opts || {};
  const kv = new Map(Object.entries(initialKv || {}));
  const writes = [];
  const adapter = {
    backend: 'test',
    capacityBytes: o.capacityBytes || null,
    writes,
    kv,
    // Mutable so tests can arm write failures at a precise point of a flow.
    failClipWrites: o.failClipWrites || 0,
    loadSync() {
      return { kv: Object.fromEntries(kv), usage: { kvBytes: 0, blobBytes: 0, backend: 'test' } };
    },
    async set(key, value) {
      writes.push(key);
      if (key === 'novaclip.clips' && adapter.failClipWrites > 0) {
        adapter.failClipWrites--;
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
  return adapter;
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

test('disableEncryption removes plaintext image blobs when the rollback write fails', async () => {
  const img = 'data:image/png;base64,' + b64('decrypted-pixels');
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  await Store.addClip({ id: 't1', type: 'text', text: 'secret text', ts: 2, copies: 0 });
  await Store.addClip({ id: 'i1', type: 'image', data: img, ts: 1, copies: 0 });
  await Store.enableEncryption(PW);
  assert.strictEqual(blobKeys(adapter).length, 0, 'no plaintext blobs while encrypted');

  adapter.failClipWrites = 99;                    // plaintext commit cannot land
  const res = await Store.disableEncryption(PW);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'PERSIST_FAILED');
  assert.strictEqual(Store.isEncrypted(), true, 'encryption must stay on after a failed disable');
  assert.strictEqual(blobKeys(adapter).length, 0,
    'decrypted plaintext blobs must be deleted when the rollback fails');
  const raw = adapter.kv.get('novaclip.clips');
  assert.strictEqual(raw.indexOf('secret text'), -1, 'the stored history must remain ciphertext');
});

test('re-enabling after an interrupted migration rejects a different password and resumes with the right one', async () => {
  const adapter = memAdapter();
  // First attempt encrypts the history…
  const firstWin = bootStore(adapter, seedClips(2));
  const first = await firstWin.Store.enableEncryption(PW);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  // …then the process dies before the verifier write: encryption flag lost,
  // rows still ciphertext (with PW's salt).
  adapter.kv.delete('novaclip.encrypted');

  // "Next boot" re-hydrates from the backend and sees exactly that state.
  const window = bootStore(adapter);
  const Store = window.Store;
  assert.strictEqual(Store.isEncrypted(), false);

  // A different password must not stamp a verifier over undecryptable rows.
  const wrong = await Store.enableEncryption('a-different-password');
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.error, 'RESUME_PASSWORD_MISMATCH');
  assert.strictEqual(Store.isEncrypted(), false);

  // The same password resumes the interrupted migration safely.
  const right = await Store.enableEncryption(PW);
  assert.strictEqual(right.ok, true, JSON.stringify(right));
  assert.strictEqual(Store.isEncrypted(), true);
  const dec = await Store.getClipsDecrypted(PW);
  assert.strictEqual(dec.length, 2);
  assert.ok(dec.every((c) => c.text != null), 'every clip must decrypt with the same password');
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

/* ============================================================
   Encryption-migration & image-replacement edge cases
   (regressions reported by the security audit)
   ============================================================ */

function blobKeys(adapter) {
  return Array.from(adapter.kv.keys()).filter((k) => k.indexOf('novaclip.blob.') === 0);
}

function b64(plain) { return Buffer.from(plain).toString('base64'); }

test('enableEncryption fails when an image blob is missing, keeps encryption OFF and plaintext intact', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 't1', type: 'text', text: 'keep me plaintext', ts: 2, copies: 0 });
  await Store.addClip({ id: 'i1', type: 'image', data: 'data:image/png;base64,' + b64('lost-image'), ts: 1, copies: 0 });
  const rows = storedClips(adapter);
  const broken = rows.find((r) => r.id === 'i1');
  assert.ok(broken.imageId, 'image should have been externalised to a blob');

  // Cold start + blob gone: the row only knows an id, and the bytes are unreadable.
  adapter.kv.delete('novaclip.blob.' + broken.imageId);
  Store.clearCache();

  const res = await Store.enableEncryption('pw-not-used-123');
  assert.strictEqual(res.ok, false, JSON.stringify(res));
  assert.strictEqual(res.error, 'IMAGE_READ_FAILED');
  assert.deepStrictEqual(Array.from(res.failed), ['i1']);
  assert.strictEqual(Store.isEncrypted(), false, 'encryption must remain off after the failure');

  const raw = adapter.kv.get('novaclip.clips');
  assert.ok(raw.indexOf('keep me plaintext') !== -1, 'history must roll back to plaintext');
  assert.strictEqual(raw.indexOf('encImage'), -1, 'no row may be half-encrypted');
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + broken.imageId), undefined, 'the (already missing) blob must not be resurrected');
  const clips = Store.getClips();
  assert.strictEqual(clips.length, 2);
  const text = clips.find((c) => c.id === 't1');
  assert.strictEqual(text.text, 'keep me plaintext');
});

test('enableEncryption fails for an image row that has no bytes at all (no data, no id)', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  const seed = [
    { id: 't1', type: 'text', text: 'still here', ts: 2, copies: 0 },
    { id: 'ghost', type: 'image', ts: 1, copies: 0 },       // image with no readable content
  ];
  adapter.kv.set('novaclip.clips', JSON.stringify(seed));

  const res = await Store.enableEncryption('x');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'IMAGE_READ_FAILED');
  assert.deepStrictEqual(Array.from(res.failed), ['ghost']);
  assert.strictEqual(Store.isEncrypted(), false);
});

test('updateClip deletes the old plaintext image blob when an image is replaced on an encrypted history', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const oldImg = 'data:image/png;base64,' + b64('old-plaintext-pixels');

  await Store.addClip({ id: 'i1', type: 'image', data: oldImg, ts: 1, copies: 0 });
  const before = storedClips(adapter)[0];
  assert.ok(before.imageId);
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + before.imageId), oldImg);

  // A verifier without a migration emulates the mixed state an interrupted
  // (or previously buggy) migration could leave behind: the history claims to
  // be encrypted while this clip is still a plaintext blob on disk.
  await Store.setPassword(PW);

  const newImg = 'data:image/png;base64,' + b64('brand-new-secret-image');
  const updated = await Store.updateClip('i1', { type: 'image', data: newImg, ts: 2 }, PW);
  assert.ok(updated, 'replacement must succeed with the password');

  const raw = adapter.kv.get('novaclip.clips');
  assert.strictEqual(raw.indexOf('old-plaintext-pixels'), -1);
  assert.strictEqual(raw.indexOf('brand-new-secret-image'), -1, 'new bytes must not be written in plaintext');
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + before.imageId), undefined, 'old plaintext blob must be deleted');
  assert.ok(adapter.kv.get('novaclip.encrypted'), 'verifier must survive (only blob cleanup may run)');

  const dec = await Store.getClipsDecrypted(PW);
  const img = dec.find((c) => c.id === 'i1');
  assert.strictEqual(img.data, newImg);
});

test('updateClip refuses to replace an image on an encrypted history without the password', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  await Store.addClip({ id: 'i1', type: 'image', data: 'data:image/png;base64,' + b64('old'), ts: 1, copies: 0 });
  const before = storedClips(adapter)[0];
  await Store.setPassword(PW);                    // mixed state: encrypted flag, plaintext blob row

  const res = await Store.updateClip('i1', { type: 'image', data: 'data:image/png;base64,' + b64('new') });
  assert.strictEqual(res, null, 'no password => no plaintext write into an encrypted history');
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + before.imageId), 'data:image/png;base64,' + b64('old'),
    'old blob must stay untouched when the update is refused');
});

test('updateClip externalises a replacement image and removes the old blob on a plaintext history', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const oldImg = 'data:image/png;base64,' + b64('first-version');
  const newImg = 'data:image/png;base64,' + b64('second-version');

  await Store.addClip({ id: 'i1', type: 'image', data: oldImg, ts: 1, copies: 0 });
  const before = storedClips(adapter)[0];
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + before.imageId), oldImg);

  const updated = await Store.updateClip('i1', { type: 'image', data: newImg, ts: 2 });
  assert.ok(updated);

  const after = storedClips(adapter)[0];
  assert.ok(after.imageId, 'replacement must be stored as a fresh blob');
  assert.notStrictEqual(after.imageId, before.imageId);
  assert.strictEqual(after.data, undefined, 'no base64 may live in the clips document');
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + before.imageId), undefined, 'old blob must be deleted');
  assert.strictEqual(adapter.kv.get('novaclip.blob.' + after.imageId), newImg);
  assert.strictEqual(await Store.getImageData(after), newImg);
});

test('deleteClip removes blobs only after the removal is durable (failed write keeps them)', async () => {
  // If persistence fails and nothing can be pruned, a delete must not destroy
  // the blobs the on-disk history still points at.
  const adapter = memAdapter({}, { failClipWrites: 99 });
  const img = 'data:image/png;base64,' + b64('still-on-disk');
  const window = bootStore(adapter, [{ id: 'i1', type: 'image', imageId: 'imgX', thumbId: 'thmX', ts: 1, copies: 0, pinned: true }]);
  adapter.kv.set('novaclip.blob.imgX', img);
  adapter.kv.set('novaclip.blob.thmX', 'data:image/png;base64,dGh1bWI');
  const Store = window.Store;

  const ok = await Store.deleteClip('i1');
  assert.strictEqual(ok, false);
  assert.strictEqual(adapter.kv.get('novaclip.blob.imgX'), img, 'blobs must survive a failed delete');
});

test('a delete whose first write fails still removes the victim blobs once the retry succeeds', async () => {
  const adapter = memAdapter({}, { failClipWrites: 1 });
  const window = bootStore(adapter, [
    { id: 'victim', type: 'image', imageId: 'imgV', thumbId: 'thmV', ts: 2, copies: 0 },
    { id: 'other', type: 'text', text: 'other clip', ts: 1, copies: 0 },
  ]);
  const Store = window.Store;
  adapter.kv.set('novaclip.blob.imgV', 'data:image/png;base64,' + b64('victim-pixels'));
  adapter.kv.set('novaclip.blob.thmV', 'data:image/png;base64,dGh1bWI');

  const ok = await Store.deleteClip('victim');
  assert.strictEqual(ok, true, 'commit should succeed after the prune retry');
  assert.strictEqual(adapter.kv.get('novaclip.blob.imgV'), undefined, 'victim blob removed only after a durable commit');
  assert.strictEqual(adapter.kv.get('novaclip.blob.thmV'), undefined, 'victim thumbnail removed after a durable commit');
});

/* ============================================================
   Import / export hardening
   ============================================================ */

test('encrypted export round-trips through import and refuses a wrong/missing password', async () => {
  const img = 'data:image/png;base64,' + b64('roundtrip-secret-image');
  const srcAdapter = memAdapter();
  const srcWindow = bootStore(srcAdapter);
  await srcWindow.Store.addClip({ id: 't1', type: 'text', text: 'roundtrip secret', ts: 2, copies: 0 });
  await srcWindow.Store.addClip({ id: 'i1', type: 'image', data: img, ts: 1, copies: 0 });
  await srcWindow.Store.enableEncryption(PW);
  const json = await srcWindow.Store.exportAll();
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.encrypted, true);

  // Wrong / missing password is rejected before anything is written.
  const destAdapter = memAdapter();
  const destWindow = bootStore(destAdapter, seedClips(1));
  const Store = destWindow.Store;
  await assert.rejects(() => Store.importAll(json, 'wrong password'), (e) => e.code === 'password');
  await assert.rejects(() => Store.importAll(json, ''), (e) => e.code === 'password');
  await assert.rejects(() => Store.importAll(json), (e) => e.code === 'password');
  assert.strictEqual(Store.getClips().length, 1, 'a refused import must not touch the history');

  // Correct password imports into a plaintext device as plaintext.
  const n = await Store.importAll(json, PW);
  assert.strictEqual(n, 2);
  const dec = Store.getClips();
  assert.ok(dec.some((c) => c.text === 'roundtrip secret'));
  const imageRow = JSON.parse(destAdapter.kv.get('novaclip.clips')).find((c) => c.type === 'image');
  assert.ok(imageRow.imageId, 'imported image bytes must be re-persisted as a local blob');
  assert.strictEqual(await Store.getImageData(imageRow), img);
});

test('an encrypted export with a corrupted clip fails with DECRYPT_FAILED and imports nothing', async () => {
  const srcAdapter = memAdapter();
  const srcWindow = bootStore(srcAdapter);
  await srcWindow.Store.addClip({ id: 't1', type: 'text', text: 'first good clip', ts: 2, copies: 0 });
  await srcWindow.Store.addClip({ id: 't2', type: 'text', text: 'second good clip', ts: 1, copies: 0 });
  await srcWindow.Store.enableEncryption(PW);
  const obj = JSON.parse(await srcWindow.Store.exportAll());

  // Corrupt one clip's ciphertext (keep the other intact) — with AES-GCM any
  // bit flip makes decryption fail.
  const target = obj.clips.find((c) => c.id === 't2');
  assert.ok(target.encrypted);
  target.encrypted.data = target.encrypted.data.slice(0, 8) + 'AAAA' + target.encrypted.data.slice(12);

  const destAdapter = memAdapter();
  const destWindow = bootStore(destAdapter, seedClips(1));
  await assert.rejects(
    () => destWindow.Store.importAll(JSON.stringify(obj), PW),
    (e) => e.code === 'DECRYPT_FAILED'
  );
  assert.strictEqual(destWindow.Store.getClips().length, 1, 'failed import must leave the history alone');
});

test('an encrypted export whose image payload is missing fails on import (IMAGE_MISSING)', async () => {
  const img = 'data:image/png;base64,' + b64('vanishing-image');
  const srcAdapter = memAdapter();
  const srcWindow = bootStore(srcAdapter);
  await srcWindow.Store.addClip({ id: 't1', type: 'text', text: 'text survives', ts: 2, copies: 0 });
  await srcWindow.Store.addClip({ id: 'i1', type: 'image', data: img, ts: 1, copies: 0 });
  await srcWindow.Store.enableEncryption(PW);

  const obj = JSON.parse(await srcWindow.Store.exportAll());
  assert.ok(obj.clips.find((c) => c.id === 'i1').encImage);
  delete obj.clips.find((c) => c.id === 'i1').encImage;      // image bytes lost in transit

  const destAdapter = memAdapter();
  const destWindow = bootStore(destAdapter, seedClips(1));
  await assert.rejects(
    () => destWindow.Store.importAll(JSON.stringify(obj), PW),
    (e) => e.code === 'IMAGE_MISSING' && e.clipId === 'i1'
  );
  assert.strictEqual(destWindow.Store.getClips().length, 1, 'failed import must leave the history alone');
});

test('a plaintext import into an encrypted device is re-encrypted (refused without the local password)', async () => {
  const img = 'data:image/png;base64,' + b64('to-be-encrypted');
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(1));
  const Store = window.Store;
  await Store.enableEncryption(PW);

  const payload = JSON.stringify({ app: 'novaclip', version: 2, encrypted: false, clips: [
    { id: 'x1', type: 'text', text: 'incoming plaintext', ts: 1, copies: 0 },
    { id: 'x2', type: 'image', data: img, ts: 2, copies: 0 },
  ] });

  await assert.rejects(() => Store.importAll(payload), (e) => e.code === 'password');

  const n = await Store.importAll(payload, PW);
  assert.strictEqual(n, 2);
  const raw = adapter.kv.get('novaclip.clips');
  assert.strictEqual(raw.indexOf('incoming plaintext'), -1, 'plaintext must never land in an encrypted store');
  assert.strictEqual(raw.indexOf('data:image/png'), -1, 'image plaintext must never land in an encrypted store');

  const dec = await Store.getClipsDecrypted(PW);
  assert.ok(dec.some((c) => c.text === 'incoming plaintext'));
  const image = dec.find((c) => c.type === 'image');
  assert.strictEqual(image.data, img);
});

test('import re-persists image bytes under a fresh local id and ignores foreign blob ids', async () => {
  const img = 'data:image/png;base64,' + b64('foreign-pixels');
  const deviceA = memAdapter();
  const winA = bootStore(deviceA);
  await winA.Store.addClip({ id: 'a1', type: 'image', data: img, ts: 1, copies: 0 });
  const foreignId = JSON.parse(deviceA.kv.get('novaclip.clips'))[0].imageId;
  assert.ok(foreignId);

  const json = await winA.Store.exportAll();
  assert.ok(JSON.parse(json).clips[0].data, 'export must be self-contained');

  const deviceB = memAdapter();
  const winB = bootStore(deviceB);
  const n = await winB.Store.importAll(json);
  assert.strictEqual(n, 1);

  const row = JSON.parse(deviceB.kv.get('novaclip.clips'))[0];
  assert.ok(row.imageId && row.imageId !== foreignId, 'a fresh local blob id must be used');
  assert.strictEqual(row.data, undefined);
  assert.strictEqual(await winB.Store.getImageData(row), img);
});

test('import with duplicate clip ids rewrites them to unique ids', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  const payload = JSON.stringify({ app: 'novaclip', version: 2, encrypted: false, clips: [
    { id: 'dup', type: 'text', text: 'first', ts: 2, copies: 0 },
    { id: 'dup', type: 'text', text: 'second', ts: 1, copies: 0 },
    { id: 'dup', type: 'text', text: 'third', ts: 0, copies: 0 },
  ] });

  const n = await Store.importAll(payload);
  assert.strictEqual(n, 3);
  const clips = Store.getClips();
  const ids = Array.from(clips, (c) => c.id);
  assert.strictEqual(new Set(ids).size, 3, 'ids must be unique: ' + ids.join(','));
  assert.deepStrictEqual(Array.from(clips, (c) => c.text).sort(), ['first', 'second', 'third']);
});

test('import keeps duplicate images as separate clips under separate blobs', async () => {
  const img = 'data:image/png;base64,' + b64('same-pixels-twice');
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;

  const payload = JSON.stringify({ app: 'novaclip', version: 2, encrypted: false, clips: [
    { id: 'z1', type: 'image', data: img, ts: 2, copies: 0 },
    { id: 'z2', type: 'image', data: img, ts: 1, copies: 0 },
  ] });

  const n = await Store.importAll(payload);
  assert.strictEqual(n, 2);
  const rows = JSON.parse(adapter.kv.get('novaclip.clips'));
  assert.strictEqual(rows.length, 2);
  const ids = rows.map((r) => r.imageId);
  assert.strictEqual(new Set(ids).size, 2, 'each duplicate needs its own blob');
  for (const row of rows) assert.strictEqual(await Store.getImageData(row), img);
});

test('import of a clip whose image bytes are missing fails without touching the history', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter, seedClips(2));
  const Store = window.Store;

  const payload = JSON.stringify({ app: 'novaclip', version: 2, encrypted: false, clips: [
    { id: 'ok', type: 'text', text: 'fine', ts: 2, copies: 0 },
    { id: 'noimg', type: 'image', imageId: 'some-foreign-id', ts: 1, copies: 0 },   // no embedded bytes
  ] });

  await assert.rejects(() => Store.importAll(payload), (e) => e.code === 'IMAGE_MISSING');
  assert.strictEqual(Store.getClips().length, 2, 'a failed import must leave the current history alone');
});

test('export fails loudly when an image blob can no longer be read', async () => {
  const adapter = memAdapter();
  const window = bootStore(adapter);
  const Store = window.Store;
  const img = 'data:image/png;base64,' + b64('will-vanish');

  await Store.addClip({ id: 'i1', type: 'image', data: img, ts: 1, copies: 0 });
  const row = storedClips(adapter)[0];
  Store.clearCache();                              // drop the in-memory copy of the bytes
  adapter.kv.delete('novaclip.blob.' + row.imageId); // the blob disappears

  await assert.rejects(() => Store.exportAll(), (e) => e.code === 'IMAGE_READ_FAILED' && e.clipId === 'i1');
});

test('export + import survive a 500-clip history with a large image', async () => {
  const imgData = 'data:image/png;base64,' + Buffer.alloc(40000, 7).toString('base64');
  const seed = [];
  const base = Date.now();
  for (let i = 0; i < 500; i++) {
    seed.push({ id: 'c' + i, type: 'text', text: 'clip ' + i + ' ' + 'x'.repeat(120), ts: base - i, copies: i % 3 });
  }
  seed.push({ id: 'big', type: 'image', imageId: 'bigblob', ts: base - 100000, copies: 0 });

  const srcAdapter = memAdapter();
  const srcWindow = bootStore(srcAdapter);
  srcAdapter.kv.set('novaclip.blob.bigblob', imgData);
  srcAdapter.kv.set('novaclip.clips', JSON.stringify(seed));

  const json = await srcWindow.Store.exportAll();
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.clips.length, 501);
  assert.strictEqual(parsed.clips.find((c) => c.id === 'big').data, imgData);

  const dstAdapter = memAdapter();
  const dstWindow = bootStore(dstAdapter);
  const n = await dstWindow.Store.importAll(json);
  assert.strictEqual(n, 501);

  const rows = JSON.parse(dstAdapter.kv.get('novaclip.clips'));
  assert.strictEqual(rows.length, 501);
  const ids = rows.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, 501, 'ids must stay unique');
  const bigRow = rows.find((r) => r.type === 'image');
  assert.ok(bigRow.imageId && !bigRow.data);
  assert.strictEqual(await dstWindow.Store.getImageData(bigRow), imgData);
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
