/* ============================================================
   NovaClip — storage layer
   localStorage backend + optional AES-GCM encryption of clips.
   ============================================================ */
(function () {
  const KEYS = {
    clips: 'novaclip.clips',
    settings: 'novaclip.settings',
    enc: 'novaclip.encrypted',
    salt: 'novaclip.salt',
  };

  const DEFAULT_SETTINGS = {
    lang: 'fa',
    theme: 'dark',
    accent: 'violet',
    previewWidth: 380,
    maxHistory: 500,
    maxChars: 20000,
    dedup: true,
    captureImages: true,
    startup: false,
    closeToTray: true,
    notify: false,
    shortcut: 'Ctrl+Shift+V',
    encrypt: false,
    ai: { provider: 'openai', base: '', model: '', key: '' },
  };

  let cache = {
    clips: null,
    settings: null,
  };

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function getRaw(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function setRaw(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function defaultSettings() { return deepClone(DEFAULT_SETTINGS); }

  function getSettings() {
    if (!cache.settings) {
      const s = getRaw(KEYS.settings, null) || {};
      cache.settings = Object.assign(defaultSettings(), s);
      cache.settings.ai = Object.assign({}, defaultSettings().ai, s.ai || {});
    }
    return cache.settings;
  }

  function saveSettings(patch) {
    const s = getSettings();
    Object.assign(s, patch || {});
    setRaw(KEYS.settings, s);
    return s;
  }

  /* ---------- encryption ---------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function deriveKey(password, saltB64, importKey = true) {
    let salt;
    if (saltB64) salt = new Uint8Array(b64ToBuf(saltB64));
    else { salt = crypto.getRandomValues(new Uint8Array(16)); }
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return { key, saltB64: bufToB64(salt.buffer) };
  }

  async function encryptText(plain, password, saltB64) {
    const { key, saltB64: salt } = await deriveKey(password, saltB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return { data: bufToB64(enc), iv: bufToB64(iv.buffer), salt };
  }

  async function decryptText(payload, password) {
    const { key } = await deriveKey(password, payload.salt);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(payload.iv)) },
      key, b64ToBuf(payload.data)
    );
    return new TextDecoder().decode(dec);
  }

  async function isPasswordValid(password) {
    try {
      const enc = getRaw(KEYS.enc, null);
      if (!enc) return true;
      if (enc.sample) { await decryptText(enc.sample, password); return true; }
      return false;
    } catch (e) { return false; }
  }

  async function setPassword(password) {
    if (!password) {
      localStorage.removeItem(KEYS.enc);
      localStorage.removeItem(KEYS.salt);
      return;
    }
    const sample = await encryptText('novaclip-sample', password);
    setRaw(KEYS.enc, { sample });
  }

  function isEncrypted() {
    return !!getRaw(KEYS.enc, null);
  }

  /* ---------- clips ---------- */
  function getClipsRaw() {
    if (!cache.clips) cache.clips = getRaw(KEYS.clips, []);
    if (!Array.isArray(cache.clips)) cache.clips = [];
    return cache.clips;
  }

  function persistClips() { setRaw(KEYS.clips, cache.clips); }

  function getClips() {
    const clips = getClipsRaw();
    const s = getSettings();
    const isEnc = isEncrypted() || s.encrypt;
    return clips.map(c => {
      let text = c.text;
      if (c.encrypted && typeof c.encrypted === 'object') text = null; // needs unlock
      return Object.assign({}, c, { text });
    });
  }

  function getClipsDecrypted(password) {
    const clips = getClipsRaw();
    return Promise.all(clips.map(async c => {
      const copy = Object.assign({}, c);
      if (c.encrypted && typeof c.encrypted === 'object') {
        try { copy.text = await decryptText(c.encrypted, password); copy.encrypted = null; }
        catch (e) { copy.text = null; }
      }
      return copy;
    }));
  }

  function addClip(clip) {
    const s = getSettings();
    let clips = getClipsRaw();

    if (s.dedup) {
      const idx = clips.findIndex(c => c.text === clip.text && c.type === clip.type);
      if (idx >= 0) {
        const existing = clips[idx];
        existing.ts = Date.now();
        existing.copies = (existing.copies || 0) + 1;
        clips.splice(idx, 1);
        clips.unshift(existing);
        persistClips();
        return existing;
      }
    }
    clip.ts = Date.now();
    clip.copies = clip.copies || 0;
    clips.unshift(clip);
    if (clips.length > s.maxHistory) clips.length = s.maxHistory;
    persistClips();
    return clip;
  }

  async function addEncryptedClip(clip, password) {
    const payload = await encryptText(clip.text, password);
    const c = Object.assign({}, clip, { encrypted: payload, text: null });
    let clips = getClipsRaw();
    clips.unshift(c);
    const s = getSettings();
    if (clips.length > s.maxHistory) clips.length = s.maxHistory;
    persistClips();
    return c;
  }

  function updateClip(id, patch) {
    const clips = getClipsRaw();
    const i = clips.findIndex(c => c.id === id);
    if (i < 0) return null;
    clips[i] = Object.assign({}, clips[i], patch);
    persistClips();
    return clips[i];
  }

  function deleteClip(id) {
    cache.clips = getClipsRaw().filter(c => c.id !== id);
    persistClips();
  }

  function clearClips() {
    cache.clips = [];
    persistClips();
  }

  function replaceAll(clips) {
    cache.clips = clips.slice();
    persistClips();
  }

  function clearCache() { cache.clips = null; cache.settings = null; }

  function storageBytes() {
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      n += (k.length + v.length) * 2;
    }
    return n;
  }

  async function exportAll() {
    const isEnc = isEncrypted();
    const clips = getClipsRaw();
    return JSON.stringify({ app: 'novaclip', version: 1, exportedAt: Date.now(), encrypted: isEnc, clips }, null, 2);
  }

  function importAll(json, password) {
    return new Promise(async (resolve, reject) => {
      try {
        const obj = JSON.parse(json);
        if (!obj || !Array.isArray(obj.clips)) throw new Error('bad format');
        let incoming = obj.clips;
        if (obj.encrypted) {
          if (!password) return reject(new Error('password'));
          incoming = await Promise.all(incoming.map(async c => {
            const copy = Object.assign({}, c);
            if (c.encrypted) { copy.text = await decryptText(c.encrypted, password); copy.encrypted = null; }
            return copy;
          }));
        }
        cache.clips = incoming;
        persistClips();
        resolve(incoming.length);
      } catch (e) { reject(e); }
    });
  }

  window.Store = {
    getSettings, saveSettings, getClips, getClipsDecrypted,
    addClip, addEncryptedClip, updateClip, deleteClip, clearClips, replaceAll, clearCache,
    isEncrypted, setPassword, isPasswordValid, encryptText,
    storageBytes, exportAll, importAll,
    KEYS,
  };
})();
