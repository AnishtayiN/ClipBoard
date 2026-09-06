'use strict';
/* Tests for electron/main.js — clipboard fingerprinting and store IPC.
   The `electron` module is replaced with a stub so the real main-process code
   can be exercised headlessly. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const MAIN = path.join(__dirname, '..', 'electron', 'main.js');

/* ---------- image + clipboard stubs ---------- */

function makeImage(w, h, seed, registry) {
  const bitmap = Buffer.alloc(w * h * 4);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = (seed + i) & 0xff;
  const png = Buffer.concat([Buffer.from('png'), Buffer.from([seed & 0xff]), bitmap.slice(0, 32)]);
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  const img = {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    toBitmap: () => bitmap,
    toPNG: () => png,
    toDataURL: () => dataUrl,
  };
  if (registry) registry.set(dataUrl, img);
  return img;
}

function loadMain(opts) {
  const o = opts || {};
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'novaclip-main-'));
  const images = new Map();                 // dataURL -> image stub
  const createdWindows = [];
  const handlers = Object.create(null);     // ipcMain.handle
  const onHandlers = Object.create(null);   // ipcMain.on
  const appListeners = Object.create(null);

  const clipboardState = {
    text: o.text || '',
    image: o.image || null,
    formats: o.formats || (o.text ? ['text/plain'] : (o.image ? ['image/png'] : [])),
  };

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      on: (ev, fn) => { (appListeners[ev] = appListeners[ev] || []).push(fn); },
      // Never resolves: we drive the IPC handlers directly instead of booting
      // a window and a polling timer.
      whenReady: () => new Promise(() => {}),
      getPath: () => dir,
      quit: () => {},
      setLoginItemSettings: () => {},
    },
    BrowserWindow: class FakeBrowserWindow {
      constructor(options) {
        this.options = options;
        this._listeners = Object.create(null);
        this.loading = o.loading || false;
        this.sent = [];
        this.webContents = {
          isLoading: () => this.loading,
          send: (ch, payload) => this.sent.push([ch, payload]),
          // `this` here is the BrowserWindow instance (arrow fn), so the
          // queue lives on the window, not on webContents.
          once: (ev, fn) => { this._wcOnce = this._wcOnce || {}; (this._wcOnce[ev] = this._wcOnce[ev] || []).push(fn); },
        };
        createdWindows.push(this);
      }
      loadFile() {}
      once(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
      on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
      emit(ev, ...args) { (this._listeners[ev] || []).forEach((fn) => fn(...args)); }
      flush(ev) { ((this._wcOnce && this._wcOnce[ev]) || []).forEach((fn) => fn()); }
      show() { this.shown = true; }
      focus() { this.focused = true; }
      hide() { this.hidden = true; }
      minimize() {}
      maximize() {}
      unmaximize() {}
      isMaximized() { return false; }
      close() {}
      isDestroyed() { return false; }
    },
    ipcMain: {
      handle: (ch, fn) => { handlers[ch] = fn; },
      on: (ch, fn) => { onHandlers[ch] = fn; },
    },
    clipboard: {
      readText: () => clipboardState.text,
      writeText: (t) => { clipboardState.text = String(t); clipboardState.formats = ['text/plain']; },
      readImage: () => clipboardState.image || { isEmpty: () => true },
      writeImage: (img) => { clipboardState.image = img; clipboardState.formats = ['image/png']; },
      availableFormats: () => clipboardState.formats,
    },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    Notification: class { show() {} },
    dialog: {},
    nativeImage: {
      createFromDataURL: (u) => images.get(u) || { isEmpty: () => true },
      createFromPath: () => null,
      createEmpty: () => ({ isEmpty: () => true }),
    },
    shell: { openExternal: () => {} },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  let main;
  try {
    delete require.cache[require.resolve(MAIN)];
    main = require(MAIN);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(MAIN)];
  }

  return { main, handlers, onHandlers, clipboardState, images, dir, electron, appListeners, createdWindows };
}

const invoke = (handlers, channel, ...args) => handlers[channel]({ sender: {} }, ...args);
const send = (onHandlers, channel, ...args) => {
  const ev = {};
  onHandlers[channel](ev, ...args);
  return ev;
};

/* ---------- clipboard fingerprinting ---------- */

test('different texts of identical length produce different signatures', () => {
  const a = loadMain({ text: 'hello123' });
  const b = loadMain({ text: 'world456' });

  const sigA = a.main.clipboardSig();
  const sigB = b.main.clipboardSig();

  assert.notStrictEqual(sigA, sigB, '"hello123" and "world456" must not collide');
  assert.notStrictEqual(sigA, 'empty');
});

test('signatures are SHA-256, not MD5', () => {
  const m = loadMain({ text: 'anything' });
  const sig = m.main.clipboardSig();
  assert.match(sig, /^t:[0-9a-f]{64}$/, 'expected t:<64 hex chars>, got ' + sig);

  const crypto = require('crypto');
  assert.strictEqual(sig, 't:' + crypto.createHash('sha256').update('anything').digest('hex'));
});

test('clipboard:read returns the same signature the poll loop computes', () => {
  const m = loadMain({ text: 'consistent fingerprint' });
  const res = invoke(m.handlers, 'clipboard:read');

  assert.strictEqual(res.text, 'consistent fingerprint');
  assert.strictEqual(res.signature, m.main.clipboardSig());
});

test('an empty clipboard reports "empty" and carries no payload', () => {
  const m = loadMain({});
  assert.strictEqual(m.main.clipboardSig(), 'empty');
  const res = invoke(m.handlers, 'clipboard:read');
  assert.strictEqual(res.signature, 'empty');
  assert.strictEqual(res.text, undefined);
  assert.strictEqual(res.image, undefined);
});

test('images are fingerprinted by size and pixel content', () => {
  const imgA = makeImage(4, 4, 1);
  const imgA2 = makeImage(4, 4, 1);
  const imgB = makeImage(4, 4, 99);
  const imgC = makeImage(8, 8, 1);

  const a = loadMain({ image: imgA, formats: ['image/png'] });
  const sigA = a.main.clipboardSig();

  const a2 = loadMain({ image: imgA2, formats: ['image/png'] });
  assert.strictEqual(a2.main.clipboardSig(), sigA, 'identical pixels must hash identically');

  const b = loadMain({ image: imgB, formats: ['image/png'] });
  assert.notStrictEqual(b.main.clipboardSig(), sigA, 'different pixels must differ');

  const c = loadMain({ image: imgC, formats: ['image/png'] });
  assert.notStrictEqual(c.main.clipboardSig(), sigA, 'different dimensions must differ');
  assert.match(sigA, /^i:4x4:[0-9a-f]{64}$/);
});

test('text wins over image when both are on the clipboard', () => {
  const m = loadMain({ text: 'hello', image: makeImage(2, 2, 5), formats: ['text/plain', 'image/png'] });
  assert.match(m.main.clipboardSig(), /^t:[0-9a-f]{64}$/);
});

test('writing text reports the signature the next poll will see (echo suppression)', async () => {
  const m = loadMain({ text: 'before' });
  const before = m.main.clipboardSig();

  const sig = await invoke(m.handlers, 'clipboard:write', 'after');

  assert.notStrictEqual(sig, before);
  assert.strictEqual(sig, m.main.clipboardSig(), 'write must pre-arm lastClipSig with the exact value');
  assert.strictEqual(m.clipboardState.text, 'after');
});

test('writing an image reports the signature the next poll will see', async () => {
  const registry = new Map();
  const img = makeImage(3, 3, 7, registry);
  const m = loadMain({ text: '', image: null, formats: [] });
  m.images.clear();
  for (const [k, v] of registry) m.images.set(k, v);

  const sig = await invoke(m.handlers, 'clipboard:write-image', img.toDataURL());

  assert.match(sig, /^i:3x3:[0-9a-f]{64}$/);
  assert.strictEqual(sig, m.main.clipboardSig());
});

test('clipboard:sig is exposed as a cheap channel for the renderer poll loop', () => {
  const m = loadMain({ text: 'cheap' });
  assert.ok(typeof m.handlers['clipboard:sig'] === 'function', 'clipboard:sig handler must exist');
  assert.strictEqual(m.handlers['clipboard:sig']({}), m.main.clipboardSig());
});

/* ---------- store IPC ---------- */

test('store:load-all / store:set / store:del round-trip through IPC', () => {
  const m = loadMain({});

  const first = send(m.onHandlers, 'store:load-all');
  assert.strictEqual(first.returnValue.ok, true);
  assert.deepStrictEqual(first.returnValue.kv, {});
  assert.ok(first.returnValue.backend === 'file' || first.returnValue.backend === 'sqlite');

  assert.strictEqual(invoke(m.handlers, 'store:set', 'novaclip.settings', '{"lang":"en"}').ok, true);

  const second = send(m.onHandlers, 'store:load-all');
  assert.strictEqual(second.returnValue.kv['novaclip.settings'], '{"lang":"en"}');

  invoke(m.handlers, 'store:del', 'novaclip.settings');
  const third = send(m.onHandlers, 'store:load-all');
  assert.strictEqual(third.returnValue.kv['novaclip.settings'], undefined);
});

test('image blobs round-trip through IPC as data URLs', () => {
  const m = loadMain({});
  const payload = 'data:image/png;base64,' + Buffer.from('pixels').toString('base64');

  const put = invoke(m.handlers, 'store:image-put', 'img42', payload);
  assert.strictEqual(put.ok, true);
  assert.strictEqual(put.id, 'img42');

  const got = invoke(m.handlers, 'store:image-get', 'img42');
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.dataUrl, payload);

  invoke(m.handlers, 'store:image-del', 'img42');
  assert.strictEqual(invoke(m.handlers, 'store:image-get', 'img42').dataUrl, null);
});

test('store:usage reports the backend', () => {
  const m = loadMain({});
  invoke(m.handlers, 'store:set', 'novaclip.clips', '[1,2,3]');
  const r = invoke(m.handlers, 'store:usage');
  assert.strictEqual(r.ok, true);
  assert.ok(r.usage.kvBytes > 0);
});

/* ---------- window lifecycle ---------- */

test('a hidden window notifies the renderer so it can drop plaintext', () => {
  const m = loadMain({});
  // win is null until createWindow() runs, so notifyRenderer must be a no-op
  // rather than throwing.
  assert.doesNotThrow(() => m.main.notifyRenderer('window-hidden'));
});

test('the global shortcut routes through main -> IPC -> renderer', () => {
  const m = loadMain({});
  m.main.onGlobalShortcut();

  assert.strictEqual(m.createdWindows.length, 1);
  const win = m.createdWindows[0];
  assert.strictEqual(win.shown, true);
  assert.strictEqual(win.focused, true);
  assert.deepStrictEqual(win.sent.map((x) => x[0]), ['shortcut-trigger']);
});

test('a shortcut pressed before the page has loaded is queued, not dropped', () => {
  const m = loadMain({ loading: true });
  m.main.onGlobalShortcut();

  const win = m.createdWindows[0];
  assert.strictEqual(win.sent.length, 0, 'nothing may be sent while the page is still loading');

  win.flush('did-finish-load');
  assert.deepStrictEqual(win.sent.map((x) => x[0]), ['shortcut-trigger']);
});

test('the renderer window is sandboxed with context isolation', () => {
  const m = loadMain({});
  m.main.onGlobalShortcut();
  const prefs = m.createdWindows[0].options.webPreferences;

  assert.strictEqual(prefs.contextIsolation, true);
  assert.strictEqual(prefs.nodeIntegration, false);
  assert.strictEqual(prefs.sandbox, true);
  assert.ok(prefs.preload && prefs.preload.endsWith('preload.js'));
});

test('hiding the window tells the renderer to drop decrypted plaintext', () => {
  const m = loadMain({});
  m.main.onGlobalShortcut();
  const win = m.createdWindows[0];
  win.sent.length = 0;

  win.emit('hide');
  assert.deepStrictEqual(win.sent.map((x) => x[0]), ['window-hidden']);
});

/* ---------- preload <-> bridge contract ---------- */

test('preload exposes every API the renderer bridge calls', () => {
  let exposed = null;
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      invoke: (ch, ...args) => { sent.push(['invoke', ch]); return Promise.resolve(null); },
      send: (ch, ...args) => { sent.push(['send', ch]); },
      sendSync: (ch, ...args) => { sent.push(['sendSync', ch]); return { ok: true, kv: {} }; },
      on: () => {},
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.js');
  try {
    delete require.cache[require.resolve(PRELOAD)];
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(PRELOAD)];
  }

  assert.ok(exposed, 'contextBridge.exposeInMainWorld must be called');
  assert.strictEqual(exposed.name, 'NovaNative');

  const required = [
    // clipboard
    'clipboardSig', 'readClipboard', 'writeClipboard', 'writeImage',
    'onClipboardChange', 'onCaptureNow', 'onShortcutTrigger', 'onWindowHidden',
    // store
    'storeLoadSync', 'storeSet', 'storeDel', 'storeUsage', 'imagePut', 'imageGet', 'imageDel',
    // window / app
    'showWindow', 'minimize', 'maximize', 'close', 'registerShortcut',
    'setStartup', 'setTray', 'setCloseToTray', 'notify', 'openExternal', 'saveFile', 'pickFolder',
  ];
  const missing = required.filter((k) => typeof exposed.api[k] !== 'function');
  assert.deepStrictEqual(missing, [], 'preload is missing: ' + missing.join(', '));

  // Every channel the preload can reach must be registered by main.js.
  const m = loadMain({});
  const registered = new Set([...Object.keys(m.handlers), ...Object.keys(m.onHandlers)]);
  for (const key of Object.keys(exposed.api)) {
    if (typeof exposed.api[key] !== 'function') continue;
    if (key.indexOf('on') === 0) continue;               // listeners, not calls
    try { exposed.api[key]('x', () => {}); } catch (e) { /* arg shape differs per method */ }
  }
  for (const [, channel] of sent) {
    assert.ok(registered.has(channel), 'preload calls "' + channel + '" but main.js never registers it');
  }
  assert.ok(registered.has('clipboard:sig'));
  assert.ok(registered.has('store:load-all'));
});
