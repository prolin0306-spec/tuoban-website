'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, readFile, rename, mkdir, rm, symlink, unlink, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
test('browser cleanup removes only its newly created profile and is repeatable', async () => {
  const { createBrowserProfile } = await import('./helpers/browser-profile.mjs');
  const profile = await createBrowserProfile();
  await writeFile(join(profile.path, 'test-cache'), 'invented browser data');
  await profile.remove(); await profile.remove();
  await assert.rejects(stat(profile.path), { code: 'ENOENT' });
});
test('browser cleanup refuses a replaced directory and preserves its contents', async () => {
  const { createBrowserProfile } = await import('./helpers/browser-profile.mjs');
  const profile = await createBrowserProfile(), saved = profile.path + '-saved';
  await rename(profile.path, saved); await mkdir(profile.path);
  try {
    await writeFile(join(profile.path, 'sentinel'), 'do not remove');
    await assert.rejects(profile.remove(), /unowned/);
    assert.equal(await readFile(join(profile.path, 'sentinel'), 'utf8'), 'do not remove');
  } finally {
    await rm(profile.path, { recursive: true }); await rename(saved, profile.path); await profile.remove();
  }
});
test('browser cleanup refuses a symlink and never removes the linked directory', async () => {
  const { createBrowserProfile } = await import('./helpers/browser-profile.mjs');
  const profile = await createBrowserProfile(), target = await createBrowserProfile(), saved = profile.path + '-saved';
  await writeFile(join(target.path, 'sentinel'), 'untouched');
  await rename(profile.path, saved); await symlink(target.path, profile.path);
  try {
    await assert.rejects(profile.remove(), /unowned/);
    assert.equal(await readFile(join(target.path, 'sentinel'), 'utf8'), 'untouched');
  } finally {
    await unlink(profile.path); await rename(saved, profile.path); await profile.remove(); await target.remove();
  }
});
test('browser stop awaits process exit before cleanup and handles already exited children', async () => {
  const { stopBrowser } = await import('./helpers/browser-profile.mjs');
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  child.kill = signal => setTimeout(() => { child.signalCode = signal; child.emit('exit'); }, 10);
  await stopBrowser(child); assert.equal(child.signalCode, 'SIGTERM');
  child.kill = () => assert.fail('already exited child must not be killed');
  await stopBrowser(child);
});
