// Local-only unified homework navigation test. All data and API responses are invented.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBrowserProfile, stopBrowser } from './helpers/browser-profile.mjs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Fictional in-browser API only. The production SDK and auth scripts are never executed.
const stub = `window.adminReady=true;
window.__fixture={reports:[],mistakes:[],uploads:0,loggedOut:false};
window.adminAuth={check:()=>({name:'测试老师'}),logout:()=>{window.__fixture.loggedOut=true}};
const pupil={_id:'fixture-child',name:'虚构学生',class:'测试班级'};
window.adminAPI={today:()=> '2026-10-09',getStudents:async()=>[pupil],getStudent:async()=>pupil,getReport:async()=>null,
saveReport:async value=>{window.__fixture.reports.push(value)},getMistakes:async()=>window.__fixture.mistakes,
uploadMistakeImage:async file=>{if(!file)throw Error('Missing test image');window.__fixture.uploads++;return{fileID:'fixture-image'}},
saveMistake:async value=>{window.__fixture.mistakes.push({...value,_id:'fixture-mistake',date:'2026-10-09'})},
getMistakeImageURL:async()=> 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
deleteMistake:async()=>{throw Error('No deletion expected')}};`;
const allowed = new Set(['/admin/report-editor.html','/admin/mistakes.html','/admin/homework.html',
 '/admin/css/common.css','/admin/css/homework.css','/admin/js/common.js','/admin/js/homework.js','/admin/js/homework-api.js']);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (['/js/cloudbase.full.min.js','/js/cloudbase-v3.10.0.full.min.js','/admin/js/cloudbase.js','/admin/js/auth.js'].includes(pathname)) {
      res.setHeader('Content-Type','text/javascript');res.end('/* SDK disabled in local test */');return;
    }
    if (pathname === '/admin/js/api.js') { res.setHeader('Content-Type','text/javascript');res.end(stub);return; }
    if (pathname === '/admin/js/homework-config.js') { res.setHeader('Content-Type','text/javascript');res.end('window.HOMEWORK_CONFIG={enabled:false}');return; }
    if (!allowed.has(pathname)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(await readFile(join(site, pathname)));
  } catch (_) { res.writeHead(500); res.end('Test server failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browserProfile = await createBrowserProfile(), profile = browserProfile.path;
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
  for (let i = 0; i < 500; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch (_) { await delay(40); } }
  if (!port) throw new Error('Chrome failed to start');
  socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    }
    if (message.method === 'Fetch.requestPaused') {
      const local = message.params.request.url.startsWith(origin + '/');
      send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId: message.params.requestId } :
        { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
    }
  };
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  sessionId = attached.sessionId;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: origin + '/admin/report-editor.html' });
  await until('document.querySelector(".adm-student-actions a")');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#sidebarNav .adm-nav-item:not(.adm-nav-logout)")).map(a=>a.textContent.trim())'), ['仪表盘','学生管理','作业管理']);
  assert.equal(await evaluate('document.querySelector("#sidebarNav .active").getAttribute("href")'), 'homework.html');
  assert.equal(await evaluate('document.querySelector("#homeworkSectionNav [aria-current=page]").textContent'), '每日反馈');
  await evaluate('window.initSidebar("report-editor.html");window.initSidebar("report-editor.html")');
  assert.equal(await evaluate('document.querySelectorAll("#homeworkSectionNav").length'),1);
  console.log('PASS feedback belongs to homework and repeated navigation rendering stays unique');
  await evaluate('document.querySelector(".adm-student-actions a").click()');
  await until('document.getElementById("btnSave")');
  assert.equal(await evaluate('document.querySelector("#homeworkSectionNav [aria-current=page]").textContent'), '每日反馈');
  await evaluate('document.getElementById("learning").value="模拟学习反馈";document.getElementById("btnSave").click()');
  await until('window.__fixture.reports.length===1 && !document.getElementById("btnSave").disabled');
  assert.equal(await evaluate('window.__fixture.reports[0].childId'),'fixture-child');
  assert.equal(await evaluate('window.__fixture.reports[0].learning'),'模拟学习反馈');
  console.log('PASS selecting a student and saving daily feedback still works');
  await evaluate('document.querySelectorAll("#homeworkSectionNav a")[2].click()');
  await until('document.getElementById("mistakeStudent")?.options.length===2');
  assert.equal(await evaluate('document.querySelector("#sidebarNav .active").getAttribute("href")'),'homework.html');
  assert.equal(await evaluate('document.querySelector("#homeworkSectionNav [aria-current=page]").textContent'),'错题管理');
  assert.equal(await evaluate('window.__fixture.uploads'),0);
  await evaluate(`document.getElementById('mistakeStudent').value='fixture-child';
    document.getElementById('mistakeNote').value='模拟错题';
    const transfer=new DataTransfer();transfer.items.add(new File(['test image'],'fixture.png',{type:'image/png'}));
    document.getElementById('mistakeImage').files=transfer.files;document.getElementById('btnUpload').click()`);
  await until('window.__fixture.mistakes.length===1 && document.getElementById("mistakesList").textContent.includes("模拟错题")');
  assert.equal(await evaluate('window.__fixture.uploads'),1);
  assert.equal(await evaluate('window.__fixture.mistakes[0].childId'),'fixture-child');
  console.log('PASS mistakes tab preserves upload and record display using fictional data');
  for (const width of [375,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<500});
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
    assert.equal(await evaluate('Array.from(document.querySelectorAll("#homeworkSectionNav a")).every(a=>a.getBoundingClientRect().width>70 && a.getBoundingClientRect().height>=44)'),true);
  }
  console.log('PASS all three module links fit mobile and desktop layouts');
  await evaluate('document.querySelectorAll("#homeworkSectionNav a")[0].click()');
  await until('document.querySelector("#homeworkSectionNav [aria-current=page]")?.textContent==="作业清单"');
  assert.equal(await evaluate('document.querySelector("#sidebarNav .active").getAttribute("href")'),'homework.html');
  await evaluate('document.querySelectorAll("#homeworkSectionNav a")[1].click()');
  await until('document.querySelector(".adm-student-actions a")');
  await evaluate('document.getElementById("btnLogout").click()');
  assert.equal(await evaluate('window.__fixture.loggedOut'),true);
  console.log('PASS module navigation returns to homework and legacy logout remains available');
  console.log('RESULT 5 unified homework browser checks passed; only fictional data used');
} finally {
  for (const task of pending.values()) clearTimeout(task.timer);
  if (socket) socket.close();
  try {
    await stopBrowser(chrome);
    await browserProfile.remove();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
