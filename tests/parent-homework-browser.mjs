// Local-only parent daily-feedback browser test. All data and network responses are invented.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createService } = require(join(site, 'cloudfunctions/webParentHomework/service.js'));
const { createRepository } = require(join(site, 'cloudfunctions/webParentHomework/repository.js'));
const { fixture, mockDatabase } = require(join(site, 'tests/helpers/homework-fixture.js'));
const data = fixture(); data.hw_students[0].feedbackChildId = 'feedback-child-a';
data.hw_homework_books[0].totalAmount = 2; data.hw_homework_books[0].completedAmount = 2;
const mock = mockDatabase(data);
const handle = createService({ repo: createRepository(mock.db), identity: async () => ({ uid: 'anonymous-test' }),
  now: () => new Date('2026-09-15T04:00:00Z') });
const stub = `window.cloudbase={init(){const auth={currentUser:{uid:'anonymous-test'},signInAnonymously:async()=>({})};
return{auth:()=>auth,database:()=>({collection(name){return{where(query){return{get:async()=>({data:name==='children'?(${JSON.stringify(data.children)}).filter(row=>row.parentPhone===query.parentPhone):[]}),orderBy(){return this}}}}}}),
callFunction:async request=>({result:await(await fetch('/__api',{method:'POST',body:JSON.stringify(request.data)})).json()})}}};`;
const allowed = new Set(['/daily-feedback.html', '/css/style.css', '/css/daily-feedback.css', '/js/daily-feedback.js']);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__api') {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await handle(JSON.parse(body)))); return;
    }
    if (pathname === '/js/cloudbase.full.min.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(stub); return; }
    if (!allowed.has(pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(await readFile(join(site, pathname)));
  } catch (_) { res.writeHead(500); res.end('Test server failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'chunribu-parent-browser-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: 'ignore' });
let socket, sequence = 0, sessionId;
const pending = new Map(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(40); }
  throw new Error('Browser condition timed out: ' + expression);
}
try {
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch (_) { await delay(40); } }
  if (!port) throw new Error('Chrome failed to start');
  socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    }
  };
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  sessionId = attached.sessionId;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: origin + '/daily-feedback.html' });
  await until('document.getElementById("queryBtn") && window.cloudbase');
  await evaluate(`document.getElementById('phoneInput').value='13800000001'; document.getElementById('queryBtn').click()`);
  await until('document.querySelector(".df-homework-card")');
  assert.match(await evaluate('document.getElementById("homeworkSection").textContent'), /整项已完成/);
  assert.match(await evaluate('document.getElementById("homeworkSection").textContent'), /今日实际：2/);
  await evaluate(`document.getElementById('phoneInput').value='13800000002'; document.getElementById('queryBtn').click()`);
  await until('document.getElementById("homeworkCaption").textContent.includes("尚未关联")');
  assert.equal(await evaluate('document.querySelectorAll(".df-homework-card").length'), 0);
  assert.equal(mock.writes, 0);
  console.log('PASS parent feedback shows linked homework, daily actual and clears it on another phone; simulated writes=0');
} finally {
  if (socket) socket.close(); chrome.kill(); server.close(); await rm(profile, { recursive: true, force: true });
}
