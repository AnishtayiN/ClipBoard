/* ============================================================
   NovaClip — platform bridge (Electron / Android / browser)
   Detects the runtime and exposes a unified API.
   ============================================================ */
(function () {
  const isElectron = !!(window.process && window.process.type) || !!(window.require && window.navigator && /electron/i.test(navigator.userAgent));
  const isAndroid = !!window.Capacitor && !!window.Capacitor.Plugins && !!window.Capacitor.Plugins.ClipboardManager;
  const isCapacitor = !!window.Capacitor;

  const Bridge = {
    isElectron,
    isAndroid,
    isCapacitor,
    platform: isElectron ? 'desktop' : (isAndroid ? 'android' : 'web'),
  };

  if (isElectron) {
    // Electron: main/preload exposed via contextBridge as window.NovaNative
    const native = window.NovaNative || {};
    Bridge.readClipboard = () => native.readClipboard ? native.readClipboard() : null;
    Bridge.writeClipboard = (text) => { if (native.writeClipboard) native.writeClipboard(text); };
    Bridge.writeImage = (dataUrl) => { if (native.writeImage) native.writeImage(dataUrl); };
    Bridge.onClipboardChange = (cb) => {
      if (native.onClipboardChange) native.onClipboardChange(() => cb());
      else setInterval(cb, 800);
    };
    Bridge.showWindow = () => { if (native.showWindow) native.showWindow(); };
    Bridge.minimize = () => { if (native.minimize) native.minimize(); };
    Bridge.maximize = () => { if (native.maximize) native.maximize(); };
    Bridge.close = () => { if (native.close) native.close(); };
    Bridge.setStartup = (on) => native.setStartup ? native.setStartup(!!on) : false;
    Bridge.saveFile = (name, content) => native.saveFile ? native.saveFile(name, content) : null;
    Bridge.pickFolder = () => native.pickFolder ? native.pickFolder() : null;
    Bridge.notify = (title, body) => { if (native.notify) native.notify(title, body); };
    Bridge.globalShortcut = (accel, cb) => { if (native.registerShortcut) native.registerShortcut(accel, () => cb()); };
    Bridge.registerShortcutFor = (accel) => { if (native.registerShortcut) native.registerShortcut(accel, () => native.showWindow()); };
    Bridge.setTray = () => { if (native.setTray) native.setTray(); };
    Bridge.setCloseToTray = (v) => { if (native.setCloseToTray) native.setCloseToTray(v); };
  } else if (isAndroid) {
    const cm = window.Capacitor.Plugins.ClipboardManager;
    Bridge.readClipboard = async () => {
      try { const r = await cm.read(); return r && r.value !== undefined ? { text: r.value } : null; } catch (e) { return null; }
    };
    Bridge.writeClipboard = async (text) => { try { await cm.write({ value: text }); } catch (e) {} };
    Bridge.writeImage = () => {};
    Bridge.onClipboardChange = (cb) => { cm.addListener('clipboardChanged', () => cb()); };
    Bridge.startMonitor = () => { try { return cm.start(); } catch (e) { return Promise.resolve(); } };
    Bridge.showWindow = () => {};
    Bridge.minimize = () => {};
    Bridge.maximize = () => {};
    Bridge.close = () => {};
    Bridge.setStartup = () => false;
    Bridge.saveFile = async (name, content) => { try { const r = await cm.saveFile({ name, content }); return r; } catch (e) { return null; } };
    Bridge.pickFolder = () => null;
    Bridge.notify = (title, body) => { try { cm.notify({ title, body }); } catch (e) {} };
    Bridge.globalShortcut = () => {};
    Bridge.registerShortcutFor = () => {};
    Bridge.setTray = () => {};
  } else {
    // Browser fallback (demo/preview)
    Bridge.readClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        return text ? { text } : null;
      } catch (e) { return null; }
    };
    Bridge.writeClipboard = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // fallback for insecure contexts
        try {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          return true;
        } catch (e2) { return false; }
      }
    };
    Bridge.writeImage = () => {};
    Bridge.onClipboardChange = () => {};
    Bridge.showWindow = () => {};
    Bridge.minimize = () => {};
    Bridge.maximize = () => {};
    Bridge.close = () => {};
    Bridge.setStartup = () => false;
    Bridge.saveFile = (name, content) => {
      try {
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
        return true;
      } catch (e) { return null; }
    };
    Bridge.pickFolder = () => null;
    Bridge.notify = (title, body) => {
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
      } catch (e) {}
    };
    Bridge.globalShortcut = () => {};
    Bridge.registerShortcutFor = () => {};
    Bridge.setTray = () => {};
  }

  window.Bridge = Bridge;
  document.documentElement.setAttribute('data-platform', Bridge.platform);

  // Titlebar visibility
  if (isElectron) {
    document.getElementById('titlebar').classList.remove('hidden');
    document.getElementById('tb-min').addEventListener('click', () => Bridge.minimize());
    document.getElementById('tb-max').addEventListener('click', () => Bridge.maximize());
    document.getElementById('tb-close').addEventListener('click', () => Bridge.close());
  }
})();
