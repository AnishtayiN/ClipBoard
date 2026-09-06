'use strict';
/* Static contract check: every `#id` selector the renderer scripts query must
   exist in index.html. A typo here is a null-dereference at runtime that the
   other suites would only catch if they happened to walk that path. */

const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./helpers/harness');

const SCRIPTS = ['app/app.js', 'app/bridge.js', 'app/updater.js', 'scripts/smoke.js'];

function idsInHtml() {
  const html = read('app/index.html');
  const ids = new Set();
  const re = /\sid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return ids;
}

function queriedIds(source) {
  const found = new Set();
  const patterns = [
    /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g,                 // $('#id')
    /getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g,      // document.getElementById('id')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) found.add(m[1]);
  }
  return found;
}

test('every element id queried by the renderer exists in index.html', () => {
  const htmlIds = idsInHtml();
  assert.ok(htmlIds.size > 40, 'sanity: index.html should declare many ids, found ' + htmlIds.size);

  const missing = [];
  for (const file of SCRIPTS) {
    for (const id of queriedIds(read(file))) {
      if (!htmlIds.has(id)) missing.push(file + ' -> #' + id);
    }
  }
  assert.deepStrictEqual(missing, [], 'unknown element ids: ' + missing.join(', '));
});

test('every data-i18n key used in index.html has a translation', () => {
  const html = read('app/index.html');
  const keys = new Set();
  const re = /data-i18n(?:-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) keys.add(m[1]);
  assert.ok(keys.size > 40, 'sanity: expected many i18n keys, found ' + keys.size);

  const src = read('app/i18n.js');
  const missing = [...keys].filter((k) => !new RegExp('^\\s*' + k + ':', 'm').test(src));
  assert.deepStrictEqual(missing, [], 'untranslated keys: ' + missing.join(', '));
});

test('the AI source node is write-only — the prompt comes from state', () => {
  const app = read('app/app.js');
  assert.ok(!/ai-source['"]\)\.innerHTML/.test(app), '#ai-source must never receive innerHTML');

  // Every reference to #ai-source must be an assignment. Reading the source
  // back out of the DOM is what let warning markup leak into the prompt.
  const all = app.match(/ai-source['"]\)\.textContent/g) || [];
  const writes = app.match(/ai-source['"]\)\.textContent\s*=[^=]/g) || [];
  assert.ok(all.length > 0, 'sanity: #ai-source should be written somewhere');
  assert.strictEqual(writes.length, all.length, 'every #ai-source access must be a write');

  assert.ok(/const src = State\.aiSource/.test(app), 'runAi must read State.aiSource');
});

test('no length-based clipboard signature remains in the renderer', () => {
  const app = read('app/app.js');
  assert.ok(!/image\.length/.test(app), 'no length-based image signature');
  assert.ok(!/text\.length\s*:\s*0/.test(app));
  assert.ok(/res\.signature/.test(app), 'captures must use the platform signature');
});

test('no MD5 digest is computed anywhere in the app', () => {
  for (const file of ['electron/main.js', 'electron/preload.js', 'electron/storage.js', 'app/store.js', 'app/app.js', 'app/bridge.js']) {
    assert.ok(!/createHash\(\s*['"]md5['"]/i.test(read(file)), file + ' still computes an MD5 digest');
  }
  // The clipboard fingerprint must be SHA-256.
  assert.ok(/createHash\('sha256'\)/.test(read('electron/main.js')));
});

test('every t() key used by the renderer has a translation in both languages', () => {
  const src = read('app/i18n.js');
  const used = new Set();
  for (const file of ['app/app.js', 'app/updater.js']) {
    const re = /\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g;
    let m;
    while ((m = re.exec(read(file))) !== null) used.add(m[1]);
  }
  assert.ok(used.size > 30, 'sanity: expected many t() keys, found ' + used.size);

  const missing = [...used].filter((k) => {
    const hits = src.match(new RegExp('^\\s*' + k + ':', 'gm')) || [];
    return hits.length < 2;                       // once for fa, once for en
  });
  assert.deepStrictEqual(missing, [], 'keys missing from fa or en: ' + missing.join(', '));
});
