/* ============================================================
   NovaClip — main application
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const State = {
    clips: [],          // in-memory (decrypted) view
    filter: 'all',
    search: '',
    sort: 'newest',
    selectedId: null,
    unlocked: false,
    lockPass: null,     // held in memory after unlock
    lastClipSig: null,
    editTargetId: null,
  };

  const ACCENTS = [
    { id: 'violet', color: '#7c6bff' },
    { id: 'blue', color: '#3b82f6' },
    { id: 'emerald', color: '#10b981' },
    { id: 'rose', color: '#f43f5e' },
    { id: 'amber', color: '#f59e0b' },
  ];

  /* ============================================================
     Helpers
     ============================================================ */
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('now');
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd';
    return new Date(ts).toLocaleDateString(window.NovaLang === 'fa' ? 'fa-IR' : 'en-US');
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    const ico = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    el.innerHTML = `<span class="t-ico">${ico}</span><span>${escapeHtml(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, 2400);
  }

  function confirmDialog(title, msg) {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-msg').textContent = msg;
      $('#confirm-modal').classList.remove('hidden');
      const ok = () => { cleanup(); resolve(true); };
      const cancel = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        $('#confirm-modal').classList.add('hidden');
        $('#confirm-ok').removeEventListener('click', ok);
        $('#confirm-cancel').removeEventListener('click', cancel);
      };
      $('#confirm-ok').addEventListener('click', ok);
      $('#confirm-cancel').addEventListener('click', cancel);
    });
  }

  /* ============================================================
     Type detection
     ============================================================ */
  const URL_RE = /^(https?:\/\/|ftp:\/\/)[^\s]+$/i;
  const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const RGB_RE = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i;

  function detectCode(text) {
    if (!text) return false;
    const lines = text.split('\n').length;
    if (lines < 3) return false;
    return /[{};]|\b(def|function|class|const|let|var|import|return|public|private|void|int|fn|func|=>|<\/)\b/.test(text)
      || /^\s{2,}\S/m.test(text)
      || /[{}]/.test(text);
  }

  function detectType(text) {
    const trimmed = (text || '').trim();
    if (URL_RE.test(trimmed)) {
      try { return { type: 'link', meta: { url: trimmed, host: new URL(trimmed).hostname } }; }
      catch (e) { return { type: 'link', meta: { url: trimmed, host: '' } }; }
    }
    if (EMAIL_RE.test(trimmed)) return { type: 'email', meta: { email: trimmed } };
    if (HEX_RE.test(trimmed)) return { type: 'color', meta: { hex: trimmed } };
    if (RGB_RE.test(trimmed)) {
      const m = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) {
        const hex = '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
        return { type: 'color', meta: { hex } };
      }
    }
    if (detectCode(trimmed)) return { type: 'code', meta: {} };
    return { type: 'text', meta: {} };
  }

  const TYPE_ICONS = { text: '▤', link: '🔗', email: '✉', color: '🎨', image: '🖼', code: '⌨' };

  function clipDisplayText(clip) {
    if (clip.type === 'color') return (clip.meta && clip.meta.hex) || clip.text || '';
    return clip.text || '';
  }

  /* ============================================================
     Rendering
     ============================================================ */
  function visibleClips() {
    let list = State.clips.slice();
    const q = State.search.trim().toLowerCase();
    if (q) {
      list = list.filter(c => (clipDisplayText(c) || '').toLowerCase().includes(q));
    }
    if (State.filter === 'favorites') list = list.filter(c => c.fav);
    else if (State.filter === 'pinned') list = list.filter(c => c.pinned);
    else if (State.filter !== 'all') list = list.filter(c => c.type === State.filter);

    switch (State.sort) {
      case 'oldest': list.sort((a, b) => a.ts - b.ts); break;
      case 'copied': list.sort((a, b) => (b.copies || 0) - (a.copies || 0)); break;
      case 'alpha': list.sort((a, b) => (clipDisplayText(a) || '').localeCompare(clipDisplayText(b) || '', window.NovaLang)); break;
      default: list.sort((a, b) => {
        if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        return b.ts - a.ts;
      });
    }
    return list;
  }

  function updateCounts() {
    const c = State.clips;
    const count = (fn) => fn(c);
    $('#count-all').textContent = count(x => x.length);
    $('#count-favorites').textContent = count(x => x.filter(i => i.fav).length);
    $('#count-pinned').textContent = count(x => x.filter(i => i.pinned).length);
    $('#count-text').textContent = count(x => x.filter(i => i.type === 'text' || i.type === 'code').length);
    $('#count-link').textContent = count(x => x.filter(i => i.type === 'link').length);
    $('#count-email').textContent = count(x => x.filter(i => i.type === 'email').length);
    $('#count-color').textContent = count(x => x.filter(i => i.type === 'color').length);
    $('#count-image').textContent = count(x => x.filter(i => i.type === 'image').length);
    updateStorage();
  }

  function updateStorage() {
    const bytes = Store.storageBytes();
    const s = Store.getSettings();
    $('#storage-value').textContent = fmtBytes(bytes);
    const pct = Math.min(100, Math.round(bytes / (4.5 * 1024 * 1024) * 100));
    $('#storage-fill').style.width = pct + '%';
    $('#list-sub').textContent = `${State.clips.length} / ${s.maxHistory}`;
  }

  function buildItemEl(clip) {
    const el = document.createElement('div');
    el.className = 'item' + (clip.pinned ? ' pinned' : '') + (clip.fav ? ' fav' : '') + (clip.id === State.selectedId ? ' selected' : '');
    el.dataset.id = clip.id;

    const display = clipDisplayText(clip);
    let thumb = `<span class="type-tag">${t('type_' + clip.type)}</span>`;
    let content;
    if (clip.type === 'image') {
      thumb = `<div class="thumb"><img src="${clip.data}" alt="" /></div>`;
      content = `<div class="text">🖼 ${escapeHtml(t('type_image'))}</div>`;
    } else if (clip.type === 'color') {
      thumb = `<div class="thumb" style="background:${escapeHtml(clip.meta.hex)}"></div>`;
      content = `<div class="text mono">${escapeHtml(display)}</div>`;
    } else {
      thumb = `<div class="thumb">${TYPE_ICONS[clip.type] || '▤'}</div>`;
      const cls = clip.type === 'code' ? 'code' : '';
      content = `<div class="text ${cls}">${escapeHtml(display)}</div>`;
    }

    el.innerHTML = `
      ${thumb}
      <div class="body">
        <div class="meta">
          <span class="type-tag">${escapeHtml(t('type_' + clip.type))}</span>
          <span class="time">${fmtTime(clip.ts)}</span>
        </div>
        ${content}
      </div>
      <div class="stars">
        <button class="pin ${clip.pinned ? 'on' : ''}" data-act="pin" title="${escapeHtml(t('pin'))}">📌</button>
        <button class="fav ${clip.fav ? 'on' : ''}" data-act="fav" title="${escapeHtml(t('favorite'))}">★</button>
      </div>`;
    return el;
  }

  function render() {
    const listEl = $('#list');
    const visible = visibleClips();

    // remove old items but keep the empty placeholder
    $$('#list .item').forEach(n => n.remove());
    const empty = $('#empty');

    if (visible.length === 0) {
      empty.classList.remove('hidden');
      if (State.search || State.filter !== 'all') {
        $('#empty h3').textContent = t('no_results');
        $('#empty p').textContent = '';
      } else {
        $('#empty h3').textContent = t('empty_title');
        $('#empty p').textContent = t('empty_desc');
      }
    } else {
      empty.classList.add('hidden');
      const frag = document.createDocumentFragment();
      visible.forEach(c => frag.appendChild(buildItemEl(c)));
      listEl.appendChild(frag);
    }
    updateCounts();
  }

  function renderPreview(clip) {
    const placeholder = $('#preview-placeholder');
    const body = $('#preview-body');
    if (!clip) {
      placeholder.classList.remove('hidden');
      body.classList.add('hidden');
      return;
    }
    placeholder.classList.add('hidden');
    body.classList.remove('hidden');

    const display = clipDisplayText(clip);
    let contentHtml = '';
    if (clip.type === 'image') {
      contentHtml = `<div class="preview-image"><img src="${clip.data}" alt="clip" /></div>`;
    } else if (clip.type === 'color') {
      contentHtml = `<div class="color-chip" style="background:${escapeHtml(clip.meta.hex)}"><span>${escapeHtml(display)}</span></div>`;
    } else {
      const cls = clip.type === 'code' ? 'code' : '';
      contentHtml = `<div class="preview-text ${cls}">${escapeHtml(display)}</div>`;
    }

    const chars = display.length;
    body.innerHTML = `
      <div class="preview-head">
        <div class="preview-type">${escapeHtml(t('type_' + clip.type))} · ${chars.toLocaleString()} ${escapeHtml(t('item_chars'))}</div>
        <div class="preview-title">${escapeHtml((display || '').slice(0, 90) || t('type_' + clip.type))}</div>
      </div>
      <div class="preview-actions">
        <button class="btn btn-primary" data-act="copy">⧉ ${escapeHtml(t('copy'))}</button>
        <button class="btn btn-ghost" data-act="fav">${clip.fav ? '★' : '☆'} ${escapeHtml(t('favorite'))}</button>
        <button class="btn btn-ghost" data-act="pin">📌 ${escapeHtml(t('pin'))}</button>
        <button class="btn btn-ghost" data-act="ai">✦ ${escapeHtml(t('ai'))}</button>
        <button class="btn btn-ghost" data-act="edit">✎ ${escapeHtml(t('edit_item'))}</button>
        <button class="btn btn-danger" data-act="delete">🗑 ${escapeHtml(t('delete'))}</button>
      </div>
      <div class="preview-content">${contentHtml}</div>
      <div class="preview-meta">
        <span>${escapeHtml(t('item_created'))}: ${fmtTime(clip.ts)}</span>
        <span>${escapeHtml(t('item_copied_count'))}: ${clip.copies || 0}</span>
      </div>`;
  }

  function selectClip(id, keepScroll) {
    State.selectedId = id;
    const clip = State.clips.find(c => c.id === id) || null;
    $$('#list .item').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
    renderPreview(clip);
    if (!keepScroll && clip) {
      const el = $('#list .item[data-id="' + id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ============================================================
     Clipboard capture
     ============================================================ */
  async function captureClipboard() {
    if (State.locked()) return;
    const res = await Bridge.readClipboard();
    if (!res) return;
    let clip = null;
    if (res.image) {
      const s = Store.getSettings();
      if (!s.captureImages) return;
      clip = { id: uid(), type: 'image', data: res.image, ts: Date.now(), copies: 0 };
    } else if (res.text != null && String(res.text).length > 0) {
      const text = String(res.text);
      const s = Store.getSettings();
      const det = detectType(text);
      const trimmed = text.length > s.maxChars ? text.slice(0, s.maxChars) : text;
      clip = { id: uid(), type: det.type, meta: det.meta, text: trimmed, ts: Date.now(), copies: 0 };
    }
    if (!clip) return;

    const sig = clip.type === 'image' ? 'img:' + clip.data.length : clip.type + ':' + clip.text;
    if (sig === State.lastClipSig) return; // avoid echo loops
    State.lastClipSig = sig;

    const s = Store.getSettings();
    if (s.encrypt && clip.text != null) {
      // dedup against in-memory decrypted clips
      if (s.dedup) {
        const dup = State.clips.find(c => c.text === clip.text && c.type === clip.type);
        if (dup) {
          dup.ts = Date.now(); dup.copies = (dup.copies || 0) + 1;
          Store.updateClip(dup.id, { ts: dup.ts, copies: dup.copies });
          State.clips = State.clips.filter(c => c.id !== dup.id);
          State.clips.unshift(dup);
          afterCapture(dup);
          return;
        }
      }
      const c = await Store.addEncryptedClip(clip, State.lockPass);
      c.text = clip.text;
      State.clips.unshift(c);
      if (State.clips.length > s.maxHistory) State.clips.length = s.maxHistory;
      afterCapture(c);
    } else {
      const c = Store.addClip(clip);
      if (!State.clips.some(x => x.id === c.id)) State.clips.unshift(c);
      else {
        // dedup moved existing to front
        State.clips = State.clips.filter(x => x.id !== c.id);
        State.clips.unshift(c);
      }
      afterCapture(c);
    }
  }

  function afterCapture(clip) {
    render();
    if (Store.getSettings().notify) {
      Bridge.notify('NovaClip', t('captured'));
    }
  }

  /* ============================================================
     Actions
     ============================================================ */
  async function copyClip(clip) {
    if (!clip) return;
    if (clip.type === 'image') {
      Bridge.writeImage(clip.data);
    } else {
      await Bridge.writeClipboard(clip.text || '');
    }
    State.lastClipSig = clip.type === 'image' ? 'img:' + clip.data.length : clip.type + ':' + clip.text;
    clip.copies = (clip.copies || 0) + 1;
    clip.ts = Date.now();
    Store.updateClip(clip.id, { copies: clip.copies, ts: clip.ts });
    toast(t('copied'), 'success');
    render();
    selectClip(clip.id, true);
  }

  function deleteClip(clip) {
    Store.deleteClip(clip.id);
    State.clips = State.clips.filter(c => c.id !== clip.id);
    if (State.selectedId === clip.id) { State.selectedId = null; renderPreview(null); }
    render();
    toast(t('deleted'));
  }

  function toggleFlag(clip, key) {
    const val = !clip[key];
    clip[key] = val;
    Store.updateClip(clip.id, { [key]: val });
    render();
    selectClip(clip.id, true);
    if (key === 'fav' && val) toast(t('favorite_added'), 'success');
    if (key === 'pin' && val) toast(t('pinned'), 'success');
  }

  function openEdit(clip) {
    // SECURITY: If clip is encrypted, we need password to edit
    if (clip.encrypted && typeof clip.encrypted === 'object') {
      if (!State.lockPass) {
        toast(t('encryption_warn'), 'error');
        showLock();
        return;
      }
    }
    State.editTargetId = clip.id;
    $('#edit-content').value = clip.text || '';
    $('#edit-modal').classList.remove('hidden');
    $('#edit-content').focus();
  }

  // SECURITY FIX #1: saveEdit now properly preserves encryption
  async function saveEdit() {
    const clip = State.clips.find(c => c.id === State.editTargetId);
    if (!clip) return;
    const val = $('#edit-content').value;
    const det = detectType(val);
    
    // Check if this clip is/was encrypted
    const wasEncrypted = !!(clip.encrypted && typeof clip.encrypted === 'object');
    const shouldEncrypt = Store.isEncrypted();
    
    if (shouldEncrypt || wasEncrypted) {
      // Re-encrypt if encryption is enabled or clip was encrypted
      if (State.lockPass) {
        // Use async update that handles encryption
        const updated = await Store.updateClipAsync(
          clip.id, 
          { text: val, type: det.type, meta: det.meta, ts: Date.now() },
          State.lockPass
        );
        if (updated) {
          // Update local state with decrypted view
          clip.text = val;
          clip.type = det.type;
          clip.meta = det.meta;
          clip.ts = Date.now();
          // Update the clip in State.clips
          const idx = State.clips.findIndex(c => c.id === clip.id);
          if (idx >= 0) {
            State.clips[idx] = Object.assign({}, clip);
          }
        }
      } else {
        toast(t('encryption_warn'), 'error');
        return;
      }
    } else {
      // Plaintext update
      clip.text = val;
      clip.type = det.type;
      clip.meta = det.meta;
      clip.ts = Date.now();
      Store.updateClip(clip.id, { text: val, type: det.type, meta: det.meta, ts: clip.ts });
    }
    
    $('#edit-modal').classList.add('hidden');
    render(); 
    selectClip(clip.id);
    toast(t('saved'), 'success');
  }

  async function exportAll() {
    const json = await Store.exportAll();
    const r = await Bridge.saveFile('novaclip-history.json', json);
    if (r !== null) toast(t('exported'), 'success');
  }

  function getSelectedClip() {
    return State.clips.find(c => c.id === State.selectedId) || null;
  }

  /* ============================================================
     AI
     ============================================================ */
  const AI_PRESETS = {
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '' },
    anthropic: { base: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', key: '' },
    deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '' },
    ollama: { base: 'http://localhost:11434/v1', model: 'llama3.2', key: 'ollama' },
    custom: { base: '', model: '', key: '' },
  };

  const AI_PROMPTS = {
    summarize: {
      openai: 'Summarize the following text concisely:',
      anthropic: 'Summarize the following text concisely.',
      custom: 'Summarize the following text concisely:',
    },
    translate: {
      openai: 'Translate the following text into Persian (فارسی). Output only the translation:',
      anthropic: 'Translate the following text into Persian (فارسی). Output only the translation.',
      custom: 'Translate the following text into Persian (فارسی). Output only the translation:',
    },
    explain: {
      openai: 'Explain the following text in simple terms:',
      anthropic: 'Explain the following text in simple terms.',
      custom: 'Explain the following text in simple terms:',
    },
    rewrite: {
      openai: 'Rewrite the following text in a clearer, more professional style:',
      anthropic: 'Rewrite the following text in a clearer, more professional style.',
      custom: 'Rewrite the following text in a clearer, more professional style:',
    },
  };

  function aiFields() {
    const s = Store.getSettings();
    const provider = s.ai.provider || 'openai';
    const preset = AI_PRESETS[provider] || AI_PRESETS.openai;
    return {
      provider,
      base: s.ai.base || preset.base || '',
      model: s.ai.model || preset.model || '',
      key: s.ai.key || '',
    };
  }

  function syncAiForm() {
    const s = Store.getSettings();
    const provider = $('#ai-provider').value;
    const preset = AI_PRESETS[provider] || {};
    $('#ai-base').value = s.ai.base || preset.base || '';
    $('#ai-model').value = s.ai.model || preset.model || '';
    $('#ai-base-field').style.display = (provider === 'custom' || provider === 'ollama') ? '' : 'none';
    $('#ai-key-field').style.display = (provider === 'ollama') ? 'none' : '';
  }

  function openAi(clip) {
    const src = clip ? (clip.text || '') : '';
    
    // SECURITY FIX #7: Detect sensitive content before showing AI panel
    const sensitive = Store.detectSensitiveContent(src);
    if (sensitive.sensitive) {
      const sensitiveTypes = sensitive.types.join(', ');
      $('#ai-source').innerHTML = `<span class="ai-warning">⚠️ ${escapeHtml(t('ai_sensitive_warning'))}</span><br><small class="ai-warning-detail">${escapeHtml(t('ai_sensitive_types') + ': ' + sensitiveTypes)}</small><hr>${escapeHtml(src.slice(0, 500))}${src.length > 500 ? '...' : ''}`;
      $('#ai-warning').classList.remove('hidden');
    } else {
      $('#ai-source').textContent = src || t('preview_hint');
      $('#ai-warning').classList.add('hidden');
    }
    
    $('#ai-output').textContent = '';
    $('#ai-output-wrap').classList.add('hidden');
    syncAiForm();
    $('#ai-panel').setAttribute('aria-hidden', 'false');
  }

  // SECURITY FIX #7: Show confirmation before sending sensitive data to AI
  async function confirmAiSend(src) {
    const sensitive = Store.detectSensitiveContent(src);
    if (sensitive.sensitive) {
      const confirmed = await confirmDialog(
        t('ai_sensitive_title'), 
        t('ai_sensitive_confirm')
      );
      if (!confirmed) return false;
    }
    return true;
  }

  async function runAi(action) {
    const s = Store.getSettings();
    s.ai.provider = $('#ai-provider').value;
    s.ai.base = $('#ai-base').value.trim();
    s.ai.model = $('#ai-model').value.trim();
    s.ai.key = $('#ai-key').value.trim();
    Store.saveSettings({ ai: s.ai });

    const fields = aiFields();
    if (!fields.key && fields.provider !== 'ollama') { toast(t('ai_need_key'), 'error'); return; }
    const src = $('#ai-source').textContent;
    if (!src || src === t('preview_hint')) { toast(t('preview_hint'), 'error'); return; }
    
    // SECURITY FIX #7: Confirm before sending sensitive data
    // Strip warning HTML if present to get actual source
    const cleanSrc = src.replace(/⚠️.*<\/span>.*<hr>/s, '').replace(/<[^>]*>/g, '');
    const canSend = await confirmAiSend(cleanSrc);
    if (!canSend) return;

    let instruction = (AI_PROMPTS[action] || AI_PROMPTS.summarize)[fields.provider] || AI_PROMPTS.summarize.custom;
    const customQ = $('#ai-question').value.trim();
    if (customQ) instruction = customQ;

    const outWrap = $('#ai-output-wrap');
    const out = $('#ai-output');
    outWrap.classList.remove('hidden');
    out.classList.add('streaming');
    out.textContent = '…';

    const endpoint = fields.base.replace(/\/+$/, '') + '/chat/completions';
    let body;
    let headers = { 'Content-Type': 'application/json' };
    if (fields.provider === 'anthropic') {
      // Anthropic uses its own endpoint
      headers['x-api-key'] = fields.key;
      headers['anthropic-version'] = '2023-06-01';
      try {
        const resp = await fetch(fields.base.replace(/\/+$/, '') + '/messages', {
          method: 'POST', headers,
          body: JSON.stringify({
            model: fields.model, max_tokens: 2000,
            messages: [{ role: 'user', content: instruction + '\n\n' + cleanSrc }],
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error && data.error.message ? data.error.message : 'HTTP ' + resp.status);
        out.classList.remove('streaming');
        out.textContent = (data.content && data.content[0] && data.content[0].text) || '';
        return;
      } catch (e) { out.classList.remove('streaming'); out.textContent = t('ai_error'); toast(t('ai_error'), 'error'); return; }
    } else {
      headers['Authorization'] = 'Bearer ' + fields.key;
      body = JSON.stringify({
        model: fields.model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Reply in the same language as the input unless instructed otherwise.' },
          { role: 'user', content: instruction + '\n\n' + cleanSrc },
        ],
        stream: false,
      });
    }

    try {
      const resp = await fetch(endpoint, { method: 'POST', headers, body });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error && data.error.message ? data.error.message : 'HTTP ' + resp.status);
      out.classList.remove('streaming');
      out.textContent = data.choices && data.choices[0] ? data.choices[0].message.content : '';
    } catch (e) {
      out.classList.remove('streaming');
      out.textContent = t('ai_error');
      toast(t('ai_error'), 'error');
    }
  }

  /* ============================================================
     Lock / encryption
     ============================================================ */
  State.locked = () => Store.isEncrypted() && !State.unlocked;

  function showLock() {
    $('#lock-modal').classList.remove('hidden');
    $('#lock-pass').value = '';
    $('#lock-error').classList.add('hidden');
    setTimeout(() => $('#lock-pass').focus(), 60);
  }

  async function tryUnlock() {
    const pass = $('#lock-pass').value;
    const ok = await Store.isPasswordValid(pass);
    if (!ok) { $('#lock-error').classList.remove('hidden'); return; }
    State.lockPass = pass;
    State.unlocked = true;
    State.clips = await Store.getClipsDecrypted(pass);
    $('#lock-modal').classList.add('hidden');
    render();
  }

  async function refreshClips() {
    if (State.locked()) {
      State.clips = [];
      render();
      showLock();
      return;
    }
    if (Store.isEncrypted() && State.lockPass) {
      State.clips = await Store.getClipsDecrypted(State.lockPass);
    } else {
      State.clips = Store.getClips();
    }
    render();
    if (State.selectedId && !State.clips.some(c => c.id === State.selectedId)) {
      State.selectedId = null; renderPreview(null);
    }
  }

  /* ============================================================
     Settings
     ============================================================ */
  function buildSwatches() {
    const wrap = $('#accent-swatches');
    wrap.innerHTML = '';
    ACCENTS.forEach(a => {
      const b = document.createElement('button');
      b.style.background = `linear-gradient(135deg, ${a.color}, ${a.color}cc)`;
      b.dataset.accent = a.id;
      if (a.id === (Store.getSettings().accent || 'violet')) b.classList.add('active');
      b.addEventListener('click', () => {
        applyAccent(a.id);
        Store.saveSettings({ accent: a.id });
        wrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
      wrap.appendChild(b);
    });
  }

  function applyAccent(id) {
    document.documentElement.setAttribute('data-accent', id);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function openSettings() {
    const s = Store.getSettings();
    $('#set-startup').checked = !!s.startup;
    $('#set-tray').checked = !!s.closeToTray;
    $('#set-notify').checked = !!s.notify;
    $('#set-shortcut').value = s.shortcut || 'Ctrl+Shift+V';
    $('#set-dark').checked = s.theme === 'dark';
    $('#set-lang').value = s.lang;
    $('#set-previeww').value = s.previewWidth;
    $('#set-max').value = s.maxHistory;
    $('#set-maxchars').value = s.maxChars;
    $('#set-dedup').checked = !!s.dedup;
    $('#set-images').checked = !!s.captureImages;
    $('#set-ai-provider').value = s.ai.provider || 'openai';
    $('#set-ai-base').value = s.ai.base || '';
    $('#set-ai-model').value = s.ai.model || '';
    $('#set-ai-key').value = s.ai.key || '';
    $('#set-encrypt').checked = Store.isEncrypted();
    $('#encrypt-pass-field').style.display = Store.isEncrypted() ? '' : 'none';
    $('#set-encrypt-pass').value = '';
    $('#about-version').textContent = (window.NovaConfig && NovaConfig.versionTag) ? NovaConfig.versionTag : 'v1.0.0';
    $('#about-platform').textContent =
      Bridge.platform === 'desktop' ? t('platform_desktop') : Bridge.platform === 'android' ? t('platform_android') : t('platform_web');
    switchTab('general');
    $('#settings-modal').classList.remove('hidden');
  }

  function switchTab(name) {
    $$('#settings-tabs .mtab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.stab').forEach(s => s.classList.toggle('active', s.dataset.pane === name));
  }

  async function saveSettingsFromUI() {
    const s = Store.getSettings();
    const patch = {
      startup: $('#set-startup').checked,
      closeToTray: $('#set-tray').checked,
      notify: $('#set-notify').checked,
      shortcut: $('#set-shortcut').value,
      theme: $('#set-dark').checked ? 'dark' : 'light',
      lang: $('#set-lang').value,
      previewWidth: +$('#set-previeww').value || 380,
      maxHistory: +$('#set-max').value || 500,
      maxChars: +$('#set-maxchars').value || 20000,
      dedup: $('#set-dedup').checked,
      captureImages: $('#set-images').checked,
      ai: {
        provider: $('#set-ai-provider').value,
        base: $('#set-ai-base').value.trim(),
        model: $('#set-ai-model').value.trim(),
        key: $('#set-ai-key').value.trim(),
      },
    };
    Store.saveSettings(patch);

    // theme / accent / lang
    applyTheme(patch.theme);
    applyI18n(patch.lang);
    document.documentElement.style.setProperty('--preview-w', patch.previewWidth + 'px');
    if (Bridge.isElectron) {
      Bridge.setStartup(patch.startup);
      Bridge.setCloseToTray(patch.closeToTray);
      Bridge.registerShortcutFor(patch.shortcut);
    }
    $('#set-shortcut').value = patch.shortcut;
    render();
    toast(t('saved'), 'success');
  }

  async function toggleEncryption() {
    const want = $('#set-encrypt').checked;
    const pass = $('#set-encrypt-pass').value;
    if (want) {
      if (!pass) { toast(t('encryption_warn'), 'error'); $('#set-encrypt').checked = false; return; }
      if (!Store.isEncrypted()) {
        // encrypt existing plaintext clips in place (preserve ids/order)
        const plain = Store.getClips();
        const encrypted = [];
        for (const c of plain) {
          const payload = await Store.encryptText(c.text || '', pass);
          encrypted.push(Object.assign({}, c, { encrypted: payload, text: null }));
        }
        Store.replaceAll(encrypted);
      }
      await Store.setPassword(pass);
      State.lockPass = pass;
      State.unlocked = true;
      toast(t('encryption_on'), 'success');
    } else {
      if (!Store.isEncrypted()) return;
      if (!State.lockPass) { toast(t('encryption_warn'), 'error'); $('#set-encrypt').checked = true; return; }
      const dec = await Store.getClipsDecrypted(State.lockPass);
      const plain = dec.map(c => { const d = Object.assign({}, c); delete d.encrypted; return d; });
      Store.replaceAll(plain);
      await Store.setPassword(null);
      State.unlocked = false;
      State.lockPass = null;
      toast(t('encryption_off'), 'success');
    }
    $('#set-encrypt').checked = Store.isEncrypted();
    $('#encrypt-pass-field').style.display = Store.isEncrypted() ? '' : 'none';
    await refreshClips();
  }

  /* ============================================================
     Event wiring
     ============================================================ */
  function bindEvents() {
    // nav filter
    $('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      State.filter = btn.dataset.filter;
      $$('#nav .nav-item').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });

    // search
    $('#search').addEventListener('input', () => {
      State.search = $('#search').value;
      $('#search-clear').classList.toggle('hidden', !State.search);
      render();
    });
    $('#search-clear').addEventListener('click', () => {
      $('#search').value = ''; State.search = '';
      $('#search-clear').classList.add('hidden');
      render(); $('#search').focus();
    });

    // sort
    $('#sort').addEventListener('change', () => { State.sort = $('#sort').value; render(); });

    // list delegation
    $('#list').addEventListener('click', (e) => {
      const starBtn = e.target.closest('.stars button');
      const item = e.target.closest('.item');
      if (!item) return;
      const id = item.dataset.id;
      const clip = State.clips.find(c => c.id === id);
      if (!clip) return;
      if (starBtn) {
        e.stopPropagation();
        toggleFlag(clip, starBtn.dataset.act);
        return;
      }
      selectClip(id);
    });
    $('#list').addEventListener('dblclick', (e) => {
      const item = e.target.closest('.item');
      if (!item) return;
      const clip = State.clips.find(c => c.id === item.dataset.id);
      if (clip) copyClip(clip);
    });

    // preview actions
    $('#preview-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const clip = getSelectedClip();
      if (!clip) return;
      const act = btn.dataset.act;
      if (act === 'copy') copyClip(clip);
      else if (act === 'fav' || act === 'pin') toggleFlag(clip, act);
      else if (act === 'delete') deleteClip(clip);
      else if (act === 'edit') openEdit(clip);
      else if (act === 'ai') openAi(clip);
    });

    // topbar
    $('#btn-capture').addEventListener('click', () => captureClipboard());
    $('#btn-theme').addEventListener('click', () => {
      const s = Store.getSettings();
      const next = s.theme === 'dark' ? 'light' : 'dark';
      Store.saveSettings({ theme: next });
      applyTheme(next);
      $('#set-dark').checked = next === 'dark';
    });
    $('#btn-lang').addEventListener('click', () => {
      const s = Store.getSettings();
      const next = s.lang === 'fa' ? 'en' : 'fa';
      Store.saveSettings({ lang: next });
      applyI18n(next);
      $('#set-lang').value = next;
      render();
    });
    $('#btn-ai').addEventListener('click', () => openAi(getSelectedClip()));
    $('#btn-settings').addEventListener('click', openSettings);

    // sidebar footer
    $('#btn-export').addEventListener('click', exportAll);
    $('#btn-clear').addEventListener('click', async () => {
      const ok = await confirmDialog(t('clear_confirm_title'), t('clear_confirm_msg'));
      if (!ok) return;
      Store.clearClips();
      State.clips = [];
      State.selectedId = null;
      renderPreview(null);
      render();
      toast(t('cleared'), 'success');
    });

    // AI panel
    $('#ai-close').addEventListener('click', () => $('#ai-panel').setAttribute('aria-hidden', 'true'));
    $('#ai-backdrop').addEventListener('click', () => $('#ai-panel').setAttribute('aria-hidden', 'true'));
    $('#ai-provider').addEventListener('change', syncAiForm);
    $('#ai-actions').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-ai]');
      if (chip) runAi(chip.dataset.ai);
    });
    $('#ai-run').addEventListener('click', () => runAi('custom'));
    $('#ai-copy').addEventListener('click', async () => {
      const txt = $('#ai-output').textContent;
      if (txt) { await Bridge.writeClipboard(txt); toast(t('copied'), 'success'); }
    });

    // settings modal
    $('#settings-close').addEventListener('click', () => { saveSettingsFromUI(); $('#settings-modal').classList.add('hidden'); });
    $('#settings-backdrop').addEventListener('click', () => { saveSettingsFromUI(); $('#settings-modal').classList.add('hidden'); });
    $('#settings-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.mtab');
      if (tab) switchTab(tab.dataset.tab);
    });
    $('#set-previeww').addEventListener('input', (e) => {
      document.documentElement.style.setProperty('--preview-w', e.target.value + 'px');
    });
    $('#set-encrypt').addEventListener('change', () => {
      $('#encrypt-pass-field').style.display = $('#set-encrypt').checked ? '' : 'none';
    });
    $('#btn-encrypt-now').addEventListener('click', toggleEncryption);

    // edit modal
    $('#edit-close').addEventListener('click', () => $('#edit-modal').classList.add('hidden'));
    $('#edit-cancel').addEventListener('click', () => $('#edit-modal').classList.add('hidden'));
    $('#edit-save').addEventListener('click', saveEdit);

    // lock modal
    $('#lock-unlock').addEventListener('click', tryUnlock);
    $('#lock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

    // keyboard
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); $('#search').focus();
      }
      if (e.key === 'Escape') {
        ['#ai-panel', '#settings-modal', '#edit-modal'].forEach(sel => {
          const el = $(sel);
          if (sel === '#settings-modal' && !el.classList.contains('hidden')) saveSettingsFromUI();
          if (sel === '#ai-panel') el.setAttribute('aria-hidden', 'true');
          else el.classList.add('hidden');
        });
      }
      if (e.target === document.body || e.target === $('#list')) {
        const items = visibleClips();
        const idx = items.findIndex(c => c.id === State.selectedId);
        if (e.key === 'ArrowDown' && idx < items.length - 1) { e.preventDefault(); selectClip(items[idx + 1].id); }
        if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); selectClip(items[idx - 1].id); }
        if (e.key === 'Delete' && State.selectedId) { const c = State.clips.find(x => x.id === State.selectedId); if (c) deleteClip(c); }
        if (e.key === 'Enter' && State.selectedId) { const c = State.clips.find(x => x.id === State.selectedId); if (c) copyClip(c); }
      }
    });

    // resize handling for preview width
    window.addEventListener('resize', () => {});
  }

  /* ============================================================
     Init
     ============================================================ */
  async function init() {
    const s = Store.getSettings();
    applyI18n(s.lang);
    applyTheme(s.theme);
    applyAccent(s.accent || 'violet');
    document.documentElement.style.setProperty('--preview-w', (s.previewWidth || 380) + 'px');
    $('#set-lang').value = s.lang;

    buildSwatches();
    bindEvents();

    // FIX #2: Storage error handling
    Store.setStorageErrorHandler((err) => {
      if (err.name === 'QuotaExceededError') {
        toast(t('storage_full_error'), 'error');
      } else {
        toast(t('storage_error'), 'error');
      }
    });

    // Check storage quota on startup
    if (Store.isStorageNearQuota()) {
      toast(t('storage_near_limit'), 'warning');
    }

    // platform badge
    if (Bridge.isElectron) {
      document.getElementById('titlebar').classList.remove('hidden');
      Bridge.registerShortcutFor(s.shortcut || 'Ctrl+Shift+V');
      Bridge.setTray();
    }
    if (Bridge.isAndroid && Bridge.startMonitor) {
      try { Bridge.startMonitor(); } catch (e) {}
    }

    await refreshClips();

    // capture loop
    let sig = null;
    const poll = async () => {
      try {
        const res = await Bridge.readClipboard();
        if (res) {
          // FIX #3: Use hash for more reliable change detection
          const sig2 = res.image ? 'img:' + res.image.length : 'txt:' + (res.text ? res.text.length : 0);
          if (sig2 !== sig) { sig = sig2; await captureClipboard(); }
        }
      } catch (e) {}
    };
    if (Bridge.isElectron || Bridge.isAndroid) {
      Bridge.onClipboardChange(() => captureClipboard());
      setInterval(poll, 1500); // safety net
    } else {
      setInterval(poll, 1500);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
