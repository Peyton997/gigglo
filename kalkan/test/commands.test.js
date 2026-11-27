'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

test('tools/check.js: söz dizimi, 18 modül başlatma ve komut şeması sorunsuz', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'check.js')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Her şey yolunda/);
});
