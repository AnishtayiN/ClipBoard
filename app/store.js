/* ============================================================
   NovaClip — storage layer
   localStorage backend + optional AES-GCM encryption of clips.
   
   SECURITY FIXES:
   - Proper encryption preservation on update (no plaintext leakage)
   - Storage error handling with callbacks
   - Sensitive content detection for AI features
   ============================================================ */
(function () {
  'use strict';

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

  // Storage error callback for UI feedback
  let onStorageError = null;
  function setStorageErrorHandler(fn) { onStorageError = fn; }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function getRaw(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  
  function setRaw(key, val) {
    try { 
      localStorage.setItem(key, JSON.stringify(val)); 
      return true;
    } catch (e) {
      // Storage quota exceeded or other error
      if (onStorageError) onStorageError(e);
      return false;
    }
  }

  // Check if storage is near quota (warn at 4MB of 5MB)
  function isStorageNearQuota() {
    let bytes = 0;
    try {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) || '';
        bytes += (k.length + v.length) * 2;
      }
    } catch (e) {}
    return bytes > 4 * 1024 * 1024; // Warn at 4MB
  }

  function getStorageError() {
    try {
      // Test if storage is writable
      const testKey = '__novaclip_storage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return null;
    } catch (e) {
      return e.name === 'QuotaExceededError' 
        ? 'STORAGE_FULL' 
        : (e.name || 'STORAGE_ERROR');
    }
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

  /* ---------- sensitive content detection ---------- */
  // Patterns that indicate sensitive data that shouldn't be sent to AI
  const SENSITIVE_PATTERNS = [
    // API keys and tokens
    { pattern: /sk[-_]?[a-zA-Z0-9]{20,}/gi, label: 'API_KEY' },
    { pattern: /api[-_]?key\s*[=:]\s*['"]?[a-zA-Z0-9]{16,}/gi, label: 'API_KEY' },
    { pattern: /bearer\s+[a-zA-Z0-9_\-\.]+/gi, label: 'BEARER_TOKEN' },
    { pattern: /token\s*[=:]\s*['"]?[a-zA-Z0-9_\-\.]{20,}/gi, label: 'TOKEN' },
    // Passwords
    { pattern: /password\s*[=:]\s*['"]?[^\s'"]{4,}/gi, label: 'PASSWORD' },
    { pattern: /passwd\s*[=:]\s*['"]?[^\s'"]{4,}/gi, label: 'PASSWORD' },
    // Private keys
    { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi, label: 'PRIVATE_KEY' },
    // AWS keys
    { pattern: /AKIA[0-9A-Z]{16}/g, label: 'AWS_KEY' },
    // Credit cards (basic pattern)
    { pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, label: 'CREDIT_CARD' },
    // JWT tokens
    { pattern: /eyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g, label: 'JWT' },
    // Cookie headers
    { pattern: /cookie\s*[=:]\s*[^;\s]+/gi, label: 'COOKIE' },
    // Database connection strings
    { pattern: /(mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi, label: 'DB_CONNECTION' },
    // Email addresses (marked as potentially sensitive)
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, label: 'EMAIL' },
  ];

  function detectSensitiveContent(text) {
    if (!text || typeof text !== 'string') return { sensitive: false, types: [] };
    
    const found = [];
    for (const { pattern, label } of SENSITIVE_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        found.push(label);
      }
    }
    
    return {
      sensitive: found.length > 0,
      types: [...new Set(found)] // unique types
    };
  }

  /* ---------- clips ---------- */
  function getClipsRaw() {
    if (!cache.clips) cache.clips = getRaw(KEYS.clips, []);
    if (!Array.isArray(cache.clips)) cache.clips = [];
    return cache.clips;
  }

  function persistClips() { 
    const success = setRaw(KEYS.clips, cache.clips);
    if (!success) {
      // Storage might be full - try to remove oldest non-pinned clips
      pruneOldClips();
    }
    return success;
  }

  // Remove oldest non-pinned clips to free space
  function pruneOldClips() {
    const clips = getClipsRaw();
    const toRemove = clips.filter(c => !c.pinned && !c.fav).slice(0, 20);
    if (toRemove.length > 0) {
      const idsToRemove = new Set(toRemove.map(c => c.id));
      cache.clips = clips.filter(c => !idsToRemove.has(c.id));
      setRaw(KEYS.clips, cache.clips);
    }
  }

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

  // SECURITY FIX: updateClip now preserves encryption state
  // If a clip was encrypted, we MUST re-encrypt when updating text content
  async function updateClip(id, patch, password) {
    const clips = getClipsRaw();
    const i = clips.findIndex(c => c.id === id);
    if (i < 0) return null;
    
    const original = clips[i];
    const wasEncrypted = !!(original.encrypted && typeof original.encrypted === 'object');
    
    // If text content is being updated and clip was/is encrypted, re-encrypt
    if (patch.text !== undefined && (wasEncrypted || isEncrypted())) {
      const pass = password || getSettings().encryptKey;
      if (pass && patch.text !== null && patch.text !== undefined) {
        // Re-encrypt the updated text
        const payload = await encryptText(patch.text, pass);
        patch = Object.assign({}, patch, { encrypted: payload, text: null });
      } else if (wasEncrypted) {
        // Can't update encrypted clip without password - reject
        console.warn('Cannot update encrypted clip without password');
        return null;
      }
    }
    
    clips[i] = Object.assign({}, original, patch);
    persistClips();
    return clips[i];
  }

  // Async version of updateClip that handles encryption properly
  async function updateClipAsync(id, patch, password) {
    return updateClip(id, patch, password);
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
    addClip, addEncryptedClip, updateClip, updateClipAsync, deleteClip, clearClips, replaceAll, clearCache,
    isEncrypted, setPassword, isPasswordValid, encryptText,
    storageBytes, exportAll, importAll,
    detectSensitiveContent, isStorageNearQuota, getStorageError,
    setStorageErrorHandler,
    KEYS,
  };
})();
