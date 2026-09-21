// Local-only class management browser tests. Non-loopback requests are blocked through CDP.
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
const { createService } = require(join(site, 'cloudfunctions/webHomework/service.js'));
const { createRepository } = require(join(site, 'cloudfunctions/webHomework/repository.js'));
const { fixture, mockDatabase } = require(join(site, 'tests/helpers/homework-fixture.js'));
const data = fixture(), mock = mockDatabase(data);
let caller = { uid: 'test-uid', isAnonymous: false }, unavailable = false, passes = 0;
const handle = createService({ repo: createRepository(mock.db), identity: async () => caller,
  environmentId: 'test-env', now: () => new Date('2026-09-15T04:00:00Z') });
const sdkStub = `window.__test={loggedIn:true,confirms:[]};window.confirm=message=>{window.__test.confirms.push(message);return true};
window.cloudbase={init(){const auth={getSession:async()=>({data:{session:window.__test.loggedIn?{sub:'test-uid'}:null}}),
signInWithPassword:async()=>{window.__test.loggedIn=true;return{data:{}}},signOut:async()=>{window.__test.loggedIn=false;return{data:{}}}};
return{auth,async callFunction(request){const response=await fetch('/__api',{method:'POST',body:JSON.stringify(request.data)});if(!response.ok)throw new Error('unavailable');return{result:await response.json()}}}}};`;
const allowed = new Set(['/admin/homework-classes.html', '/admin/css/common.css', '/admin/css/homework.css', '/admin/css/homework-classes.css',
  '/admin/js/common.js', '/admin/js/homework-api.js', '/admin/js/homework-classes.js']);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__api') {
      if (unavailable) { res.writeHead(503); res.end(); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await handle(JSON.parse(body)))); return;
    }
    if (pathname === '/js/cloudbase-v3.10.0.full.min.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(sdkStub); return; }
    if (pathname === '/admin/js/homework-config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.HOMEWORK_CONFIG={enabled:true,envId:"test-env",functionName:"webHomework"};'); return; }
    if (!allowed.has(pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(await readFile(join(site, pathname)));
  } catch (_) { res.writeHead(500); res.end('Test server failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'chunribu-classes-browser-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let socket, sequence = 0, sessionId, blocked = 0;
const pending = new Map(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value; }
async function until(expression) { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await delay(40); } throw new Error('Browser condition timed out: ' + expression); }
async function check(name, fn) { await fn(); passes++; console.log('PASS ' + name); }
try {
  let port; for (let i = 0; i < 150; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch (_) { await delay(40); } }
  if (!port) throw new Error('Chrome failed to start');
  socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === 'Fetch.requestPaused') { const local = message.params.request.url.startsWith(origin + '/'); if (!local) blocked++; send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId: message.params.requestId } : { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {}); }
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, null); sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: origin + '/admin/homework-classes.html?new=1' });
  await check('teacher sees only authorized classes and class metrics', async () => {
    await until('document.querySelectorAll(".cm-class").length===2');
    const body = await evaluate('document.body.innerText');
    for (const value of ['作业班级管理', '测试甲班', '测试代班', '学生：2/2', '作业本：4', '计划：3']) assert.ok(body.includes(value));
    assert.equal(await evaluate('document.querySelector(`.cm-class[data-class-id="class-a"] a[href="homework-students.html?classId=class-a"]`)!==null'), true);
    assert.equal(await evaluate('document.querySelector(`.cm-class[data-class-id="class-a"] a[href="homework.html?classId=class-a"]`)!==null'), true);
    assert.equal(await evaluate('document.querySelectorAll(".cm-class .adm-btn-danger").length'), 0);
    assert.equal(await evaluate('document.querySelector(".adm-nav-item.active")?.getAttribute("href")'), 'homework-classes.html');
    assert.equal(await evaluate('document.querySelector(".adm-nav-group > .adm-nav-item")?.getAttribute("href")'), 'homework-classes.html');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".adm-nav-children .adm-nav-item")).map(node=>node.getAttribute("href"))'),
      ['homework-students.html', 'homework.html']);
    assert.equal(await evaluate('document.getElementById("classDialog").open'), true);
    await evaluate('document.getElementById("cancelButton").click()');
  });
  await check('teacher creates a class and receives its permission in one operation', async () => {
    await evaluate(`document.getElementById('addClassButton').click()`); await until('document.getElementById("classDialog").open');
    await evaluate(`document.getElementById('className').value='网页新班';document.getElementById('classGrade').value='三年级';document.getElementById('classForm').requestSubmit()`);
    await until('document.body.innerText.includes("班级已新增")');
    const cls = data.hw_classes.find(row => row.name === '网页新班'); assert.ok(cls); assert.equal(cls.isActive, true);
    assert.deepEqual(cls.teacherIds, ['teacher-a']); assert.ok(data.hw_teachers[0].classIds.includes(cls._id));
    assert.ok((await evaluate('window.__test.confirms')).at(-1).includes('确认新增班级'));
  });
  await check('authorized class can be edited with confirmation', async () => {
    const id = data.hw_classes.find(row => row.name === '网页新班')._id;
    await evaluate(`document.querySelector('.cm-class[data-class-id="${id}"] .cm-actions button').click()`); await until('document.getElementById("classDialog").open');
    await evaluate(`document.getElementById('className').value='网页更新班';document.getElementById('classForm').requestSubmit()`);
    await until('document.body.innerText.includes("班级信息已更新")'); assert.equal(data.hw_classes.find(row => row._id === id).name, '网页更新班');
  });
  await check('boss can stop classes after all students are stopped while preserving history', async () => {
    data.hw_teachers[0].role = 'boss'; await evaluate('document.getElementById("refreshClassButton").click()');
    await until('document.querySelectorAll(".cm-class").length===4');
    await evaluate(`document.querySelector('.cm-class[data-class-id="class-b"] .adm-btn-danger').click()`);
    await until('document.querySelector(`.cm-class[data-class-id="class-b"]`).dataset.active==="false"'); assert.equal(data.hw_classes[1].isActive, false);
    await evaluate(`document.querySelector('.cm-class[data-class-id="class-b"] .adm-btn-primary').click()`);
    await until('document.querySelector(`.cm-class[data-class-id="class-b"]`).dataset.active==="true"'); assert.equal(data.hw_classes[1].isActive, true);
    await evaluate(`document.querySelector('.cm-class[data-class-id="class-a"] .adm-btn-danger').click()`);
    await until('document.body.innerText.includes("班级仍有启用学生")'); assert.equal(data.hw_classes[0].isActive, true);
    const history = JSON.stringify({ books: data.hw_homework_books, plans: data.hw_daily_plans, records: data.hw_daily_records });
    data.hw_students.filter(student => student.classId === 'class-a').forEach(student => { student.isActive = false; });
    await evaluate(`document.querySelector('.cm-class[data-class-id="class-a"] .adm-btn-danger').click()`);
    await until('document.querySelector(`.cm-class[data-class-id="class-a"]`).dataset.active==="false"');
    assert.equal(data.hw_classes[0].isActive, false);
    assert.equal(JSON.stringify({ books: data.hw_homework_books, plans: data.hw_daily_plans, records: data.hw_daily_records }), history);
  });
  await check('class names render as text and mobile layout stays within viewport', async () => {
    data.hw_classes[0].name = '<img src=x onerror=alert(1)>'; await evaluate('document.getElementById("refreshClassButton").click()');
    await until('document.querySelector(`.cm-class[data-class-id="class-a"] h2`)?.textContent.includes("<img")');
    assert.equal(await evaluate('document.querySelectorAll(".cm-class img").length'), 0);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  });
  await check('session expiry clears class data and shows login', async () => {
    await evaluate('window.__test.loggedIn=false;document.getElementById("retryButton").click()');
    await until('document.getElementById("loginPanel").hidden===false'); assert.equal(await evaluate('document.querySelectorAll(".cm-class").length'), 0);
  });
  assert.ok(mock.writes >= 5); assert.equal(blocked, 0);
  console.log('RESULT ' + passes + ' class browser checks passed; simulated DB writes=' + mock.writes + '; external requests blocked=' + blocked);
} finally {
  if (socket) { for (const item of pending.values()) clearTimeout(item.timer); socket.close(); }
  chrome.kill(); await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
  await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true });
}
