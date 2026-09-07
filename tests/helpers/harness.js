'use strict';
/* Shared jsdom harness for the NovaClip renderer tests. */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function createWindow(html) {
  // jsdom logs "Not implemented: HTMLCanvasElement.prototype.getContext" when
  // the optional `canvas` package is absent; Store.makeThumb() handles that
  // gracefully, so keep the console quiet instead of failing the run.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM(html || '<!doctype html><html><head></head><body></body></html>', {
    url: 'https://novaclip.local/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const window = dom.window;
  // jsdom ships its own `crypto` (getRandomValues only) as a non-writable
  // accessor, so a plain assignment silently fails and `crypto.subtle` stays
  // undefined. Browsers always expose SubtleCrypto, so redefine it properly.
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true, writable: true });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  // Node 20's WebCrypto validates BufferSource arguments with realm-sensitive
  // checks.  Values created by jsdom's Uint8Array belong to the jsdom realm,
  // while the injected WebCrypto implementation belongs to Node's realm, so
  // decrypt() rejects otherwise valid ciphertext.  Real browsers keep these
  // objects in one realm; make the test harness match that setup.  (Node 22 is
  // more permissive, which is why this only failed in the Node 20 CI job.)
  Object.defineProperty(window, 'ArrayBuffer', { value: ArrayBuffer, configurable: true, writable: true });
  Object.defineProperty(window, 'Uint8Array', { value: Uint8Array, configurable: true, writable: true });
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  window.Notification = window.Notification || function () {};

  // Track timers so a test can stop the app's polling loops and let the
  // process exit.
  const timers = new Set();
  const realInterval = window.setInterval.bind(window);
  const realTimeout = window.setTimeout.bind(window);
  window.setInterval = (fn, ms) => { const id = realInterval(fn, ms); timers.add(id); return id; };
  window.setTimeout = (fn, ms) => { const id = realTimeout(fn, ms); timers.add(id); return id; };
  window.__clearTimers = () => {
    for (const id of timers) { window.clearInterval(id); window.clearTimeout(id); }
    timers.clear();
  };

  return { dom, window, document: window.document };
}

function loadScripts(window, files) {
  for (const f of files) window.eval(read(f));
}

async function tick(ms) { return new Promise((r) => setTimeout(r, ms || 0)); }

async function waitFor(fn, timeout, label) {
  const limit = timeout || 3000;
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - start > limit) throw new Error('timed out waiting for: ' + (label || 'condition'));
    await tick(10);
  }
}

function fire(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true }));
}

module.exports = { createWindow, loadScripts, read, tick, waitFor, fire, ROOT };
