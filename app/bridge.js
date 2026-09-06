/* ============================================================
   NovaClip — platform bridge (Electron / Android / browser)
   Detects the runtime and exposes a unified API.

   Two responsibilities that matter for correctness:
     1. Every clipboard read carries a `signature` produced by the *platform*,
        so the renderer never invents its own change-detection key.
     2. `Bridge.storage` abstracts persistence: main-process store on Electron
        (no 5 MB cap, images kept as blobs) and localStorage elsewhere.
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

  /* ---------- shared helpers ---------- */

  async function sha256Hex(str) {
    try {
      const c = window.crypto || window.msCrypto;
      if (c && c.subtle && c.subtle.digest) {
        const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
        return Array.prototype.map.call(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* fall through to FNV-1a */ }
    return 'fnv' + fnv1a(String(str));
  }

  // Non-cryptographic fallback for insecure contexts where SubtleCrypto is
  // unavailable. Only used to detect "did the clipboard change", never for
  // integrity or security decisions.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0') + str.length.toString(16);
  }

  async function sigFor(payload) {
    if (!payload) return 'empty';
    if (payload.text != null && String(payload.text).length) return 't:' + await sha256Hex(payload.text);
    if (payload.image) return 'i:' + await sha256Hex(payload.image);
    return 'empty';
  }

  function lsBytes() {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) || '';
        n += (k.length + v.length) * 2;
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  /* ---------- storage adapters ---------- */

  const BLOB_PREFIX = 'novaclip.blob.';
  const APP_PREFIX = 'novaclip.';

  function localstorageAdapter() {
    return {
      backend: 'localstorage',
      // localStorage is ~5 MB per origin; images live under novaclip.blob.<id>
      // so at least the clips document itself stays small.
      capacityBytes: 5 * 1024 * 1024,
      loadSync() {
        const kv = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf(APP_PREFIX) === 0) kv[k] = localStorage.getItem(k);
          }
        } catch (e) { /* ignore */ }
        return { kv, usage: { kvBytes: lsBytes(), blobBytes: 0, backend: 'localstorage' } };
      },
      async set(key, value) {
        try { localStorage.setItem(key, value); return { ok: true }; }
        catch (e) { return { ok: false, error: e && e.name ? e.name : 'STORAGE_ERROR' }; }
      },
      async del(key) {
        try { localStorage.removeItem(key); return { ok: true }; }
        catch (e) { return { ok: false, error: e && e.name ? e.name : 'STORAGE_ERROR' }; }
      },
      async usage() { return { kvBytes: lsBytes(), blobBytes: 0, backend: 'localstorage' }; },
      async imagePut(id, dataUrl) {
        const r = await this.set(BLOB_PREFIX + id, dataUrl);
        return r.ok ? { ok: true, id } : { ok: false, error: r.error };
      },
      async imageGet(id) {
        try { return localStorage.getItem(BLOB_PREFIX + id); } catch (e) { return null; }
      },
      async imageDel(id) { return this.del(BLOB_PREFIX + id); },
    };
  }

  function nativeAdapter(native) {
    let mirror = null;
    let usageCache = null;

    function hydrate() {
      if (mirror) return mirror;
      let res = null;
      try { res = native.storeLoadSync(); } catch (e) { res = null; }
      mirror = (res && res.ok && res.kv) ? res.kv : {};
      usageCache = (res && res.usage) || null;
      migrateFromLocalStorage();
      return mirror;
    }

    // One-time upgrade path for installs that were running on localStorage.
    function migrateFromLocalStorage() {
      try {
        if (mirror[APP_PREFIX + 'clips']) return;      // native store already has data
        const legacy = localStorage.getItem(APP_PREFIX + 'clips');
        if (!legacy) return;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf(APP_PREFIX) !== 0) continue;
          const v = localStorage.getItem(k);
          if (v == null) continue;
          mirror[k] = v;
          if (native.storeSet) native.storeSet(k, v);
        }
        if (native.storeSet) native.storeSet(APP_PREFIX + 'migratedFromLocalStorage', String(Date.now()));
      } catch (e) { /* migration is best-effort */ }
    }

    return {
      backend: 'native',
      capacityBytes: null, // disk-backed: no fixed cap to show the user
      loadSync() {
        hydrate();
        return { kv: mirror, usage: usageCache };
      },
      async set(key, value) {
        hydrate();
        mirror[key] = value;
        if (!native.storeSet) return { ok: false, error: 'NO_NATIVE_STORE' };
        return await native.storeSet(key, value);
      },
      async del(key) {
        hydrate();
        delete mirror[key];
        if (!native.storeDel) return { ok: false, error: 'NO_NATIVE_STORE' };
        return await native.storeDel(key);
      },
      async usage() {
        if (native.storeUsage) {
          const r = await native.storeUsage();
          if (r && r.ok) usageCache = r.usage;
        }
        return usageCache;
      },
      async imagePut(id, dataUrl) {
        if (!native.imagePut) return { ok: false, error: 'NO_NATIVE_STORE' };
        return await native.imagePut(id, dataUrl);
      },
      async imageGet(id) {
        if (!native.imageGet) return null;
        const r = await native.imageGet(id);
        return (r && r.ok) ? r.dataUrl : null;
      },
      async imageDel(id) {
        if (!native.imageDel) return { ok: false, error: 'NO_NATIVE_STORE' };
        return await native.imageDel(id);
      },
    };
  }

  /* ---------- platform wiring ---------- */

  if (isElectron) {
    // Electron: main/preload exposed via contextBridge as window.NovaNative
    const native = window.NovaNative || {};
    Bridge.native = native;

    Bridge.clipboardSig = () => (native.clipboardSig ? native.clipboardSig() : Promise.resolve(null));
    Bridge.readClipboard = () => (native.readClipboard ? native.readClipboard() : Promise.resolve(null));
    Bridge.writeClipboard = (text) => (native.writeClipboard ? native.writeClipboard(text) : Promise.resolve(null));
    Bridge.writeImage = (dataUrl) => (native.writeImage ? native.writeImage(dataUrl) : Promise.resolve(null));
    Bridge.onClipboardChange = (cb) => {
      if (native.onClipboardChange) native.onClipboardChange(() => cb());
      else setInterval(cb, 800);
    };
    Bridge.onCaptureNow = (cb) => { if (native.onCaptureNow) native.onCaptureNow(() => cb()); };
    Bridge.onShortcutTrigger = (cb) => { if (native.onShortcutTrigger) native.onShortcutTrigger(() => cb()); };
    Bridge.onWindowHidden = (cb) => { if (native.onWindowHidden) native.onWindowHidden(() => cb()); };

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
    Bridge.openExternal = (url) => { if (native.openExternal) native.openExternal(url); };

    Bridge.storage = native.storeLoadSync ? nativeAdapter(native) : localstorageAdapter();
  } else if (isAndroid) {
    const cm = window.Capacitor.Plugins.ClipboardManager;
    Bridge.readClipboard = async () => {
      try {
        const r = await cm.read();
        if (!r || r.value === undefined || r.value === null || r.value === '') return null;
        const payload = { text: r.value };
        payload.signature = await sigFor(payload);
        return payload;
      } catch (e) { return null; }
    };
    Bridge.clipboardSig = async () => {
      const r = await Bridge.readClipboard();
      return r ? r.signature : 'empty';
    };
    Bridge.writeClipboard = async (text) => { try { await cm.write({ value: text }); return await sigFor({ text }); } catch (e) { return null; } };
    Bridge.writeImage = () => Promise.resolve(null);
    Bridge.onClipboardChange = (cb) => { cm.addListener('clipboardChanged', () => cb()); };
    Bridge.onCaptureNow = () => {};
    Bridge.onShortcutTrigger = () => {};
    Bridge.onWindowHidden = (cb) => { document.addEventListener('pause', () => cb()); };
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
    Bridge.openExternal = (url) => {
      try {
        // در WebView اندروید، _system لینک را در مرورگر خارجی باز می‌کند
        window.open(url, '_system', 'noopener');
      } catch (e) {
        try { window.open(url, '_blank', 'noopener'); } catch (e2) {}
      }
    };
    Bridge.storage = localstorageAdapter();
  } else {
    // Browser fallback (demo/preview)
    Bridge.readClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return null;
        const payload = { text };
        payload.signature = await sigFor(payload);
        return payload;
      } catch (e) { return null; }
    };
    Bridge.clipboardSig = async () => {
      const r = await Bridge.readClipboard();
      return r ? r.signature : 'empty';
    };
    Bridge.writeClipboard = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        // fallback for insecure contexts
        try {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch (e2) { return null; }
      }
      return await sigFor({ text });
    };
    Bridge.writeImage = () => Promise.resolve(null);
    Bridge.onClipboardChange = () => {};
    Bridge.onCaptureNow = () => {};
    Bridge.onShortcutTrigger = () => {};
    Bridge.onWindowHidden = (cb) => {
      document.addEventListener('visibilitychange', () => { if (document.hidden) cb(); });
    };
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
    Bridge.openExternal = (url) => {
      try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    };
    Bridge.storage = localstorageAdapter();
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
