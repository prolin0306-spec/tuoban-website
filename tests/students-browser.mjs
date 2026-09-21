// Local-only student management browser tests. Non-loopback requests are blocked through CDP.
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
const allowed = new Set(['/admin/homework-students.html', '/admin/css/common.css', '/admin/css/homework.css', '/admin/css/homework-students.css',
  '/admin/js/common.js', '/admin/js/homework-api.js', '/admin/js/homework-students.js']);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__api') {
      if (unavailable) { res.writeHead(503); res.end(); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await handle(JSON.parse(body)))); return;
    }
    if (pathname === '/js/cloudbase-v3.10.0.full.min.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(sdkStub); return; }
    if (pathname === '/admin/js/homework-config.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end('window.HOMEWORK_CONFIG={enabled:true,envId:"test-env",functionName:"webHomework"};'); return;
    }
    if (!allowed.has(pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(await readFile(join(site, pathname)));
  } catch (_) { res.writeHead(500); res.end('Test server failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'chunribu-students-browser-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: 'ignore' });
let socket, sequence = 0, sessionId, blocked = 0;
const pending = new Map(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(40); }
  throw new Error('Browser condition timed out: ' + expression);
}
async function check(name, fn) { await fn(); passes++; console.log('PASS ' + name); }
try {
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch (_) { await delay(40); } }
  if (!port) throw new Error('Chrome failed to start');
  socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === 'Fetch.requestPaused') {
      const local = message.params.request.url.startsWith(origin + '/'); if (!local) blocked++;
      send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId: message.params.requestId } : { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
    }
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: origin + '/admin/homework-students.html?classId=class-a' });

  await check('authorized list shows status, class, speed and book counts', async () => {
    await until('document.querySelectorAll(".sm-student").length===2');
    const body = await evaluate('document.body.innerText');
    for (const value of ['作业学生管理', '数据源：hw_students', '虚构学生甲', '测试甲班', '正常（0.8）', '3 本', '已启用']) assert.ok(body.includes(value));
    assert.equal(await evaluate('document.getElementById("classFilter").options.length'), 3);
    assert.equal(await evaluate('document.getElementById("classFilter").value'), 'class-a');
    assert.equal(await evaluate('document.querySelector(`.sm-controls a[href="homework-classes.html?new=1"]`)!==null'), true);
    assert.equal(await evaluate('document.querySelector(".adm-nav-item.active")?.getAttribute("href")'), 'homework-students.html');
    const links = await evaluate('Array.from(document.querySelectorAll(".adm-nav-item")).map(node=>node.getAttribute("href"))');
    assert.ok(links.includes('homework-classes.html'));
    assert.equal(links.indexOf('homework.html') - links.indexOf('homework-students.html'), 1);
  });
  await check('class filter and name search only show matching students', async () => {
    await evaluate('document.getElementById("classFilter").value="class-b";document.getElementById("classFilter").dispatchEvent(new Event("change"))');
    await until('document.body.innerText.includes("没有符合条件的学生")');
    await evaluate('document.getElementById("classFilter").value="";document.getElementById("classFilter").dispatchEvent(new Event("change"))');
    await until('document.querySelectorAll(".sm-student").length===2');
    await evaluate('document.getElementById("nameSearch").value="学生乙";document.getElementById("searchButton").click()');
    await until('document.querySelectorAll(".sm-student").length===1');
    assert.equal(await evaluate('document.querySelector(".sm-name").textContent'), '虚构学生乙');
    await evaluate('document.getElementById("nameSearch").value="";document.getElementById("refreshButton").click()');
    await until('document.querySelectorAll(".sm-student").length===2');
  });
  await check('add form uses normal speed default and second confirmation', async () => {
    await evaluate(`document.getElementById('addButton').click()`); await until('document.getElementById("studentDialog").open');
    assert.equal(await evaluate('document.getElementById("studentSpeed").value'), 'normal');
    assert.equal(await evaluate('document.getElementById("studentClass").value'), 'class-a');
    await evaluate(`document.getElementById('studentName').value='新增学生';document.getElementById('studentGrade').value='二年级';document.getElementById('studentClass').value='class-a';document.getElementById('studentForm').requestSubmit()`);
    await until('document.body.innerText.includes("学生已新增")');
    const student = data.hw_students.find(row => row.name === '新增学生'); assert.ok(student);
    assert.equal(student.speedLevel, 'normal'); assert.equal(student.speedCoefficient, 1); assert.equal(student.isActive, true);
    assert.equal(student.operatorTeacherId, 'teacher-a');
    assert.ok((await evaluate('window.__test.confirms')).at(-1).includes('确认新增学生'));
  });
  await check('edit updates fields and can move only without current plans', async () => {
    await evaluate(`document.querySelector('.sm-student[data-student-id="student-b"] .sm-actions button').click()`);
    await until('document.getElementById("studentDialog").open');
    assert.equal(await evaluate('document.getElementById("studentClass").disabled'), false);
    await evaluate(`document.getElementById('studentName').value='已编辑学生乙';document.getElementById('studentSpeed').value='fast';document.getElementById('studentClass').value='class-b';document.getElementById('studentForm').requestSubmit()`);
    await until('document.body.innerText.includes("学生信息已更新")');
    const student = data.hw_students.find(row => row._id === 'student-b');
    assert.equal(student.name, '已编辑学生乙'); assert.equal(student.classId, 'class-b'); assert.equal(student.speedCoefficient, 1.3);
  });
  await check('student with today plans gets a clear class-change warning', async () => {
    await evaluate(`document.querySelector('.sm-student[data-student-id="student-a"] .sm-actions button').click()`);
    await until('document.getElementById("studentDialog").open');
    assert.equal(await evaluate('document.getElementById("studentClass").disabled'), true);
    assert.equal(await evaluate('document.getElementById("classChangeWarning").hidden'), false);
    assert.ok((await evaluate('document.getElementById("classChangeWarning").textContent')).includes('V1 禁止调整班级'));
    await evaluate('document.getElementById("cancelButton").click()');
  });
  await check('disable and re-enable preserve history and show required warning', async () => {
    const before = JSON.stringify({ books: data.hw_homework_books, plans: data.hw_daily_plans, records: data.hw_daily_records });
    await evaluate(`document.querySelector('.sm-student[data-student-id="student-a"] .sm-actions button:nth-child(2)').click()`);
    await until('document.querySelector(`.sm-student[data-student-id="student-a"] .sm-state`).textContent==="已停用"');
    assert.equal(data.hw_students.find(row => row._id === 'student-a').isActive, false);
    assert.equal(JSON.stringify({ books: data.hw_homework_books, plans: data.hw_daily_plans, records: data.hw_daily_records }), before);
    assert.ok((await evaluate('window.__test.confirms')).at(-1).includes('不会删除历史作业记录'));
    assert.equal((await handle({ action: 'createBook', studentId: 'student-a', name: '禁止新增', totalAmount: 1 })).code, 'NOT_FOUND');
    await evaluate(`document.querySelector('.sm-student[data-student-id="student-a"] .sm-actions button:nth-child(2)').click()`);
    await until('document.querySelector(`.sm-student[data-student-id="student-a"] .sm-state`).textContent==="已启用"');
    assert.equal(data.hw_students.find(row => row._id === 'student-a').isActive, true);
  });
  await check('student names are rendered as text and mobile layout does not overflow', async () => {
    data.hw_students.find(row => row._id === 'student-a').name = '<img src=x onerror=alert(1)>';
    await evaluate('document.getElementById("refreshButton").click()');
    await until('document.querySelector(`.sm-student[data-student-id="student-a"] .sm-name`)?.textContent.includes("<img")');
    assert.equal(await evaluate('document.querySelectorAll(".sm-student img").length'), 0);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  });
  await check('session expiry clears student data and exposes login form', async () => {
    await evaluate('window.__test.loggedIn=false;document.getElementById("refreshButton").click()');
    await until('document.getElementById("loginPanel").hidden===false');
    assert.equal(await evaluate('document.querySelectorAll(".sm-student").length'), 0);
  });
  assert.ok(mock.writes >= 4); assert.equal(blocked, 0);
  console.log('RESULT ' + passes + ' student browser checks passed; simulated DB writes=' + mock.writes + '; external requests blocked=' + blocked);
} finally {
  if (socket) { for (const item of pending.values()) clearTimeout(item.timer); socket.close(); }
  chrome.kill(); await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
  await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true });
}
