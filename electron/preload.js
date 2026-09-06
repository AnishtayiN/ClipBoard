/* ============================================================
   NovaClip — preload (contextBridge API exposed as NovaNative)

   Everything the renderer can touch is listed here explicitly; the renderer
   runs sandboxed with contextIsolation and has no Node access.
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

const EMPTY = {};

contextBridge.exposeInMainWorld('NovaNative', {
  /* ---------- clipboard ---------- */
  // Cheap: fingerprint only, no payload. Used by the renderer's poll loop.
  clipboardSig: () => ipcRenderer.invoke('clipboard:sig'),
  // Full read. Resolves to { text?, image?, signature }.
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  // Both writers resolve to the signature that main installed, so the renderer
  // can suppress its own echo exactly.
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  writeImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),

  onClipboardChange: (cb) => { ipcRenderer.on('clipboard-changed', () => cb()); },
  onCaptureNow: (cb) => { ipcRenderer.on('capture-now', () => cb()); },
  onShortcutTrigger: (cb) => { ipcRenderer.on('shortcut-trigger', () => cb()); },
  // Fired when the window is hidden (close-to-tray): the renderer uses it to
  // drop decrypted plaintext from memory.
  onWindowHidden: (cb) => { ipcRenderer.on('window-hidden', () => cb()); },

  /* ---------- persistent store (main process) ---------- */
  // Synchronous on purpose — the renderer hydrates during script evaluation.
  storeLoadSync: () => ipcRenderer.sendSync('store:load-all'),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),
  storeDel: (key) => ipcRenderer.invoke('store:del', key),
  storeUsage: () => ipcRenderer.invoke('store:usage'),
  imagePut: (id, dataUrl) => ipcRenderer.invoke('store:image-put', id, dataUrl),
  imageGet: (id) => ipcRenderer.invoke('store:image-get', id),
  imageDel: (id) => ipcRenderer.invoke('store:image-del', id),

  /* ---------- window / app ---------- */
  showWindow: () => ipcRenderer.send('window:show'),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  registerShortcut: (accel, cb) => {
    if (typeof cb === 'function') ipcRenderer.on('shortcut-trigger', () => cb());
    ipcRenderer.send('shortcut:register', accel);
  },
  setStartup: (on) => ipcRenderer.invoke('set-startup', on),
  setTray: () => ipcRenderer.send('tray:setup'),
  setCloseToTray: (v) => ipcRenderer.send('set-close-to-tray', v),

  notify: (title, body) => ipcRenderer.send('notify', title, body),
  openExternal: (url) => ipcRenderer.send('external:open', url),
  saveFile: (name, content) => ipcRenderer.invoke('file:save', name, content),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
});

// Keep the reference alive; some bundlers otherwise drop the unused binding.
void EMPTY;
