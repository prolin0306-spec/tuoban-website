// Only this factory can create a removable browser profile; never accept a caller-supplied path.
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
export async function createBrowserProfile() {
  const root = await realpath(tmpdir()), prefix = 'chunribu-browser-test-';
  const path = await mkdtemp(join(root, prefix)), original = await lstat(path);
  return Object.freeze({ path, async remove() {
    let current;
    try { current = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (dirname(path) !== root || !basename(path).startsWith(prefix) || !current.isDirectory() ||
        current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || await realpath(path) !== path) {
      throw new Error('Refusing to remove an unowned browser profile');
    }
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } });
}
export async function stopBrowser(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let force, timeout;
    const done = error => {
      clearTimeout(force); clearTimeout(timeout); child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onExit = () => done();
    child.once('exit', onExit);
    force = setTimeout(() => child.kill('SIGKILL'), 2000);
    timeout = setTimeout(() => done(new Error('Browser did not exit; profile retained')), 5000);
    child.kill('SIGTERM');
  });
}
