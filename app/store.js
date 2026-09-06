/* ============================================================
   NovaClip — storage layer

   BACKEND
   -------
   Persistence goes through `Bridge.storage`:
     • Electron  -> main-process store (SQLite when available, otherwise an
                    atomically written JSON file in userData). No 5 MB cap.
     • Android/web -> localStorage, with images kept under separate keys.
   Images are stored as blobs referenced by `imageId`; only a small thumbnail
   is kept inline so the clips document stays small.

   ENCRYPTION
   ----------
   AES-GCM 256 over PBKDF2-SHA256. All clips of one password share a single
   salt (stored in KEYS.salt) so unlocking N clips costs ONE key derivation
   instead of N, and the derived CryptoKey is cached for the session.
   Every clip gets its own random 12-byte IV.

   `enableEncryption()` / `disableEncryption()` migrate the *whole* history
   (text AND images), verify every single round-trip before committing, and
   roll back if anything fails — enabling encryption can never leave plaintext
   behind or destroy data.
   ============================================================ */
(function () {
  'use strict';

  const KEYS = {
    clips: 'novaclip.clips',
    settings: 'novaclip.settings',
    enc: 'novaclip.encrypted',
    salt: 'novaclip.salt',
    meta: 'novaclip.meta',
  };

  const VERIFIER_PLAINTEXT = 'novaclip-sample';
  const MAX_PRUNE_ATTEMPTS = 8;
  const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024;

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
    autoLock: true,
    shortcut: 'Ctrl+Shift+V',
    encrypt: false,
    ai: { provider: 'openai', base: '', model: '', key: '' },
  };

  let cache = { clips: null, settings: null };
  let mirror = null;              // key -> JSON string (authoritative read source)
  let imageCache = new Map();     // imageId -> full data URL (lazily filled)
  let thumbCache = new Map();     // thumbId -> thumbnail data URL
  let lastUsage = null;           // { kvBytes, blobBytes, backend }
  let onStorageError = null;

  function setStorageErrorHandler(fn) { onStorageError = typeof fn === 'function' ? fn : null; }
  function reportStorageError(err) { if (onStorageError) { try { onStorageError(err); } catch (e) { /* ignore */ } } }

  function adapter() { return window.Bridge.storage; }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function uid(prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ============================================================
     Low-level key/value access (synchronous reads, async writes)
     ============================================================ */

  function ensureMirror() {
    if (mirror) return mirror;
    mirror = {};
    try {
      const loaded = adapter().loadSync();
      if (loaded && loaded.kv) mirror = loaded.kv;
      if (loaded && loaded.usage) lastUsage = loaded.usage;
    } catch (e) { reportStorageError(e); }
    return mirror;
  }

  function getRaw(key, def) {
    const m = ensureMirror();
    const v = Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    if (v === null || v === undefined) return def;
    try { return JSON.parse(v); } catch (e) { return def; }
  }

  // Writes update the mirror synchronously (so the very next read is correct)
  // and are flushed to the backend asynchronously. Errors are reported through
  // the storage error handler; `commit()` is what reports write *failures* for
  // the clips document, because that is the one that can run out of space.
  function setRaw(key, val) {
    const m = ensureMirror();
    let json;
    try { json = JSON.stringify(val); }
    catch (e) { reportStorageError(e); return false; }
    m[key] = json;
    try {
      const p = adapter().set(key, json);
      if (p && typeof p.then === 'function') {
        p.then((r) => { if (r && !r.ok) reportStorageError({ name: r.error || 'STORAGE_ERROR' }); })
         .catch((e) => reportStorageError(e));
      }
    } catch (e) { reportStorageError(e); return false; }
    return true;
  }

  function delRaw(key) {
    const m = ensureMirror();
    delete m[key];
    try {
      const p = adapter().del(key);
      if (p && typeof p.then === 'function') p.catch((e) => reportStorageError(e));
    } catch (e) { reportStorageError(e); }
  }

  function storageBytes() {
    const m = ensureMirror();
    let n = 0;
    for (const k of Object.keys(m)) n += (k.length + (m[k] || '').length) * 2;
    if (lastUsage && lastUsage.blobBytes) n += lastUsage.blobBytes;
    return n;
  }

  function storageInfo() {
    const a = adapter();
    return {
      bytes: storageBytes(),
      capacity: (a && a.capacityBytes) || null,
      backend: (a && a.backend) || 'unknown',
      kvBytes: lastUsage ? lastUsage.kvBytes : null,
      blobBytes: lastUsage ? lastUsage.blobBytes : null,
    };
  }

  async function refreshUsage() {
    try {
      const u = await adapter().usage();
      if (u) lastUsage = u;
    } catch (e) { /* ignore */ }
    return lastUsage;
  }

  function isStorageNearQuota() {
    const info = storageInfo();
    if (!info.capacity) return false;                 // disk-backed: no fixed cap
    return info.bytes > info.capacity * 0.8;
  }

  function getStorageError() {
    try {
      const probe = adapter().loadSync();
      return probe ? null : 'STORAGE_ERROR';
    } catch (e) {
      return e && e.name === 'QuotaExceededError' ? 'STORAGE_FULL' : ((e && e.name) || 'STORAGE_ERROR');
    }
  }

  /* ============================================================
     Settings
     ============================================================ */
  function defaultSettings() { return deepClone(DEFAULT_SETTINGS); }

  function getSettings() {
    if (!cache.settings) {
      const s = getRaw(KEYS.settings, null) || {};
      const base = defaultSettings();
      cache.settings = Object.assign(base, s);
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

  /* ============================================================
     Crypto
     ============================================================ */
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

  // Session cache for derived keys. Keyed by salt + SHA-256(password) so the
  // password itself is never used as an object key.
  const keyCache = new Map();

  function cacheKeyFor(password, saltB64) {
    let h = 0x811c9dc5;
    const s = String(password);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return saltB64 + '|' + h.toString(16) + '|' + s.length;
  }

  function ensureSalt() {
    let salt = getRaw(KEYS.salt, null);
    if (!salt || typeof salt !== 'string') {
      salt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
      setRaw(KEYS.salt, salt);
    }
    return salt;
  }

  async function deriveKey(password, saltB64) {
    const saltBytes = saltB64 ? new Uint8Array(b64ToBuf(saltB64)) : crypto.getRandomValues(new Uint8Array(16));
    const salt = bufToB64(saltBytes.buffer);
    const ck = cacheKeyFor(password, salt);
    if (keyCache.has(ck)) return { key: keyCache.get(ck), saltB64: salt };

    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 150000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    keyCache.set(ck, key);
    return { key, saltB64: salt };
  }

  // Drops every cached key — called on lock so key material does not outlive
  // the unlocked session any longer than it has to.
  function clearKeyCache() { keyCache.clear(); }

  async function encryptText(plain, password, saltB64) {
    const { key, saltB64: salt } = await deriveKey(password, saltB64 || ensureSalt());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plain)));
    return { data: bufToB64(enc), iv: bufToB64(iv.buffer), salt };
  }

  async function decryptText(payload, password) {
    if (!payload || !payload.data || !payload.iv) throw new Error('bad payload');
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
      if (!enc) return true;                                  // nothing to check yet
      if (enc.sample) { return (await decryptText(enc.sample, password)) === VERIFIER_PLAINTEXT; }
      return false;
    } catch (e) { return false; }
  }

  // Writes ONLY the verifier. Real migration lives in enableEncryption();
  // calling this on its own would enable the lock without protecting anything.
  async function setPassword(password) {
    if (!password) {
      delRaw(KEYS.enc);
      return { ok: true };
    }
    const salt = ensureSalt();
    const sample = await encryptText(VERIFIER_PLAINTEXT, password, salt);
    if ((await decryptText(sample, password)) !== VERIFIER_PLAINTEXT) {
      return { ok: false, error: 'VERIFIER_FAILED' };
    }
    setRaw(KEYS.enc, { sample, salt, v: 2 });
    return { ok: true };
  }

  function isEncrypted() { return !!getRaw(KEYS.enc, null); }

  /* ============================================================
     Sensitive content detection

     Heuristic by design: this WARNS, it cannot guarantee that every secret is
     found. The UI is worded accordingly ("may contain sensitive data").
     ============================================================ */
  const SENSITIVE_PATTERNS = [
    // --- OpenAI / Anthropic / Google / generic API keys ---
    { pattern: /\bsk-[A-Za-z0-9_\-]{16,}\b/g, label: 'API_KEY' },
    { pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_\-]{16,}\b/g, label: 'API_KEY' },
    { pattern: /\bAIza[0-9A-Za-z_\-]{30,}\b/g, label: 'API_KEY' },
    { pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'API_KEY' },
    { pattern: /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g, label: 'API_KEY' },
    { pattern: /\bkey-[0-9a-f]{32}\b/gi, label: 'API_KEY' },
    { pattern: /api[-_]?key\s*[=:]\s*['"]?[A-Za-z0-9_\-]{12,}/gi, label: 'API_KEY' },
    { pattern: /(?:secret|access)[-_]?key\s*[=:]\s*['"]?[A-Za-z0-9/+=_\-]{12,}/gi, label: 'SECRET_KEY' },

    // --- GitHub ---
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'GITHUB_TOKEN' },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'GITHUB_TOKEN' },

    // --- Slack ---
    { pattern: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, label: 'SLACK_TOKEN' },
    { pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, label: 'SLACK_WEBHOOK' },

    // --- Telegram / Twilio / npm / Heroku / Azure / Mailgun ---
    { pattern: /\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b/g, label: 'TELEGRAM_BOT_TOKEN' },
    { pattern: /\bSK[0-9a-fA-F]{32}\b/g, label: 'TWILIO_KEY' },
    { pattern: /_authToken\s*[=:]\s*['"]?[A-Za-z0-9_\-=/+]{20,}/gi, label: 'NPM_TOKEN' },
    { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=.*heroku)/gi, label: 'HEROKU_KEY' },
    { pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/gi, label: 'AZURE_CONNECTION' },

    // --- OAuth / bearer / generic tokens ---
    { pattern: /\bbearer\s+[A-Za-z0-9_\-.]{10,}/gi, label: 'BEARER_TOKEN' },
    { pattern: /\btoken\s*[=:]\s*['"]?[A-Za-z0-9_\-.]{16,}/gi, label: 'TOKEN' },
    { pattern: /\beyJ[A-Za-z0-9_\-]{5,}\.eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\b/g, label: 'JWT' },
    { pattern: /\bya29\.[A-Za-z0-9_\-]{10,}\b/g, label: 'GOOGLE_OAUTH' },

    // --- Passwords ---
    { pattern: /(?:password|passwd|pwd|passphrase)\s*[=:]\s*['"]?[^\s'"]{4,}/gi, label: 'PASSWORD' },

    // --- Private keys ---
    { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/gi, label: 'PRIVATE_KEY' },

    // --- Cloud / infra ---
    { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'AWS_ACCESS_KEY' },
    { pattern: /\baws(.{0,20})?(secret|sk)\b.{0,5}[=:]\s*['"]?[A-Za-z0-9/+=]{30,}/gi, label: 'AWS_SECRET' },

    // --- Payment ---
    { pattern: /\b(?:\d[ \-]?){13,19}\b/g, label: 'CREDIT_CARD', validate: luhn },

    // --- Cookies / auth headers / URLs with credentials ---
    { pattern: /\bcookie\s*[=:]\s*['"]?[^\s;]{4,}/gi, label: 'COOKIE' },
    { pattern: /\bset-cookie\s*:/gi, label: 'COOKIE' },
    { pattern: /\bauthorization\s*[=:]\s*['"]?(?:basic|bearer)\s+[A-Za-z0-9_\-.=+\/]{8,}/gi, label: 'AUTH_HEADER' },
    { pattern: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s/:@]+:[^\s@]+@[^\s/]+/gi, label: 'URL_CREDENTIALS' },

    // --- Connection strings ---
    { pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqp|sqlserver):\/\/[^\s'"]+/gi, label: 'DB_CONNECTION' },

    // --- PII ---
    { pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, label: 'EMAIL' },
    { pattern: /\b(?:\+?\d{1,3}[\s\-]?)?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}\b/g, label: 'PHONE' },
    { pattern: /\b\d{10}\b(?=.*(?:national|meli|ssn|social))/gi, label: 'NATIONAL_ID' },

    // --- Crypto material ---
    { pattern: /\b(?:bc)?[xy]\b.{0,3}[=:]\s*['"]?\$2[aby]\$\d{2}\$[./A-Za-z0-9]{40,}/gi, label: 'PASSWORD_HASH' },
  ];

  function luhn(digits) {
    const s = String(digits).replace(/\D/g, '');
    if (s.length < 13 || s.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = parseInt(s[i], 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // Long, high-entropy blobs are usually keys/tokens even when no prefix matches.
  const ENTROPY_TOKEN_RE = /[A-Za-z0-9+\/=_\-]{32,}/g;
  function shannonEntropy(s) {
    const freq = Object.create(null);
    for (let i = 0; i < s.length; i++) freq[s[i]] = (freq[s[i]] || 0) + 1;
    let h = 0;
    for (const k in freq) {
      const p = freq[k] / s.length;
      h -= p * Math.log2(p);
    }
    return h;
  }

  function detectSensitiveContent(text) {
    if (!text || typeof text !== 'string') return { sensitive: false, types: [], heuristic: true };

    const found = [];
    for (const rule of SENSITIVE_PATTERNS) {
      rule.pattern.lastIndex = 0;
      let m;
      let hit = false;
      while ((m = rule.pattern.exec(text)) !== null) {
        if (m[0] === '') { rule.pattern.lastIndex++; continue; }
        if (rule.validate && !rule.validate(m[0])) continue;
        hit = true;
        break;
      }
      if (hit) found.push(rule.label);
    }

    // Entropy pass (skipped for prose-heavy text to limit false positives).
    if (text.length <= 20000) {
      ENTROPY_TOKEN_RE.lastIndex = 0;
      let m;
      while ((m = ENTROPY_TOKEN_RE.exec(text)) !== null) {
        const tok = m[0];
        if (/[A-Za-z]/.test(tok) && /\d/.test(tok) && shannonEntropy(tok) >= 4.2) {
          found.push('HIGH_ENTROPY');
          break;
        }
      }
    }

    const types = Array.from(new Set(found));
    return { sensitive: types.length > 0, types, heuristic: true };
  }

  /* ============================================================
     Clips
     ============================================================ */
  function getClipsRaw() {
    if (!cache.clips) {
      const raw = getRaw(KEYS.clips, []);
      cache.clips = Array.isArray(raw) ? raw : [];
    }
    if (!Array.isArray(cache.clips)) cache.clips = [];
    return cache.clips;
  }

  function isEncryptedRow(row) {
    return !!(row && ((row.encrypted && typeof row.encrypted === 'object') || (row.encImage && typeof row.encImage === 'object')));
  }

  // Attach whatever image bytes we already have in memory (thumbnail always,
  // full data only once hydrated).
  function decorate(row) {
    const copy = Object.assign({}, row);
    if (copy.imageId && !copy.data && imageCache.has(copy.imageId)) copy.data = imageCache.get(copy.imageId);
    if (copy.thumbId && !copy.thumb && thumbCache.has(copy.thumbId)) copy.thumb = thumbCache.get(copy.thumbId);
    return copy;
  }

  async function serializeRows() {
    const rows = [];
    for (const c of getClipsRaw()) {
      const row = Object.assign({}, c);
      // Push image bytes out of the document into the blob store: both the
      // full image and its thumbnail. Nothing base64 stays in the JSON.
      if (row.type === 'image' && !row.encImage) {
        if (row.data && !row.imageId) {
          const id = uid('img');
          try {
            const r = await adapter().imagePut(id, row.data);
            if (r && r.ok) { row.imageId = r.id; c.imageId = r.id; imageCache.set(r.id, row.data); }
            else reportStorageError({ name: (r && r.error) || 'STORAGE_ERROR' });
          } catch (e) { reportStorageError(e); }
        }
        if (row.thumb && !row.thumbId) {
          const id = uid('thm');
          try {
            const r = await adapter().imagePut(id, row.thumb);
            if (r && r.ok) { row.thumbId = r.id; c.thumbId = r.id; thumbCache.set(r.id, row.thumb); }
            else reportStorageError({ name: (r && r.error) || 'STORAGE_ERROR' });
          } catch (e) { reportStorageError(e); }
        }
      }
      if (row.imageId || row.encImage) delete row.data;
      if (row.thumbId || row.encImage) delete row.thumb;
      rows.push(row);
    }
    return rows;
  }

  async function dropBlobs(clip) {
    if (!clip) return;
    for (const id of [clip.imageId, clip.thumbId]) {
      if (!id) continue;
      try { await adapter().imageDel(id); } catch (e) { /* ignore */ }
    }
    if (clip.imageId) imageCache.delete(clip.imageId);
    if (clip.thumbId) thumbCache.delete(clip.thumbId);
  }

  // Frees space by dropping the OLDEST unpinned/unfavourited clips.
  // Returns true when something was actually removed.
  function pruneOldClips() {
    const clips = getClipsRaw();
    const removable = [];
    for (let i = 0; i < clips.length; i++) {
      if (!clips[i].pinned && !clips[i].fav) removable.push(i);
    }
    if (!removable.length) return false;
    const take = Math.min(removable.length, Math.max(1, Math.ceil(clips.length * 0.1)));
    // `clips` is newest-first, so the tail of `removable` holds the oldest.
    const drop = new Set(removable.slice(-take));
    const removed = [];
    cache.clips = clips.filter((c, i) => { if (drop.has(i)) { removed.push(c); return false; } return true; });
    for (const c of removed) dropBlobs(c);
    return removed.length > 0;
  }

  // Writes the clips document to the backend AND to the synchronous mirror, so
  // a read immediately after a write (or after clearCache()) sees the new data.
  async function writeClipsDoc(rows) {
    const json = JSON.stringify(rows);
    const m = ensureMirror();
    m[KEYS.clips] = json;
    try { return await adapter().set(KEYS.clips, json); }
    catch (e) { reportStorageError(e); return { ok: false, error: (e && e.name) || 'STORAGE_ERROR' }; }
  }

  /**
   * Persist the clips document.
   * If the write fails (quota / disk error) we prune and retry, and return the
   * result of the *retry* — not of the first attempt.
   */
  async function commit() {
    let rows;
    try { rows = await serializeRows(); }
    catch (e) { reportStorageError(e); return false; }

    let res = await writeClipsDoc(rows);
    let attempts = 0;
    while ((!res || !res.ok) && attempts < MAX_PRUNE_ATTEMPTS) {
      reportStorageError({ name: (res && res.error) || 'STORAGE_FULL' });
      if (!pruneOldClips()) break;                       // nothing left to free
      try { rows = await serializeRows(); }
      catch (e) { reportStorageError(e); return false; }
      res = await writeClipsDoc(rows);
      attempts++;
    }
    refreshUsage();
    return !!(res && res.ok);
  }

  // Sync-friendly alias kept for readability at call sites.
  function persistClips() { return commit(); }

  function getClips() {
    return getClipsRaw().map((c) => {
      const copy = decorate(c);
      if (c.encrypted && typeof c.encrypted === 'object') copy.text = null;   // needs unlock
      if (c.encImage && typeof c.encImage === 'object') copy.data = null;
      return copy;
    });
  }

  // Full plaintext view. Requires the password; used while unlocked.
  async function getClipsDecrypted(password) {
    const clips = getClipsRaw();
    return Promise.all(clips.map(async (c) => {
      const copy = decorate(c);
      if (c.encrypted && typeof c.encrypted === 'object') {
        try { copy.text = await decryptText(c.encrypted, password); copy.encrypted = null; }
        catch (e) { copy.text = null; }
      }
      if (c.encImage && typeof c.encImage === 'object') {
        try {
          const dataUrl = await decryptText(c.encImage, password);
          copy.data = dataUrl;
          copy.thumb = copy.thumb || null;
          copy.encImage = null;
        } catch (e) { copy.data = null; }
      }
      return copy;
    }));
  }

  async function getImageData(clip) {
    if (!clip) return null;
    if (clip.data) return clip.data;
    if (clip.imageId) {
      if (imageCache.has(clip.imageId)) return imageCache.get(clip.imageId);
      const url = await adapter().imageGet(clip.imageId);
      if (url) imageCache.set(clip.imageId, url);
      return url;
    }
    return null;
  }

  // Thumbnail for the list view. Never blocks on the full image: the thumb is
  // its own blob, fetched (or generated once for legacy rows) on demand.
  async function getImageThumb(clip) {
    if (!clip) return null;
    if (clip.thumb) return clip.thumb;
    if (clip.thumbId) {
      if (thumbCache.has(clip.thumbId)) { clip.thumb = thumbCache.get(clip.thumbId); return clip.thumb; }
      const url = await adapter().imageGet(clip.thumbId);
      if (url) { thumbCache.set(clip.thumbId, url); clip.thumb = url; }
      return url;
    }
    if (clip.data) {
      const made = await makeThumb(clip.data);
      if (made) { clip.thumb = made; thumbCache.set(clip.thumbId || ('mem:' + clip.id), made); }
      return made;
    }
    return null;
  }

  // Generate a small thumbnail so the list never needs the full image bytes.
  // Returns null when the platform cannot rasterise (headless test envs);
  // callers fall back to the full data URL or an icon.
  async function makeThumb(dataUrl, max) {
    const size = max || 220;
    try {
      const cv = document.createElement('canvas');
      const ctx = (cv && cv.getContext) ? cv.getContext('2d') : null;
      if (!ctx) return null;                       // no canvas support here
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      const w = img.naturalWidth || img.width || size;
      const h = img.naturalHeight || img.height || size;
      const scale = Math.min(1, size / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      cv.width = cw; cv.height = ch;
      ctx.drawImage(img, 0, 0, cw, ch);
      return cv.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function findDuplicateIndex(clip) {
    const s = getSettings();
    if (!s.dedup) return -1;
    const clips = getClipsRaw();
    if (clip.type === 'image') {
      if (!clip.data) return -1;
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        if (c.type !== 'image' || c.encImage) continue;
        const data = c.data || (c.imageId ? imageCache.get(c.imageId) : null);
        if (data && data === clip.data) return i;
      }
      return -1;
    }
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (c.type === clip.type && typeof c.text === 'string' && c.text === clip.text) return i;
    }
    return -1;
  }

  function trimHistory() {
    const s = getSettings();
    const clips = getClipsRaw();
    if (clips.length > s.maxHistory) {
      const dropped = clips.splice(s.maxHistory);
      for (const c of dropped) dropBlobs(c);
    }
  }

  async function addClip(clip) {
    const clips = getClipsRaw();
    const idx = findDuplicateIndex(clip);
    if (idx >= 0) {
      const existing = clips[idx];
      existing.ts = Date.now();
      existing.copies = (existing.copies || 0) + 1;
      clips.splice(idx, 1);
      clips.unshift(existing);
      await commit();
      return decorate(existing);
    }
    clip.ts = clip.ts || Date.now();
    clip.copies = clip.copies || 0;
    clips.unshift(clip);
    trimHistory();
    await commit();
    return decorate(clip);
  }

  async function addEncryptedClip(clip, password) {
    if (!password) throw new Error('password required');
    const salt = ensureSalt();
    const row = Object.assign({}, clip, { ts: clip.ts || Date.now(), copies: clip.copies || 0 });

    if (row.text != null) {
      row.encrypted = await encryptText(String(row.text), password, salt);
      row.text = null;
    }
    if (row.type === 'image' && row.data) {
      row.encImage = await encryptText(row.data, password, salt);
      row.data = null;
      row.imageId = null;
      row.thumb = null;                    // thumbnail is derived from plaintext
      row.thumbId = null;                  // …and must never be persisted
    }

    const clips = getClipsRaw();
    clips.unshift(row);
    trimHistory();
    await commit();
    return Object.assign({}, row);
  }

  /**
   * Update a clip while preserving its encryption state.
   * Text changes on an encrypted (or encryption-enabled) history are
   * re-encrypted before anything touches storage — plaintext is never written.
   */
  async function updateClip(id, patch, password) {
    const clips = getClipsRaw();
    const i = clips.findIndex(c => c.id === id);
    if (i < 0) return null;

    const original = clips[i];
    const wasEncrypted = isEncryptedRow(original);
    const touchesText = patch && Object.prototype.hasOwnProperty.call(patch, 'text');
    let next = Object.assign({}, patch || {});

    if (touchesText && (wasEncrypted || isEncrypted())) {
      if (next.text === null || next.text === undefined) {
        if (wasEncrypted) return null;                 // refuse to blank ciphertext
      } else if (password) {
        next.encrypted = await encryptText(String(next.text), password, ensureSalt());
        next.text = null;
      } else if (wasEncrypted) {
        return null;                                   // cannot rewrite without the password
      }
    }

    // A new full image on an encrypted history must be encrypted too.
    if (next.data && (wasEncrypted || isEncrypted())) {
      if (password) {
        next.encImage = await encryptText(String(next.data), password, ensureSalt());
        next.data = null;
        next.imageId = null;
        next.thumb = null;
        next.thumbId = null;
      } else if (wasEncrypted) {
        return null;
      }
    }

    clips[i] = Object.assign({}, original, next);
    await commit();
    return decorate(clips[i]);
  }

  async function updateClipAsync(id, patch, password) { return updateClip(id, patch, password); }

  async function deleteClip(id) {
    const clips = getClipsRaw();
    const victim = clips.find(c => c.id === id);
    cache.clips = clips.filter(c => c.id !== id);
    if (victim) await dropBlobs(victim);
    return commit();
  }

  async function clearClips() {
    const clips = getClipsRaw();
    for (const c of clips) dropBlobs(c);
    imageCache.clear();
    thumbCache.clear();
    cache.clips = [];
    return commit();
  }

  async function replaceAll(clips) {
    cache.clips = (clips || []).slice();
    return commit();
  }

  function clearCache() { cache.clips = null; cache.settings = null; imageCache.clear(); thumbCache.clear(); }

  /* ============================================================
     Encryption migration (the important part)
     ============================================================ */

  /**
   * Encrypt the ENTIRE existing history, verify every round-trip, and only
   * then flip the switch. On any failure the previous state is restored.
   *
   * @returns {Promise<{ok:boolean, migrated?:number, total?:number, already?:boolean, error?:string, failed?:Array}>}
   */
  async function enableEncryption(password, opts) {
    const onProgress = (opts && opts.onProgress) || null;
    if (!password) return { ok: false, error: 'NO_PASSWORD' };
    if (isEncrypted()) return { ok: true, already: true, migrated: 0, total: 0 };

    const rows = getClipsRaw();
    const total = rows.length;
    const backup = deepClone(rows);
    const salt = ensureSalt();

    const out = [];
    const blobsToDelete = [];
    let migrated = 0;

    const abort = async (error, failed) => {
      cache.clips = backup;
      await commit();
      return { ok: false, error, failed: failed || [], migrated, total };
    };

    for (let i = 0; i < rows.length; i++) {
      const src = rows[i];
      const row = Object.assign({}, src);

      if (row.text != null && row.text !== '') {
        const plain = String(row.text);
        let payload;
        try { payload = await encryptText(plain, password, salt); }
        catch (e) { return await abort('ENCRYPT_FAILED', [row.id]); }
        let check;
        try { check = await decryptText(payload, password); }
        catch (e) { return await abort('VERIFY_FAILED', [row.id]); }
        if (check !== plain) return await abort('VERIFY_FAILED', [row.id]);
        row.encrypted = payload;
        row.text = null;
      }

      if (row.type === 'image' && !row.encImage) {
        let dataUrl = row.data || (row.imageId ? imageCache.get(row.imageId) : null);
        if (!dataUrl && row.imageId) {
          try { dataUrl = await adapter().imageGet(row.imageId); } catch (e) { dataUrl = null; }
        }
        if (dataUrl) {
          let payload;
          try { payload = await encryptText(dataUrl, password, salt); }
          catch (e) { return await abort('ENCRYPT_FAILED', [row.id]); }
          let check;
          try { check = await decryptText(payload, password); }
          catch (e) { return await abort('VERIFY_FAILED', [row.id]); }
          if (check !== dataUrl) return await abort('VERIFY_FAILED', [row.id]);
          row.encImage = payload;
          // Both blobs hold plaintext pixels — queue them for deletion once
          // the ciphertext is safely on disk.
          if (row.imageId) { blobsToDelete.push(row.imageId); row.imageId = null; }
          if (row.thumbId) { blobsToDelete.push(row.thumbId); row.thumbId = null; }
          row.data = null;
          row.thumb = null;
        }
      }

      out.push(row);
      migrated++;
      if (onProgress) { try { onProgress(migrated, total); } catch (e) { /* ignore */ } }
    }

    // Write the encrypted history FIRST. If that fails, encryption stays off
    // and the plaintext history is untouched.
    cache.clips = out;
    const persisted = await commit();
    if (!persisted) {
      cache.clips = backup;
      await commit();
      return { ok: false, error: 'PERSIST_FAILED', migrated, total };
    }

    const verifier = await setPassword(password);
    if (!verifier.ok) {
      cache.clips = backup;
      await commit();
      return { ok: false, error: verifier.error || 'VERIFIER_FAILED', migrated, total };
    }

    // Only now is it safe to drop the plaintext image blobs.
    for (const id of blobsToDelete) {
      try { await adapter().imageDel(id); } catch (e) { /* ignore */ }
      imageCache.delete(id);
    }

    saveSettings({ encrypt: true });
    return { ok: true, migrated, total };
  }

  /**
   * Decrypt the whole history back to plaintext. Aborts (leaving encryption
   * enabled) if any clip fails to decrypt — i.e. on a wrong password.
   */
  async function disableEncryption(password, opts) {
    const onProgress = (opts && opts.onProgress) || null;
    if (!isEncrypted()) return { ok: true, already: true, migrated: 0 };
    if (!password) return { ok: false, error: 'NO_PASSWORD' };
    if (!(await isPasswordValid(password))) return { ok: false, error: 'BAD_PASSWORD' };

    const rows = getClipsRaw();
    const total = rows.length;
    const backup = deepClone(rows);
    const out = [];
    const orphanBlobs = [];
    const failed = [];
    let migrated = 0;

    for (let i = 0; i < rows.length; i++) {
      const src = rows[i];
      const row = Object.assign({}, src);

      if (row.encrypted && typeof row.encrypted === 'object') {
        try {
          row.text = await decryptText(row.encrypted, password);
          row.encrypted = null;
        } catch (e) { failed.push(row.id); continue; }
      }

      if (row.encImage && typeof row.encImage === 'object') {
        try {
          const dataUrl = await decryptText(row.encImage, password);
          const id = uid('img');
          const put = await adapter().imagePut(id, dataUrl);
          if (!put || !put.ok) { failed.push(row.id); continue; }
          row.imageId = put.id;
          row.data = dataUrl;
          imageCache.set(put.id, dataUrl);
          orphanBlobs.push(put.id);
          row.encImage = null;
          if (!row.thumb) row.thumb = await makeThumb(dataUrl);
        } catch (e) { failed.push(row.id); continue; }
      }

      out.push(row);
      migrated++;
      if (onProgress) { try { onProgress(migrated, total); } catch (e) { /* ignore */ } }
    }

    if (failed.length) {
      for (const id of orphanBlobs) { try { await adapter().imageDel(id); } catch (e) { /* ignore */ } imageCache.delete(id); }
      return { ok: false, error: 'DECRYPT_FAILED', failed, migrated, total };
    }

    cache.clips = out;
    const persisted = await commit();
    if (!persisted) {
      cache.clips = backup;
      await commit();
      return { ok: false, error: 'PERSIST_FAILED', migrated, total };
    }

    await setPassword(null);
    saveSettings({ encrypt: false });
    clearKeyCache();
    return { ok: true, migrated, total };
  }

  /* ============================================================
     Import / export
     ============================================================ */
  async function exportAll() {
    const clips = [];
    for (const c of getClipsRaw()) {
      const row = Object.assign({}, c);
      if (row.imageId && !row.data) {
        try { row.data = await adapter().imageGet(row.imageId); } catch (e) { row.data = null; }
      }
      delete row.thumbId;                 // thumbnails are rebuilt on import
      delete row.thumb;
      clips.push(row);
    }
    return JSON.stringify({
      app: 'novaclip',
      version: 2,
      exportedAt: Date.now(),
      encrypted: isEncrypted(),
      clips,
    }, null, 2);
  }

  async function importAll(json, password) {
    const obj = JSON.parse(json);
    if (!obj || !Array.isArray(obj.clips)) throw new Error('bad format');

    let incoming = obj.clips.slice();

    // An encrypted export has to be unlocked before it can be merged.
    if (obj.encrypted) {
      if (!password) { const e = new Error('password'); e.code = 'password'; throw e; }
      incoming = await Promise.all(incoming.map(async (c) => {
        const copy = Object.assign({}, c);
        if (copy.encrypted) { copy.text = await decryptText(copy.encrypted, password); copy.encrypted = null; }
        if (copy.encImage) { copy.data = await decryptText(copy.encImage, password); copy.encImage = null; }
        return copy;
      }));
    }

    // If this device encrypts at rest, imported clips must be re-encrypted —
    // importing must never become a plaintext back door.
    if (isEncrypted() && password) {
      const salt = ensureSalt();
      incoming = await Promise.all(incoming.map(async (c) => {
        const copy = Object.assign({}, c);
        if (copy.text != null) { copy.encrypted = await encryptText(String(copy.text), password, salt); copy.text = null; }
        if (copy.type === 'image' && copy.data) {
          copy.encImage = await encryptText(String(copy.data), password, salt);
          copy.data = null; copy.imageId = null; copy.thumb = null; copy.thumbId = null;
        }
        return copy;
      }));
    }

    cache.clips = incoming;
    const ok = await commit();
    if (!ok) throw new Error('persist failed');
    return incoming.length;
  }

  /* ============================================================
     Public API
     ============================================================ */
  window.Store = {
    // settings
    getSettings, saveSettings,
    // clips
    getClips, getClipsDecrypted, getImageData, getImageThumb, makeThumb,
    addClip, addEncryptedClip, updateClip, updateClipAsync,
    deleteClip, clearClips, replaceAll, clearCache,
    persistClips, pruneOldClips,
    // encryption
    isEncrypted, setPassword, isPasswordValid, encryptText, decryptText,
    enableEncryption, disableEncryption, clearKeyCache,
    // storage
    storageBytes, storageInfo, refreshUsage, isStorageNearQuota, getStorageError,
    setStorageErrorHandler,
    // export / import
    exportAll, importAll,
    // detection
    detectSensitiveContent,
    KEYS,
  };
})();
