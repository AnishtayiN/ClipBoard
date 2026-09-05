/* ============================================================
   NovaClip — preload (contextBridge API exposed as NovaNative)
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('NovaNative', {
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  writeImage: (dataUrl) => ipcRenderer.send('clipboard:write-image', dataUrl),

  onClipboardChange: (cb) => {
    ipcRenderer.on('clipboard-changed', () => cb());
  },

  showWindow: () => ipcRenderer.send('window:show'),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  registerShortcut: (accel, cb) => {
    ipcRenderer.on('shortcut-trigger', () => cb());
    ipcRenderer.send('shortcut:register', accel);
  },
  setStartup: (on) => ipcRenderer.invoke('set-startup', on),
  setTray: () => ipcRenderer.send('tray:setup'),
  setCloseToTray: (v) => ipcRenderer.send('set-close-to-tray', v),

  notify: (title, body) => ipcRenderer.send('notify', title, body),
  saveFile: (name, content) => ipcRenderer.invoke('file:save', name, content),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
});
