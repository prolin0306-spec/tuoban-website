'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
// SHA-256 captured before the history-retention fix, also identical to homework-manager HEAD.
const baseline = '9842ed710f161e8d814360e687e59313178bbc9ad0eb5296ae5e3694fa101099';
const paths = ['common', ...['auth', 'books', 'classes', 'plans', 'settings', 'students', 'teachers'].map(name => name + '/common')];
for (const path of paths) test('original algorithm is unchanged: ' + path + '/planEngine.js', () => {
  const bytes = readFileSync(resolve(process.env.HOMEWORK_MANAGER_ROOT || resolve(__dirname, '../../homework-manager'), 'cloudfunctions', path, 'planEngine.js'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), baseline);
});
