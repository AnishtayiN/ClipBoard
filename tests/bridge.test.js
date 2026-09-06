'use strict';
/* Integration test: the real renderer scripts (bridge.js + store.js) talking to
   the REAL electron/storage.js through a stubbed IPC layer. This is the code
   path a packaged Windows build actually takes. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../electron/storage');
const { createWindow, loadScripts, read, tick, waitFor } = require('./helpers/harness');

function bootElectronRenderer(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaclip-ipc-'));
  const store = createStore(dir, { prefer: 'file' });

  if (o.seedNative) {
    for (const [k, v] of Object.entries(o.seedNative)) store.set(k, v);
    store.flush();
  }

  const html = read('app/index.html');
  const { window, document } = createWindow(html);

  // bridge.js detects Electron via window.process.type
  Object.defineProperty(window, 'process', { value: { type: 'renderer' }, configurable: true });

  const ipcLog = [];
  window.NovaNative = {
    clipboardSig: async () => 't:' + 'f'.repeat(64),
    readClipboard: async () => ({ text: o.clipboard || 'from main', signature: 't:' + 'f'.repeat(64) }),
    writeClipboard: async () => 't:' + 'e'.repeat(64),
    writeImage: async () => 'i:1x1:' + 'e'.repeat(64),
    onClipboardChange: () => {},
    onCaptureNow: () => {},
    onShortcutTrigger: () => {},
    onWindowHidden: (cb) => { window.__onHidden = cb; },

    storeLoadSync: () => {
      ipcLog.push('load-all');
      return { ok: true, backend: store.backend, kv: store.getAll(), usage: store.usage() };
    },
    storeSet: (k, v) => { ipcLog.push('set:' + k); store.set(k, v); return Promise.resolve({ ok: true }); },
    storeDel: (k) => { ipcLog.push('del:' + k); store.del(k); return Promise.resolve({ ok: true }); },
    storeUsage: () => Promise.resolve({ ok: true, usage: store.usage() }),
    imagePut: (id, d) => { ipcLog.push('image-put'); return Promise.resolve({ ok: true, id: store.putBlob(id, d) }); },
    imageGet: (id) => Promise.resolve({ ok: true, dataUrl: store.getBlob(id) }),
    imageDel: (id) => { store.delBlob(id); return Promise.resolve({ ok: true }); },

    showWindow: () => {}, minimize: () => {}, maximize: () => {}, close: () => {},
    registerShortcut: () => {}, setStartup: () => false, setTray: () => {},
    setCloseToTray: () => {}, notify: () => {}, openExternal: () => {},
    saveFile: () => null, pickFolder: () => null,
  };

  if (o.seedLocalStorage) {
    for (const [k, v] of Object.entries(o.seedLocalStorage)) window.localStorage.setItem(k, v);
  }

  loadScripts(window, ['app/bridge.js', 'app/store.js']);
  return { window, document, store, dir, ipcLog, Bridge: window.Bridge, Store: window.Store };
}

// Boots the FULL renderer (app.js included) against the Electron bridge, so the
// isElectron-only paths run: titlebar, tray/shortcut wiring and the cheap
// clipboard:sig poll loop.
async function bootFullApp(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaclip-full-'));
  const store = createStore(dir, { prefer: 'file' });
  const html = read('app/index.html');
  const { window, document } = createWindow(html);

  Object.defineProperty(window, 'process', { value: { type: 'renderer' }, configurable: true });

  const state = { sig: 't:' + 'a'.repeat(64), text: o.clipboard || 'from main process' };
  const calls = [];
  window.NovaNative = {
    clipboardSig: async () => { calls.push('sig'); return state.sig; },
    readClipboard: async () => {
      calls.push('read');
      return { text: state.text, signature: state.sig };
    },
    writeClipboard: async (t) => { state.text = t; state.sig = 't:' + 'b'.repeat(64); return state.sig; },
    writeImage: async () => 'i:1x1:' + 'b'.repeat(64),
    onClipboardChange: (cb) => { window.__onChanged = cb; },
    onCaptureNow: (cb) => { window.__onCapture = cb; },
    onShortcutTrigger: (cb) => { window.__onShortcut = cb; },
    onWindowHidden: (cb) => { window.__onHidden = cb; },
    storeLoadSync: () => ({ ok: true, backend: store.backend, kv: store.getAll(), usage: store.usage() }),
    storeSet: (k, v) => { store.set(k, v); return Promise.resolve({ ok: true }); },
    storeDel: (k) => { store.del(k); return Promise.resolve({ ok: true }); },
    storeUsage: () => Promise.resolve({ ok: true, usage: store.usage() }),
    imagePut: (id, d) => Promise.resolve({ ok: true, id: store.putBlob(id, d) }),
    imageGet: (id) => Promise.resolve({ ok: true, dataUrl: store.getBlob(id) }),
    imageDel: (id) => { store.delBlob(id); return Promise.resolve({ ok: true }); },
    showWindow: () => { calls.push('show'); }, minimize: () => {}, maximize: () => {}, close: () => {},
    registerShortcut: (accel) => { calls.push('shortcut:' + accel); },
    setStartup: () => false,
    setTray: () => { calls.push('tray'); },
    setCloseToTray: () => {}, notify: () => {}, openExternal: () => {},
    saveFile: () => null, pickFolder: () => null,
  };

  window.__NOVA_TEST__ = true;
  loadScripts(window, ['app/config.js', 'app/i18n.js', 'app/bridge.js', 'app/store.js', 'app/app.js']);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitFor(() => window.NovaTest && window.NovaTest.State, 3000, 'app init');
  await tick(30);
  return { window, document, store, dir, calls, state, Nova: window.NovaTest, Store: window.Store, Bridge: window.Bridge,
           done: () => window.__clearTimers() };
}

test('the renderer detects Electron and uses the native store', () => {
  const r = bootElectronRenderer();
  assert.strictEqual(r.Bridge.platform, 'desktop');
  assert.strictEqual(r.Bridge.isElectron, true);
  assert.strictEqual(r.Bridge.storage.backend, 'native');
  assert.strictEqual(r.Bridge.storage.capacityBytes, null, 'a disk-backed store has no fixed quota');

  // The mirror hydrates lazily, but synchronously, on first access.
  assert.deepStrictEqual(r.ipcLog, [], 'nothing is read before the store is used');
  r.Store.getSettings();
  assert.ok(r.ipcLog.includes('load-all'), 'the renderer must hydrate synchronously at startup');
});

test('clips written by the renderer really land in the main-process store', async () => {
  const r = bootElectronRenderer();
  await r.Store.addClip({ id: 'c1', type: 'text', text: 'persisted through IPC', ts: Date.now(), copies: 0 });
  r.store.flush();

  // A brand new store instance over the same directory must see the clip.
  const reopened = createStore(r.dir, { prefer: 'file' });
  const clips = JSON.parse(reopened.get('novaclip.clips'));
  assert.strictEqual(clips.length, 1);
  assert.strictEqual(clips[0].text, 'persisted through IPC');

  // …and nothing was written to localStorage.
  assert.strictEqual(r.window.localStorage.getItem('novaclip.clips'), null);
});

test('image bytes are written to disk as blobs, not into the JSON document', async () => {
  const r = bootElectronRenderer();
  const img = 'data:image/png;base64,' + Buffer.from('real pixels here').toString('base64');
  const thumb = 'data:image/png;base64,' + Buffer.from('tiny').toString('base64');

  await r.Store.addClip({ id: 'i1', type: 'image', data: img, thumb, ts: Date.now(), copies: 0 });
  r.store.flush();

  const doc = fs.readFileSync(path.join(r.dir, 'store.json'), 'utf8');
  assert.ok(doc.indexOf('real pixels here') === -1, 'no base64 image in the document');
  assert.ok(doc.indexOf(Buffer.from('real pixels here').toString('base64')) === -1);

  const blobFiles = fs.readdirSync(path.join(r.dir, 'blobs')).filter((f) => !f.endsWith('.meta'));
  assert.strictEqual(blobFiles.length, 2, 'one blob for the image, one for the thumbnail');

  const reopened = createStore(r.dir, { prefer: 'file' });
  const row = JSON.parse(reopened.get('novaclip.clips'))[0];
  assert.strictEqual(reopened.getBlob(row.imageId), img);
  assert.strictEqual(reopened.getBlob(row.thumbId), thumb);
});

test('an existing localStorage history is migrated into the native store once', async () => {
  const legacy = [
    { id: 'l1', type: 'text', text: 'legacy clip', ts: 1, copies: 0 },
  ];
  const r = bootElectronRenderer({
    seedLocalStorage: {
      'novaclip.clips': JSON.stringify(legacy),
      'novaclip.settings': JSON.stringify({ lang: 'en', maxHistory: 100 }),
    },
  });

  assert.strictEqual(r.Store.getClips().length, 1, 'history must be readable immediately');
  assert.strictEqual(r.Store.getClips()[0].text, 'legacy clip');
  assert.strictEqual(r.Store.getSettings().lang, 'en');

  // Give the async write-through a chance to run, then check the disk.
  await tick(20);
  r.store.flush();

  const reopened = createStore(r.dir, { prefer: 'file' });
  const migrated = JSON.parse(reopened.get('novaclip.clips'));
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].text, 'legacy clip');
  assert.ok(reopened.get('novaclip.migratedFromLocalStorage'), 'the migration should be recorded');
});

test('migration does not clobber an existing native history', async () => {
  const r = bootElectronRenderer({
    seedNative: { 'novaclip.clips': JSON.stringify([{ id: 'n1', type: 'text', text: 'native', ts: 1, copies: 0 }]) },
    seedLocalStorage: { 'novaclip.clips': JSON.stringify([{ id: 'l1', type: 'text', text: 'legacy', ts: 1, copies: 0 }]) },
  });

  assert.strictEqual(r.Store.getClips().length, 1);
  assert.strictEqual(r.Store.getClips()[0].text, 'native');
});

test('storage usage comes from the backend, not from localStorage accounting', async () => {
  const r = bootElectronRenderer();
  await r.Store.addClip({ id: 'c1', type: 'text', text: 'x'.repeat(2000), ts: Date.now(), copies: 0 });
  const usage = await r.Store.refreshUsage();

  assert.strictEqual(usage.backend, 'file');
  assert.ok(usage.kvBytes > 1000, 'backend should report the document size: ' + usage.kvBytes);
  assert.strictEqual(r.Store.isStorageNearQuota(), false, 'a disk-backed store is never "near quota"');
  assert.strictEqual(r.Store.storageInfo().capacity, null);
});

test('the window-hidden event reaches the bridge so the app can auto-lock', () => {
  const r = bootElectronRenderer();
  let fired = 0;
  r.Bridge.onWindowHidden(() => { fired++; });
  assert.strictEqual(typeof r.window.__onHidden, 'function');
  r.window.__onHidden();
  assert.strictEqual(fired, 1);
});

/* ---------- full app over the Electron bridge ---------- */

test('the full app boots on the Electron bridge and wires tray + shortcut', async () => {
  const r = await bootFullApp();
  try {
    assert.strictEqual(r.Bridge.platform, 'desktop');
    assert.ok(r.calls.includes('tray'), 'tray must be set up');
    assert.ok(r.calls.some((c) => c.indexOf('shortcut:') === 0), 'global shortcut must be registered');
    assert.ok(!r.document.getElementById('titlebar').classList.contains('hidden'), 'titlebar shows on desktop');
    assert.strictEqual(r.document.getElementById('storage-backend').textContent, 'File');
  } finally { r.done(); }
});

test('the Electron poll loop uses the cheap sig channel and captures on change', async () => {
  const r = await bootFullApp({ clipboard: 'first payload' });
  try {
    r.calls.length = 0;

    // Unchanged clipboard: the main process notifies, the read is deduped.
    await r.Nova.captureClipboard();
    assert.strictEqual(r.Nova.State.clips.length, 1);

    // Main reports a new fingerprint -> a full read happens and the clip lands.
    r.state.sig = 't:' + 'c'.repeat(64);
    r.state.text = 'second payload';
    await r.Nova.captureClipboard();

    assert.strictEqual(r.Nova.State.clips.length, 2);
    assert.ok(r.calls.includes('read'), 'a changed fingerprint must trigger a full read');
    assert.deepStrictEqual([...r.Nova.State.clips.map((c) => c.text)].sort(), ['first payload', 'second payload']);

    // Everything the renderer captured is on disk in the main-process store.
    r.store.flush();
    const reopened = createStore(r.dir, { prefer: 'file' });
    assert.strictEqual(JSON.parse(reopened.get('novaclip.clips')).length, 2);
  } finally { r.done(); }
});

test('the tray "capture now" and shortcut events reach the app', async () => {
  const r = await bootFullApp({ clipboard: 'tray capture' });
  try {
    assert.strictEqual(typeof r.window.__onCapture, 'function');
    assert.strictEqual(typeof r.window.__onShortcut, 'function');

    r.state.sig = 't:' + 'd'.repeat(64);
    await r.window.__onCapture();
    assert.strictEqual(r.Nova.State.clips.length, 1);
    assert.strictEqual(r.Nova.State.clips[0].text, 'tray capture');

    // The shortcut handler must not throw when the history is unlocked.
    r.window.__onShortcut();
  } finally { r.done(); }
});
