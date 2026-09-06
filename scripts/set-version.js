#!/usr/bin/env node
/* ============================================================
   NovaClip — apply a release version across the project.
   Usage:
     node scripts/set-version.js <version> [versionCode]

   Updates:
     - package.json             -> version
     - package-lock.json        -> version (root + root package)
     - app/config.js            -> APP_VERSION
     - app/index.html           -> About fallback version
     - android/app/build.gradle -> versionName + versionCode
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = String(process.argv[2] || '').replace(/^v/i, '').trim();
const versionCode = String(process.argv[3] || '').trim();

function fail(msg) {
  console.error(`set-version.js: ${msg}`);
  process.exit(1);
}

if (!version) {
  fail('missing <version> argument. Usage: node scripts/set-version.js <version> [versionCode]');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`invalid version "${version}". Expected semver like 1.2.0.`);
}
if (versionCode && !/^\d+$/.test(versionCode)) {
  fail(`invalid versionCode "${versionCode}". Expected a positive integer.`);
}

/* ---------- package.json ---------- */
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

/* ---------- package-lock.json ---------- */
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} else {
  console.warn('set-version.js: warning: package-lock.json not found, skipped');
}

/* ---------- app/config.js ---------- */
const cfgPath = path.join(root, 'app', 'config.js');
let cfg = fs.readFileSync(cfgPath, 'utf8');
if (!/const APP_VERSION\s*=/.test(cfg)) {
  fail('could not find APP_VERSION in app/config.js');
}
cfg = cfg.replace(/(const APP_VERSION\s*=\s*)'[^']*'/, `$1'${version}'`);
fs.writeFileSync(cfgPath, cfg);

/* ---------- app/index.html (fallback version shown in About) ---------- */
const htmlPath = path.join(root, 'app', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const htmlBefore = html;
html = html.replace(/(id="about-version"[^>]*>)\s*v?[\d.]+/i, `$1v${version}`);
if (html === htmlBefore) {
  console.warn('set-version.js: warning: about-version fallback not found in app/index.html');
}
fs.writeFileSync(htmlPath, html);

/* ---------- android/app/build.gradle ---------- */
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (/versionCode\s+\d+/.test(gradle)) {
  if (versionCode) gradle = gradle.replace(/(versionCode\s+)\d+/, `$1${versionCode}`);
} else {
  console.warn('set-version.js: warning: versionCode not found in android/app/build.gradle');
}
if (/versionName\s+"[^"]*"/.test(gradle)) {
  gradle = gradle.replace(/(versionName\s+)"[^"]*"/, `$1"${version}"`);
} else {
  console.warn('set-version.js: warning: versionName not found in android/app/build.gradle');
}
fs.writeFileSync(gradlePath, gradle);

console.log(`Version set to ${version}`);
console.log(`Android versionCode set to ${versionCode || '(unchanged)'}`);
