/* ============================================================
   NovaClip — Electron main process
   Targets Windows 7 → 11 (Electron 22 / Chromium 108)

   SECURITY & ARCHITECTURE
   -----------------------
   - Clipboard change detection uses a SHA-256 content fingerprint that is
     computed *here* and shipped to the renderer, so main and renderer can
     never disagree about what "the same clipboard" means (the renderer used
     to fall back to a length-based signature, which treated "hello123" and
     "world456" as identical).
   - A cheap `clipboard:sig` channel lets the renderer poll for *changes*
     without paying for a full clipboard read (base64 image included).
   - Persistence lives in the main process (SQLite or an atomic JSON file),
     not in the renderer's 5 MB localStorage quota.
   - contextIsolation + sandbox, no nodeIntegration.
   ============================================================ */
const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, Notification, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('./storage');

let win = null;
let tray = null;
let isQuitting = false;
let closeToTray = true;
let lastClipSig = null;
let pollTimer = null;
let store = null;

const APP_DIR = path.join(__dirname, '..', 'app');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

/* ============================================================
   Clipboard fingerprinting
   ============================================================ */

// SHA-256 (not MD5): it is only used as a change-detection fingerprint, but a
// collision-resistant digest keeps the value usable if it is ever logged,
// compared across machines, or reused for dedup keys.
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function imageSig(img) {
  const size = img.getSize();
  // toBitmap() is a raw BGRA memcpy — much cheaper than re-encoding to PNG on
  // every poll, and it is exactly what the OS handed us.
  return 'i:' + size.width + 'x' + size.height + ':' + sha256(img.toBitmap());
}

function clipboardSig() {
  let formats = [];
  try { formats = clipboard.availableFormats() || []; } catch (e) { formats = []; }
  const hasText = formats.length === 0 || formats.some(f => String(f).indexOf('text') !== -1);
  const hasImage = formats.length === 0 || formats.some(f => String(f).indexOf('image') !== -1);

  if (hasText) {
    const text = clipboard.readText();
    if (text && text.length) return 't:' + sha256(text);
  }
  if (hasImage) {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) return imageSig(img);
  }
  return 'empty';
}

// Full read. Always carries the signature so the renderer never has to invent
// its own (that was the source of the length-based false positives).
function readClipboardFull() {
  let formats = [];
  try { formats = clipboard.availableFormats() || []; } catch (e) { formats = []; }
  const result = {};

  if (formats.length === 0 || formats.some(f => String(f).indexOf('text') !== -1)) {
    const text = clipboard.readText();
    if (text && text.length) result.text = text;
  }
  if (formats.length === 0 || formats.some(f => String(f).indexOf('image') !== -1)) {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) result.image = img.toDataURL();
  }

  if (!result.text && !result.image) return { signature: 'empty' };

  result.signature = result.text
    ? 't:' + sha256(result.text)
    : imageSig(nativeImage.createFromDataURL(result.image));
  return result;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const sig = clipboardSig();
    if (sig !== lastClipSig) {
      lastClipSig = sig;
      notifyRenderer('clipboard-changed');
    }
  }, 700);
}

/* ============================================================
   Window / tray
   ============================================================ */

// webContents.send() before the page has loaded is silently dropped — queue the
// event instead so a global-shortcut press on a cold start still reaches the UI.
function notifyRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  const send = () => { try { win.webContents.send(channel, payload); } catch (e) { /* window went away */ } };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: '#0b0f1a',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(APP_DIR, 'index.html'));

  win.once('ready-to-show', () => win.show());

  // The renderer drops decrypted plaintext from memory when it hears this.
  win.on('hide', () => notifyRenderer('window-hidden'));

  win.on('close', (e) => {
    if (closeToTray && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });
}

function showMainWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  try {
    let icon = null;
    if (fs.existsSync(ICON_PATH)) icon = nativeImage.createFromPath(ICON_PATH);
    if (icon && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon || nativeImage.createEmpty());
    const menu = Menu.buildFromTemplate([
      { label: 'Open NovaClip', click: () => showMainWindow() },
      { label: 'Capture now', click: () => notifyRenderer('capture-now') },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('NovaClip');
    tray.setContextMenu(menu);
    tray.on('double-click', () => showMainWindow());
  } catch (e) { /* tray not critical */ }
}

// Main -> IPC -> Renderer. Registered once from the default shortcut and
// re-registered whenever the user changes the accelerator.
function onGlobalShortcut() {
  showMainWindow();
  notifyRenderer('shortcut-trigger');
}

/* ============================================================
   IPC — clipboard
   ============================================================ */
ipcMain.handle('clipboard:sig', () => clipboardSig());

ipcMain.handle('clipboard:read', () => readClipboardFull());

// Both writers return the signature they installed so the renderer can suppress
// its own echo exactly, instead of guessing.
ipcMain.handle('clipboard:write', (e, text) => {
  const value = String(text == null ? '' : text);
  lastClipSig = 't:' + sha256(value);
  clipboard.writeText(value);
  return lastClipSig;
});

ipcMain.handle('clipboard:write-image', (e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (!img || img.isEmpty()) return lastClipSig;
  lastClipSig = imageSig(img);
  clipboard.writeImage(img);
  return lastClipSig;
});

/* ============================================================
   IPC — persistence (main-process store)
   ============================================================ */
// Synchronous on purpose: the renderer hydrates its in-memory mirror during
// script evaluation and must not have to await to read a setting.
// Lazily created so an early renderer request (before app.whenReady resolved)
// still gets a working store.
function getStore() {
  if (!store) store = createStore(app.getPath('userData'));
  return store;
}

ipcMain.on('store:load-all', (e) => {
  try {
    const s = getStore();
    e.returnValue = { ok: true, backend: s.backend, kv: s.getAll(), usage: s.usage() };
  } catch (err) {
    e.returnValue = { ok: false, backend: null, kv: {}, usage: null, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('store:set', (e, key, value) => {
  try { getStore().set(String(key), value == null ? '' : String(value)); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.name || err) }; }
});

ipcMain.handle('store:del', (e, key) => {
  try { getStore().del(String(key)); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.name || err) }; }
});

ipcMain.handle('store:usage', () => { try { return { ok: true, usage: getStore().usage() }; } catch (err) { return { ok: false }; } });

ipcMain.handle('store:image-put', (e, id, dataUrl) => {
  try { return { ok: true, id: getStore().putBlob(id, dataUrl) }; }
  catch (err) { return { ok: false, error: String(err && err.name || err) }; }
});

ipcMain.handle('store:image-get', (e, id) => {
  try { return { ok: true, dataUrl: getStore().getBlob(id) }; }
  catch (err) { return { ok: false, error: String(err && err.name || err) }; }
});

ipcMain.handle('store:image-del', (e, id) => {
  try { getStore().delBlob(id); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.name || err) }; }
});

/* ============================================================
   IPC — window / app
   ============================================================ */
ipcMain.on('window:minimize', () => { if (win) win.minimize(); });
ipcMain.on('window:maximize', () => { if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } });
ipcMain.on('window:close', () => { if (win) win.close(); });
ipcMain.on('window:show', () => showMainWindow());

ipcMain.on('shortcut:register', (e, accel) => {
  try {
    globalShortcut.unregisterAll();
    if (accel && typeof accel === 'string' && accel.trim()) {
      globalShortcut.register(accel.trim(), onGlobalShortcut);
    }
  } catch (err) { /* ignore invalid accelerator */ }
});

ipcMain.on('tray:setup', () => createTray());
ipcMain.on('set-close-to-tray', (e, v) => { closeToTray = !!v; });

ipcMain.handle('set-startup', (e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
    return true;
  } catch (err) { return false; }
});

ipcMain.on('notify', (e, title, body) => {
  try { new Notification({ title, body }).show(); } catch (err) { /* ignore */ }
});

ipcMain.on('external:open', (e, url) => {
  // Only http(s) ever leaves the app.
  if (url && /^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});

ipcMain.handle('file:save', async (e, name, content) => {
  try {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: name || 'novaclip-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  } catch (err) { return null; }
});

ipcMain.handle('folder:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  } catch (err) { return null; }
});

/* ============================================================
   Lifecycle
   ============================================================ */
const gotLock = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    try { getStore(); } catch (e) { store = null; }
    createWindow();
    startPolling();
    try { globalShortcut.register('CommandOrControl+Shift+V', onGlobalShortcut); } catch (e) { /* ignore */ }
  });

  app.on('before-quit', () => { isQuitting = true; if (store) { try { store.flush(); } catch (e) { /* ignore */ } } });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (store) { try { store.close(); } catch (e) { /* ignore */ } } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// Exposed for the test suite (tests/main.test.js) — harmless at runtime.
module.exports = { sha256, clipboardSig, readClipboardFull, imageSig, notifyRenderer, onGlobalShortcut };
