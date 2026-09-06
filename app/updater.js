/* ============================================================
   NovaClip — update checker + support prompt
   - On launch, checks the latest GitHub release. If a newer
     version exists, the app is blocked with a full-screen
     overlay offering direct-download links.
   - Every 2 days, shows a friendly "star on GitHub" prompt
     with a "Later" (dismiss) option.
   ============================================================ */
(function () {
  'use strict';

  const SUPPORT_KEY = 'novaclip.support.lastPrompt';
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  const RECHECK_INTERVAL = 60 * 60 * 1000; // 1 hour, silently

  const $id = (id) => document.getElementById(id);

  /* ---------- version helpers ---------- */
  function cleanVersion(v) {
    return String(v || '').replace(/^v/i, '').trim();
  }

  // "1.10.0" -> numeric comparable value (handles up to 3 segments)
  function versionToNum(v) {
    const parts = cleanVersion(v).split('.').map((n) => {
      const m = parseInt(n, 10);
      return isNaN(m) ? 0 : m;
    });
    let num = 0;
    for (let i = 0; i < 3; i++) num = num * 100000 + (parts[i] || 0);
    return num;
  }

  function latestTag(data) {
    return (data && (data.tag_name || data.name)) || '';
  }

  /* ---------- GitHub release ---------- */
  async function fetchLatestRelease() {
    if (typeof fetch !== 'function') return null;
    try {
      const resp = await fetch(NovaConfig.github.apiReleases, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  }

  // Pick the asset(s) relevant to this platform for direct download
  function pickAssets(data) {
    const assets = (data && Array.isArray(data.assets)) ? data.assets : [];
    if (!assets.length) return [];
    const isAndroid = window.Bridge && window.Bridge.isAndroid;
    if (isAndroid) {
      return assets.filter((a) => /\.apk$/i.test(a.name || ''));
    }
    // desktop / web: prefer Windows installers
    const exe = assets.filter((a) => /\.(exe|msi)$/i.test(a.name || ''));
    return exe.length ? exe : assets.filter((a) => /\.apk$/i.test(a.name || ''));
  }

  /* ---------- update blocking overlay ---------- */
  let updateBlocked = false;

  function showUpdate(data) {
    updateBlocked = true;

    const tag = latestTag(data);
    const assets = pickAssets(data);

    $id('update-version').textContent = tag || cleanVersion(NovaConfig.version);

    const wrap = $id('update-downloads');
    wrap.innerHTML = '';

    if (assets.length) {
      assets.forEach((a) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-ghost download-btn';
        btn.type = 'button';
        btn.innerHTML = `<span class="dl-ico">⬇</span><span class="dl-name">${escapeHtml(a.name || 'download')}</span>`;
        btn.addEventListener('click', () => {
          if (window.Bridge && Bridge.openExternal) Bridge.openExternal(a.browser_download_url);
        });
        wrap.appendChild(btn);
      });
    }

    // Always offer the releases page as a fallback
    $id('update-modal').classList.remove('hidden');
    $id('update-modal').setAttribute('aria-hidden', 'false');
  }

  async function checkUpdates() {
    if (updateBlocked) return false;
    const data = await fetchLatestRelease();
    if (!data) return false;
    const tag = latestTag(data);
    if (!tag) return false;
    // Only block if the remote version is strictly newer
    if (versionToNum(tag) <= versionToNum(NovaConfig.version)) return false;
    showUpdate(data);
    return true;
  }

  /* ---------- support prompt (every 2 days) ---------- */
  function shouldPromptSupport() {
    try {
      const last = parseInt(localStorage.getItem(SUPPORT_KEY), 10);
      if (!last) return true;
      return (Date.now() - last) >= TWO_DAYS;
    } catch (e) {
      return true;
    }
  }

  function markSupportShown() {
    try { localStorage.setItem(SUPPORT_KEY, String(Date.now())); } catch (e) {}
  }

  function showSupport() {
    if (updateBlocked) return;
    $id('support-modal').classList.remove('hidden');
    $id('support-modal').setAttribute('aria-hidden', 'false');
  }

  function hideSupport() {
    $id('support-modal').classList.add('hidden');
    $id('support-modal').setAttribute('aria-hidden', 'true');
  }

  /* ---------- helpers ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function openExternal(url) {
    if (!url) return;
    if (window.Bridge && Bridge.openExternal) Bridge.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  /* ---------- wire up ---------- */
  function bind() {
    // support modal
    const star = $id('support-star');
    const later = $id('support-later');
    const backdrop = $id('support-backdrop');
    if (star) star.addEventListener('click', () => {
      markSupportShown();
      hideSupport();
      openExternal(NovaConfig.github.url);
    });
    if (later) later.addEventListener('click', () => {
      markSupportShown();
      hideSupport();
    });
    if (backdrop) backdrop.addEventListener('click', () => {
      markSupportShown();
      hideSupport();
    });

    // update modal — releases fallback
    const releases = $id('update-releases');
    if (releases) releases.addEventListener('click', () => {
      openExternal(NovaConfig.github.releasesUrl);
    });

    // any element with data-open-url (e.g. About links)
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-open-url]');
      if (el) {
        e.preventDefault();
        openExternal(el.getAttribute('data-open-url'));
      }
    });
  }

  function init() {
    bind();

    // give the main UI a moment to render, then check
    setTimeout(async () => {
      const blocked = await checkUpdates();
      if (!blocked && shouldPromptSupport()) {
        showSupport();
      }
    }, 900);

    // silent periodic re-check (in case the app stays open for days)
    setInterval(async () => {
      await checkUpdates();
    }, RECHECK_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.NovaUpdater = {
    checkUpdates,
    showSupport,
    hideSupport,
    versionToNum,
  };
})();
