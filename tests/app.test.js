'use strict';
/* End-to-end renderer tests: the app boots from the real index.html with the
   real config/i18n/bridge/store/app scripts, and we drive it through the DOM. */

const test = require('node:test');
const assert = require('node:assert');
const { createWindow, loadScripts, read, tick, waitFor, fire } = require('./helpers/harness');

const PW = 'correct horse battery staple';

/* ---------- boot ---------- */

async function bootApp(opts) {
  const o = opts || {};
  const html = read('app/index.html');
  const { window, document } = createWindow(html);

  const clipboard = { text: o.clipboard || '', writes: [] };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => clipboard.text,
      writeText: async (t) => { clipboard.text = t; clipboard.writes.push(t); },
    },
  });

  const net = { calls: [], response: { choices: [{ message: { content: 'model says hi' } }] } };
  window.fetch = async (url, init) => {
    net.calls.push({ url, init });
    return { ok: true, status: 200, json: async () => net.response };
  };

  window.__NOVA_TEST__ = true;

  if (o.clips) window.localStorage.setItem('novaclip.clips', JSON.stringify(o.clips));
  if (o.settings) window.localStorage.setItem('novaclip.settings', JSON.stringify(o.settings));

  loadScripts(window, ['app/config.js', 'app/i18n.js', 'app/bridge.js', 'app/store.js', 'app/app.js']);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  await waitFor(() => window.NovaTest && window.NovaTest.State.clips !== undefined, 3000, 'app init');
  await tick(30);

  return {
    window,
    document,
    Nova: window.NovaTest,
    Store: window.Store,
    Bridge: window.Bridge,
    clipboard,
    net,
    done: () => window.__clearTimers(),
  };
}

function storedClips(window) {
  const raw = window.localStorage.getItem('novaclip.clips');
  return raw ? JSON.parse(raw) : [];
}

/* ---------- #1 renderer change detection ---------- */

test('two different texts of the same length are both captured', async () => {
  const app = await bootApp({ clipboard: 'hello123' });
  try {
    await app.Nova.captureClipboard();
    assert.strictEqual(app.Nova.State.clips.length, 1);

    app.clipboard.text = 'world456';          // same length, different content
    await app.Nova.captureClipboard();

    assert.strictEqual(app.Nova.State.clips.length, 2, 'a length-based signature would have dropped this');
    assert.strictEqual(app.document.querySelectorAll('#list .item').length, 2);
    const texts = app.Nova.State.clips.map((c) => c.text).sort();
    assert.deepStrictEqual([...texts], ['hello123', 'world456']);
  } finally { app.done(); }
});

test('the signature comes from the platform, not from the renderer', async () => {
  const app = await bootApp({ clipboard: 'some text' });
  try {
    const res = await app.Bridge.readClipboard();
    assert.match(res.signature, /^t:[0-9a-f]{64}$/, 'renderer reads must carry a SHA-256 signature');

    await app.Nova.captureClipboard();
    assert.strictEqual(app.Nova.State.lastClipSig, res.signature);
  } finally { app.done(); }
});

test('re-reading an unchanged clipboard captures nothing', async () => {
  const app = await bootApp({ clipboard: 'stable' });
  try {
    await app.Nova.captureClipboard();
    await app.Nova.captureClipboard();
    await app.Nova.captureClipboard();
    assert.strictEqual(app.Nova.State.clips.length, 1);
  } finally { app.done(); }
});

test('copying a clip does not echo back as a new capture', async () => {
  const app = await bootApp({ clipboard: 'first', clips: [
    { id: 'c1', type: 'text', text: 'payload', ts: Date.now(), copies: 0 },
  ] });
  try {
    const clip = app.Nova.State.clips[0];
    await app.Nova.copyClip(clip);

    assert.strictEqual(app.clipboard.writes[0], 'payload');
    await app.Nova.captureClipboard();
    assert.strictEqual(app.Nova.State.clips.length, 1, 'our own write must not create a duplicate');
    assert.strictEqual(app.Nova.State.clips[0].copies, 1);
  } finally { app.done(); }
});

/* ---------- #7 AI source handling ---------- */

test('the AI panel keeps the source outside the DOM and sends it verbatim', async () => {
  const tricky = 'a < b && c > d & "quoted" <script>alert(1)</script>';
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: tricky, ts: Date.now(), copies: 0 },
  ] });
  try {
    app.Nova.openAi(app.Nova.State.clips[0]);

    // Display node holds the raw text (escaped by textContent, never parsed).
    assert.strictEqual(app.document.getElementById('ai-source').textContent, tricky);
    assert.strictEqual(app.Nova.State.aiSource, tricky);

    app.window.document.getElementById('ai-provider').value = 'openai';
    app.window.document.getElementById('ai-key').value = 'sk-test';
    await app.Nova.runAi('summarize');

    assert.strictEqual(app.net.calls.length, 1);
    const body = JSON.parse(app.net.calls[0].init.body);
    const userMsg = body.messages[body.messages.length - 1].content;
    assert.ok(userMsg.endsWith(tricky), 'the model must receive the untouched source, got: ' + userMsg);
    assert.ok(userMsg.indexOf('&amp;') === -1, 'no HTML escaping artefacts');
    assert.ok(userMsg.indexOf('⚠') === -1, 'no warning markup leaked into the prompt');
  } finally { app.done(); }
});

test('a sensitive clip shows a heuristic warning and asks before sending', async () => {
  // Assembled at runtime so no secret-shaped literal is committed (GitHub push
  // protection blocks those); detection still sees the full string.
  const secret = 'token: ' + 'ghp' + '_16C7e42F292c6912E7710c838347Ae178B4a';
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: secret, ts: Date.now(), copies: 0 },
  ] });
  try {
    app.Nova.openAi(app.Nova.State.clips[0]);

    const warning = app.document.getElementById('ai-warning');
    assert.ok(!warning.classList.contains('hidden'), 'warning must be visible');
    assert.ok(warning.textContent.includes('GITHUB_TOKEN'));
    assert.strictEqual(app.document.getElementById('ai-source').textContent, secret);

    app.document.getElementById('ai-provider').value = 'openai';
    app.document.getElementById('ai-key').value = 'sk-test';

    // Cancel the confirmation -> nothing is sent.
    const runPromise = app.Nova.runAi('summarize');
    await waitFor(() => !app.document.getElementById('confirm-modal').classList.contains('hidden'), 1000, 'confirm dialog');
    fire(app.document.getElementById('confirm-cancel'), 'click');
    await runPromise;

    assert.strictEqual(app.net.calls.length, 0, 'cancelling must prevent the request');

    // Confirm -> it is sent, still verbatim.
    const run2 = app.Nova.runAi('summarize');
    await waitFor(() => !app.document.getElementById('confirm-modal').classList.contains('hidden'), 1000, 'confirm dialog');
    fire(app.document.getElementById('confirm-ok'), 'click');
    await run2;

    assert.strictEqual(app.net.calls.length, 1);
    const body = JSON.parse(app.net.calls[0].init.body);
    assert.ok(body.messages[1].content.endsWith(secret));
  } finally { app.done(); }
});

test('closing the AI panel drops the source from memory', async () => {
  const app = await bootApp({ clips: [{ id: 'c1', type: 'text', text: 'private note', ts: Date.now(), copies: 0 }] });
  try {
    app.Nova.openAi(app.Nova.State.clips[0]);
    assert.strictEqual(app.Nova.State.aiSource, 'private note');

    app.Nova.closeAi();
    assert.strictEqual(app.Nova.State.aiSource, '');
    assert.strictEqual(app.document.getElementById('ai-source').textContent, '');
  } finally { app.done(); }
});

/* ---------- #2 / #3 encryption + memory ---------- */

async function enableEncryptionViaUi(app, password) {
  fire(app.document.getElementById('btn-settings'), 'click');
  const box = app.document.getElementById('set-encrypt');
  box.checked = true;
  fire(box, 'change');
  app.document.getElementById('set-encrypt-pass').value = password;
  fire(app.document.getElementById('btn-encrypt-now'), 'click');
  await waitFor(() => app.Store.isEncrypted(), 15000, 'encryption enabled');
  await tick(30);
}

test('enabling encryption migrates existing clips and leaves no plaintext', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
    { id: 'c2', type: 'text', text: 'beta secret', ts: Date.now() - 1000, copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);

    const raw = app.window.localStorage.getItem('novaclip.clips');
    assert.ok(raw.indexOf('alpha secret') === -1, 'stored history must be ciphertext');
    assert.ok(raw.indexOf('beta secret') === -1, 'stored history must be ciphertext');

    // Still usable in the unlocked session.
    assert.strictEqual(app.Nova.State.clips.length, 2);
    assert.strictEqual(app.document.querySelectorAll('#list .item').length, 2);
  } finally { app.done(); }
});

test('locking drops every decrypted byte the renderer holds', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);
    app.Nova.openAi(app.Nova.State.clips[0]);
    assert.strictEqual(app.Nova.State.aiSource, 'alpha secret');

    app.Nova.lockNow();

    assert.strictEqual(app.Nova.State.clips.length, 0);
    assert.strictEqual(app.Nova.State.lockPass, null);
    assert.strictEqual(app.Nova.State.unlocked, false);
    assert.strictEqual(app.Nova.State.aiSource, '');
    assert.strictEqual(app.document.querySelectorAll('#list .item').length, 0);
    assert.strictEqual(app.document.getElementById('ai-source').textContent, '');
    assert.ok(!app.document.getElementById('lock-modal').classList.contains('hidden'), 'lock screen must show');
  } finally { app.done(); }
});

test('a wrong password is rejected and the right one restores the list', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);
    app.Nova.lockNow();

    app.document.getElementById('lock-pass').value = 'not the password';
    await app.Nova.tryUnlock();
    assert.ok(!app.document.getElementById('lock-error').classList.contains('hidden'), 'error must show');
    assert.strictEqual(app.Nova.State.clips.length, 0);

    app.document.getElementById('lock-pass').value = PW;
    await app.Nova.tryUnlock();
    assert.strictEqual(app.Nova.State.clips.length, 1);
    assert.strictEqual(app.Nova.State.clips[0].text, 'alpha secret');
    assert.strictEqual(app.document.getElementById('lock-pass').value, '', 'password field must be cleared');
  } finally { app.done(); }
});

test('editing an encrypted clip never writes the new plaintext', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'before', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);

    app.Nova.openEdit(app.Nova.State.clips[0]);
    app.document.getElementById('edit-content').value = 'a freshly typed secret';
    await app.Nova.saveEdit();

    const raw = app.window.localStorage.getItem('novaclip.clips');
    assert.ok(raw.indexOf('a freshly typed secret') === -1, 'plaintext must not reach storage');
    assert.ok(raw.indexOf('before') === -1, 'the old plaintext must be gone too');
    assert.strictEqual(app.Nova.State.clips[0].text, 'a freshly typed secret', 'UI keeps the decrypted view');
  } finally { app.done(); }
});

test('auto-lock fires when the window is hidden', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);
    assert.strictEqual(app.Nova.State.unlocked, true);

    Object.defineProperty(app.document, 'hidden', { value: true, configurable: true });
    app.document.dispatchEvent(new app.window.Event('visibilitychange'));
    await tick(20);

    assert.strictEqual(app.Nova.State.unlocked, false);
    assert.strictEqual(app.Nova.State.clips.length, 0);
    assert.strictEqual(app.Nova.State.lockPass, null);
  } finally { app.done(); }
});

test('turning encryption off restores readable plaintext', async () => {
  const app = await bootApp({ clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);

    const box = app.document.getElementById('set-encrypt');
    box.checked = false;
    fire(box, 'change');
    app.document.getElementById('set-encrypt-pass').value = PW;
    fire(app.document.getElementById('btn-encrypt-now'), 'click');
    await waitFor(() => !app.Store.isEncrypted(), 15000, 'encryption disabled');
    await tick(30);

    const raw = app.window.localStorage.getItem('novaclip.clips');
    assert.ok(raw.indexOf('alpha secret') !== -1, 'plaintext should be back');
    assert.strictEqual(app.window.localStorage.getItem('novaclip.encrypted'), null);
  } finally { app.done(); }
});

/* ---------- misc UI wiring ---------- */

test('the lock button only appears for an unlocked encrypted history', async () => {
  const app = await bootApp({ clips: [{ id: 'c1', type: 'text', text: 'x', ts: Date.now(), copies: 0 }] });
  try {
    assert.strictEqual(app.document.getElementById('btn-lock').style.display, 'none');
    await enableEncryptionViaUi(app, PW);
    fire(app.document.getElementById('btn-settings'), 'click');
    assert.notStrictEqual(app.document.getElementById('btn-lock').style.display, 'none');
  } finally { app.done(); }
});

test('capture is blocked while the history is locked', async () => {
  const app = await bootApp({ clipboard: 'new content', clips: [
    { id: 'c1', type: 'text', text: 'alpha secret', ts: Date.now(), copies: 0 },
  ] });
  try {
    await enableEncryptionViaUi(app, PW);
    app.Nova.lockNow();

    const before = storedClips(app.window).length;
    await app.Nova.captureClipboard();
    assert.strictEqual(storedClips(app.window).length, before, 'nothing may be written while locked');
  } finally { app.done(); }
});

test('editing is refused for image clips instead of silently converting them', async () => {
  const img = 'data:image/png;base64,' + Buffer.from('pixels').toString('base64');
  const app = await bootApp({ clips: [
    { id: 'i1', type: 'image', data: img, ts: Date.now(), copies: 0 },
  ] });
  try {
    const clip = app.Nova.State.clips[0];
    app.Nova.openEdit(clip);
    assert.ok(app.document.getElementById('edit-modal').classList.contains('hidden'), 'editor must not open');

    app.document.getElementById('edit-content').value = 'typed over the image';
    await app.Nova.saveEdit();

    assert.strictEqual(app.Nova.State.clips[0].type, 'image', 'clip type must be preserved');
    assert.strictEqual(app.Nova.State.clips[0].data, img);
  } finally { app.done(); }
});
