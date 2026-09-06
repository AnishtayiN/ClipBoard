/* Headless smoke test for the NovaClip UI (jsdom). */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cfgSource = fs.readFileSync(path.join(root, 'app', 'config.js'), 'utf8');
const cfgVersion = (cfgSource.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || null;

const dom = new JSDOM(html, {
  url: 'https://novaclip.local/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

// jsdom polyfills
window.crypto = webcrypto;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { readText: () => Promise.resolve('hello from clipboard'), writeText: () => Promise.resolve() },
  });
}
window.Notification = window.Notification || function () {};

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

// seed history with a couple of clips BEFORE app init
const now = Date.now();
const seed = [
  { id: 'c1', type: 'text', text: 'سلام دنیا — this is a test clip', ts: now, copies: 2, fav: true },
  { id: 'c2', type: 'link', meta: { url: 'https://example.com', host: 'example.com' }, text: 'https://example.com', ts: now - 60000, copies: 0 },
  { id: 'c3', type: 'color', meta: { hex: '#7c6bff' }, text: '#7c6bff', ts: now - 120000, copies: 0, pinned: true },
];
window.localStorage.setItem('novaclip.clips', JSON.stringify(seed));
window.localStorage.setItem('novaclip.settings', JSON.stringify({ lang: 'fa', theme: 'dark', accent: 'violet', maxHistory: 500, maxChars: 20000, dedup: true, captureImages: true }));

// load app scripts in order
for (const f of ['config.js', 'i18n.js', 'bridge.js', 'store.js', 'app.js']) {
  const code = fs.readFileSync(path.join(root, 'app', f), 'utf8');
  window.eval(code);
}

// fire init
doc.dispatchEvent(new window.Event('DOMContentLoaded'));

setTimeout(async () => {
  try {
    check('title set', doc.title === 'NovaClip');
    check('dir is rtl', doc.documentElement.dir === 'rtl');
    check('list renders 3 items', doc.querySelectorAll('#list .item').length === 3);
    check('empty state hidden', doc.getElementById('empty').classList.contains('hidden'));
    check('counts: all=3', doc.getElementById('count-all').textContent === '3');
    check('counts: fav=1', doc.getElementById('count-favorites').textContent === '1');
    check('counts: pinned=1', doc.getElementById('count-pinned').textContent === '1');
    check('counts: link=1', doc.getElementById('count-link').textContent === '1');
    check('counts: color=1', doc.getElementById('count-color').textContent === '1');
    check('accent applied', doc.documentElement.getAttribute('data-accent') === 'violet');
    check('theme dark', doc.documentElement.getAttribute('data-theme') === 'dark');

    // new: config + developer links + update/support modals exist
    check('package.json version is valid semver', /^\d+\.\d+\.\d+$/.test(pkg.version));
    check('config.js APP_VERSION present', !!cfgVersion);
    check('package.json and config.js versions match', pkg.version === cfgVersion);
    check('NovaConfig version', window.NovaConfig && window.NovaConfig.version === cfgVersion);
    check('NovaConfig github url', window.NovaConfig && window.NovaConfig.github.url === 'https://github.com/AnishtayiN/ClipBoard');
    check('NovaConfig telegram url', window.NovaConfig && window.NovaConfig.telegram.url === 'https://t.me/AnishtayiN');
    check('about github link present', !!doc.querySelector('.about-link[data-open-url="https://github.com/AnishtayiN/ClipBoard"]'));
    check('about telegram link present', !!doc.querySelector('.about-link[data-open-url="https://t.me/AnishtayiN"]'));
    check('update modal present', !!doc.getElementById('update-modal'));
    check('support modal present', !!doc.getElementById('support-modal'));

    // select the text item -> preview shows
    const textItem = doc.querySelector('#list .item[data-id="c1"]');
    textItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('preview body visible after click', !doc.getElementById('preview-body').classList.contains('hidden'));
    check('preview has text', doc.querySelector('.preview-text').textContent.includes('سلام دنیا'));

    // copy action via preview button
    const copyBtn = doc.querySelector('.preview-actions button[data-act="copy"]');
    copyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check('toast shown', doc.querySelectorAll('#toasts .toast').length >= 1);

    // search filters
    const search = doc.getElementById('search');
    search.value = 'example';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    check('search filters to 1', doc.querySelectorAll('#list .item').length === 1);

    // nav filter
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const favNav = doc.querySelector('.nav-item[data-filter="favorites"]');
    favNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('favorites filter -> 1', doc.querySelectorAll('#list .item').length === 1);

    console.log(failures === 0 ? '\nSMOKE TEST: ALL PASS' : `\nSMOKE TEST: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('SMOKE TEST ERROR:', e);
    process.exit(1);
  }
}, 300);
