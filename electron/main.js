/* ============================================================
   NovaClip — Electron main process
   Targets Windows 7 → 11 (Electron 22 / Chromium 108)
   
   SECURITY & BUG FIXES:
   - Hash-based clipboard change detection
   - Proper IPC for shortcut triggers
   - Sandbox enabled for security
   ============================================================ */
const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, Notification, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let win = null;
let tray = null;
let isQuitting = false;
let closeToTray = true;
let lastClipSig = null;
let pollTimer = null;

const APP_DIR = path.join(__dirname, '..', 'app');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

// FIX #3: Hash-based clipboard change detection
function clipboardSig() {
  const text = clipboard.readText();
  if (text && text.length) {
    // Use MD5 hash of text for reliable change detection
    const hash = crypto.createHash('md5').update(text).digest('hex');
    return 't:' + hash;
  }
  const img = clipboard.readImage();
  if (img && !img.isEmpty()) {
    // Use hash of image data for reliable image detection
    const data = img.toPNG();
    const hash = crypto.createHash('md5').update(data).digest('hex');
    const size = img.getSize();
    return 'i:' + size.width + 'x' + size.height + ':' + hash;
  }
  return 'empty';
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const sig = clipboardSig();
    if (sig !== lastClipSig) {
      lastClipSig = sig;
      if (win && !win.isDestroyed()) win.webContents.send('clipboard-changed');
    }
  }, 700);
}

// FIX #4: Clipboard format detection for text+image
function readClipboardFull() {
  const formats = clipboard.availableFormats();
  const result = {};
  
  // Check for text formats
  if (formats.some(f => f.includes('text'))) {
    const text = clipboard.readText();
    if (text && text.length) result.text = text;
  }
  
  // Check for image formats
  if (formats.some(f => f.includes('image'))) {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) result.image = img.toDataURL();
  }
  
  return Object.keys(result).length > 0 ? result : null;
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
      sandbox: true, // FIX #6: Enable sandbox for security
      spellcheck: false,
    },
  });

  win.loadFile(path.join(APP_DIR, 'index.html'));

  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (closeToTray && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    let icon = null;
    if (fs.existsSync(ICON_PATH)) icon = nativeImage.createFromPath(ICON_PATH);
    if (icon && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon || nativeImage.createEmpty());
    const menu = Menu.buildFromTemplate([
      { label: 'Open NovaClip', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { label: 'Capture now', click: () => { if (win) win.webContents.send('capture-now'); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('NovaClip');
    tray.setContextMenu(menu);
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  } catch (e) { /* tray not critical */ }
}

/* ---------- IPC ---------- */
// FIX #4: Use full clipboard reading with format detection
ipcMain.handle('clipboard:read', () => {
  return readClipboardFull() || {};
});

ipcMain.on('clipboard:write', (e, text) => {
  lastClipSig = 't:' + crypto.createHash('md5').update(text || '').digest('hex');
  clipboard.writeText(String(text == null ? '' : text));
});

ipcMain.on('clipboard:write-image', (e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img && !img.isEmpty()) {
    lastClipSig = 'i:' + crypto.createHash('md5').update(img.toPNG()).digest('hex');
    clipboard.writeImage(img);
  }
});

ipcMain.on('window:minimize', () => { if (win) win.minimize(); });
ipcMain.on('window:maximize', () => { if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } });
ipcMain.on('window:close', () => { if (win) win.close(); });

ipcMain.on('window:show', () => { if (win) { win.show(); win.focus(); } });

// FIX #5: Proper shortcut handling with IPC trigger to renderer
ipcMain.on('shortcut:register', (e, accel) => {
  try {
    globalShortcut.unregisterAll();
    if (accel && typeof accel === 'string' && accel.trim()) {
      globalShortcut.register(accel.trim(), () => {
        // FIX: Send IPC event to renderer BEFORE showing window
        // This follows the correct architecture: Main -> IPC -> Renderer
        if (!win || win.isDestroyed()) {
          createWindow();
        }
        win.show();
        win.focus();
        // Send trigger event to renderer
        win.webContents.send('shortcut-trigger');
      });
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
  try { new Notification({ title, body }).show(); } catch (err) {}
});

ipcMain.on('external:open', (e, url) => {
  // فقط آدرس‌های http/https را در مرورگر پیش‌فرض باز می‌کنیم
  if (url && /^https?:\/\//i.test(String(url))) {
    shell.openExternal(String(url));
  }
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

/* ---------- lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    createWindow();
    startPolling();
    // default global shortcut
    try {
      globalShortcut.register('CommandOrControl+Shift+V', () => {
        if (!win || win.isDestroyed()) {
          createWindow();
        }
        win.show();
        win.focus();
        // FIX #5: Send IPC trigger to renderer
        win.webContents.send('shortcut-trigger');
      });
    } catch (e) {}
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
