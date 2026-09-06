#!/usr/bin/env node
'use strict';
/* Runs every tests/*.test.js through Node's built-in test runner.
   Written out explicitly (rather than `node --test tests/`) because directory
   and glob arguments are handled differently across Node 18/20/22 and across
   shells — this works the same everywhere, including Windows CI. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

if (!files.length) {
  console.error('No test files found in tests/');
  process.exit(1);
}

console.log('Running ' + files.length + ' test files:');
for (const f of files) console.log('  - ' + path.basename(f));
console.log('');

const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
