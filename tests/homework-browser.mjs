// Local-only browser tests. Every non-loopback request is blocked through CDP.
// Uses installed Chrome and Node >=22; no npm browser dependency is required.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const homework = site;
const { createService } = require(join(homework, 'cloudfunctions/webHomework/service.js'));
const { createRepository } = require(join(homework, 'cloudfunctions/webHomework/repository.js'));
const { fixture, mockDatabase } = require(join(homework, 'tests/helpers/homework-fixture.js'));
const data = fixture(), today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
for (const row of [...data.hw_daily_plans, ...data.hw_daily_records]) row.date = today;
data.hw_settings[0].termEndDate = new Date(Date.now() + 22 * 86400000).toISOString().slice(0, 10);
const mock = mockDatabase(data);
let caller = { uid: 'test-uid', isAnonymous: false }, unavailable = false, passes = 0;
const handle = createService({ repo: createRepository(mock.db), identity: async () => caller, environmentId: 'test-env' });
const sdkStub = `window.__test = { loggedIn: true, confirms: [] };window.confirm=message=>{window.__test.confirms.push(message);return true;};
window.cloudbase = { init() { const auth = {
 getSession: async () => ({data:{session:window.__test.loggedIn?{sub:'test-uid'}:null}}),
 signInWithPassword: async () => { window.__test.loggedIn = true; return {data:{}}; },
 signOut: async () => { window.__test.loggedIn = false; return {data:{}}; }
 }; return { auth,
 async callFunction(request) { const response = await fetch('/__api', {method:'POST',body:JSON.stringify(request.data)});
 if (!response.ok) throw new Error('unavailable'); return {result: await response.json()}; }
}; } };`;
const allowed = new Set(['/admin/homework.html','/admin/css/common.css','/admin/css/homework.css',
 '/admin/js/common.js','/admin/js/homework.js','/admin/js/homework-api.js']);
const server = http.createServer(async (req, res) => {
 try {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/__api') {
   if (unavailable) { res.writeHead(503); res.end(); return; }
   let body = ''; for await (const chunk of req) body += chunk;
   res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(await handle(JSON.parse(body)))); return;
  }
  if (pathname === '/js/cloudbase-v3.10.0.full.min.js') { res.setHeader('Content-Type','text/javascript'); res.end(sdkStub); return; }
  if (pathname === '/admin/js/homework-config.js') {
   res.setHeader('Content-Type','text/javascript'); res.end('window.HOMEWORK_CONFIG = {enabled:true,envId:"test-env",functionName:"webHomework"};'); return;
  }
  if (pathname === '/sdk-smoke.html') { res.end('<!doctype html><script src="/real-sdk.js"></script>'); return; }
  if (pathname === '/real-sdk.js') { res.setHeader('Content-Type','text/javascript'); res.end(await readFile(join(site,'js/cloudbase-v3.10.0.full.min.js'))); return; }
  if (pathname === '/nav-smoke.html') { res.end('<!doctype html><nav id="sidebarNav"></nav><script src="/admin/js/common.js"></script>'); return; }
  if (!allowed.has(pathname)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html; charset=utf-8');
  res.end(await readFile(join(site, pathname)));
 } catch (_) { res.writeHead(500); res.end('Test server failed'); }
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(),'chunribu-browser-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
 '--disable-component-update','--disable-sync','--metrics-recording-only','--disable-extensions',
 '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
 {stdio:'ignore'});
let socket, seq=0, sessionId, blocked=0;
const pending = new Map();
const delay = ms => new Promise(r=>setTimeout(r,ms));
function send(method,params={},session=sessionId) {
 return new Promise((resolve,reject)=>{
  const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
  pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));
 });
}
async function evaluate(expression) {
 const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails) throw new Error('Browser evaluation failed'); return r.result.value;
}
async function until(expression) {
 for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(40);} throw new Error('Browser condition timed out: '+expression);
}
async function check(name,fn){await fn();passes++;console.log('PASS '+name);}
async function openPage(path='/admin/homework.html?classId=class-a') {await send('Page.navigate',{url:origin+path});}
try {
 let port;
 for(let i=0;i<150;i++) {try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}catch(_){await delay(40);}}
 if(!port) throw new Error('Chrome failed to start');
 socket=new WebSocket('ws://127.0.0.1:'+port[0]+port[1]);
 await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 socket.addEventListener('message',event=>{
  const m=JSON.parse(event.data),p=pending.get(m.id);
  if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}
  if(m.method==='Fetch.requestPaused') {
   const local=m.params.request.url.startsWith(origin+'/');
   if(!local)blocked++;
   send(local?'Fetch.continueRequest':'Fetch.failRequest',local?{requestId:m.params.requestId}:{requestId:m.params.requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});
  }
 });
 const target=await send('Target.createTarget',{url:'about:blank'},null);
 sessionId=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
 await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 await check('desktop layout and backend-to-page contract',async()=>{
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await openPage();await until('document.querySelectorAll(".hw-student").length===2');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await evaluate('document.getElementById("classSelect").options.length'),2);
  assert.equal(await evaluate('document.getElementById("classSelect").value'),'class-a');
  assert.equal(await evaluate('document.querySelector(`.hw-controls a[href="homework-classes.html"]`)!==null'),true);
  assert.equal(await evaluate('document.getElementById("classStudentsLink").getAttribute("href")'),'homework-students.html?classId=class-a');
  await evaluate('document.querySelectorAll("details").forEach(e=>e.open=true)');
  const body=await evaluate('document.body.innerText');
  for(const label of ['实际：0','未记录','部分完成','尚未生成计划','预计完成率','实际完成率','优先级：','测试甲班'])assert.ok(body.includes(label));
  assert.equal(await evaluate('document.querySelector(".hw-student").dataset.color'),'green');
 });
 await check('configured warning thresholds and priority reach the page',async()=>{
  data.hw_settings[0].minCompletionRate=0.95;
  data.hw_settings[0].severeCompletionRate=0.85;
  data.hw_settings[0].dailyCapacity=1;
  await evaluate('document.getElementById("refreshButton").click()');
  await until('document.querySelector(".hw-student")?.dataset.color==="red"');
  await evaluate('document.querySelectorAll("details").forEach(e=>e.open=true)');
  const body=await evaluate('document.body.innerText');
  assert.ok(body.includes('红色预警'));assert.ok(body.includes('超出该生日容量'));
  assert.match(body,/优先级：\d+\.\d{2}/);
  assert.ok(body.includes('虚构学生甲'));
  data.hw_settings[0].minCompletionRate=0.8;
  data.hw_settings[0].severeCompletionRate=0.6;
  data.hw_settings[0].dailyCapacity=40;
 });
 await check('date filtering never generates plans or fabricates completion',async()=>{
  const before=JSON.stringify(data);
  await evaluate('document.getElementById("dateSelect").value="2026-01-01";document.getElementById("dateSelect").dispatchEvent(new Event("change"))');
  await until('document.querySelector(".hw-student")?.dataset.color==="unknown"');
  await evaluate('document.querySelectorAll("details").forEach(e=>e.open=true)');
  const body=await evaluate('document.body.innerText');
  assert.ok(body.includes('尚未生成计划'));assert.ok(!body.includes('实际完成率（所选日计划，按负载）：0%'));
  assert.equal(JSON.stringify(data),before);assert.equal(mock.writes,0);
  await evaluate(`document.getElementById("dateSelect").value=${JSON.stringify(today)};document.getElementById("dateSelect").dispatchEvent(new Event("change"))`);
  await until('document.querySelector(".hw-student")?.dataset.color==="green"');
 });
 await check('create book keeps mini-program defaults and does not alter existing plans',async()=>{
  const plansBefore=JSON.stringify(data.hw_daily_plans);
  await evaluate(`(()=>{document.getElementById('bookTarget').value='student';document.getElementById('bookTarget').dispatchEvent(new Event('change'));document.getElementById('bookStudent').value='student-b';document.getElementById('bookName').value='网页练习册';document.getElementById('bookSubject').value='math';document.getElementById('bookTotal').value='24';document.getElementById('bookWorkload').value='5';document.getElementById('bookUnit').value='页';document.getElementById('bookForm').requestSubmit()})()`);
  await until('document.body.innerText.includes("已保存 1 项作业，覆盖 1 名学生、1 本作业本")');
  const book=data.hw_homework_books.find(row=>row.name==='网页练习册');assert.ok(book);
  assert.deepEqual({studentId:book.studentId,classId:book.classId,subject:book.subject,totalAmount:book.totalAmount,
   workloadPerUnit:book.workloadPerUnit,unit:book.unit,completedAmount:book.completedAmount,isActive:book.isActive},
  {studentId:'student-b',classId:'class-a',subject:'math',totalAmount:24,workloadPerUnit:5,unit:'页',completedAmount:0,isActive:true});
 assert.equal(JSON.stringify(data.hw_daily_plans),plansBefore);
 });
 await check('generate today plan is explicit, one-time and does not run on refresh',async()=>{
  const writesBefore=mock.writes;
  await evaluate(`document.querySelector('.hw-student[data-student-id="student-b"] .hw-generate').click()`);
  await until('document.body.innerText.includes("已为 虚构学生乙 生成 2 项今日计划")');
  assert.equal(data.hw_daily_plans.filter(row=>row.studentId==='student-b'&&row.date===today).length,2);
  assert.ok(mock.writes>writesBefore);
  const afterGenerate=mock.writes;
  await evaluate('document.getElementById("refreshButton").click()');
  await until('document.querySelector(`.hw-student[data-student-id="student-b"] .hw-task`)!==null');
  assert.equal(mock.writes,afterGenerate);
  assert.equal(await evaluate('document.querySelector(`.hw-student[data-student-id="student-b"] .hw-generate`)===null'),true);
 });
 await check('record editor preserves explicit zero and updates one record',async()=>{
  await evaluate(`(()=>{const card=document.querySelector('.hw-student[data-student-id="student-b"]');card.open=true;const row=card.querySelector('.hw-task[data-book-id="book-d"]');const input=row.querySelector('[data-record-input="book-d"]');input.value='0';row.querySelector('button').click()})()`);
  await until('document.body.innerText.includes("已保存 虚构学生乙 · 测试作业d：0 页")');
  const records=data.hw_daily_records.filter(row=>row.studentId==='student-b'&&row.homeworkBookId==='book-d'&&row.date===today);
  assert.equal(records.length,1);assert.equal(records[0].actualAmount,0);assert.equal(records[0].status,'partial');
  assert.equal(data.hw_daily_plans.find(row=>row.studentId==='student-b'&&row.homeworkBookId==='book-d'&&row.date===today).isCompleted,false);
  await evaluate(`document.querySelector('.hw-student[data-student-id="student-b"]').open=true`);
 assert.equal(await evaluate(`document.querySelector('.hw-student[data-student-id="student-b"] [data-record-input="book-d"]').value`),'0');
 });
 await check('each planned task can be checked complete and unchecked to recorded zero',async()=>{
  await evaluate(`(()=>{const card=document.querySelector('.hw-student[data-student-id="student-b"]');card.open=true;card.querySelector('[data-completion-toggle="book-d"]').click()})()`);
  await until('document.body.innerText.includes("虚构学生乙 · 测试作业d 已标记为完成")');
  let record=data.hw_daily_records.find(row=>row.studentId==='student-b'&&row.homeworkBookId==='book-d'&&row.date===today);
  const plan=data.hw_daily_plans.find(row=>row.studentId==='student-b'&&row.homeworkBookId==='book-d'&&row.date===today);
  assert.equal(record.actualAmount,plan.plannedAmount);assert.equal(plan.isCompleted,true);
  await evaluate(`(()=>{const card=document.querySelector('.hw-student[data-student-id="student-b"]');card.open=true;card.querySelector('[data-completion-toggle="book-d"]').click()})()`);
  await until('document.body.innerText.includes("虚构学生乙 · 测试作业d 已标记为未完成")');
  record=data.hw_daily_records.find(row=>row.studentId==='student-b'&&row.homeworkBookId==='book-d'&&row.date===today);
  assert.equal(record.actualAmount,0);assert.equal(plan.isCompleted,false);
 });
 await check('one class input creates separate books for every active student without plans',async()=>{
  const plansBefore=JSON.stringify(data.hw_daily_plans),before=data.hw_homework_books.length;
  await evaluate(`(()=>{document.getElementById('bookTarget').value='class';document.getElementById('bookTarget').dispatchEvent(new Event('change'));document.getElementById('bookName').value='全班统一作业';document.getElementById('bookSubject').value='chinese';document.getElementById('bookTotal').value='18';document.getElementById('bookWorkload').value='3';document.getElementById('bookUnit').value='页';document.getElementById('bookForm').requestSubmit()})()`);
  await until('document.body.innerText.includes("已保存 1 项作业，覆盖 2 名学生、2 本作业本")');
  const books=data.hw_homework_books.slice(before);assert.equal(books.length,2);
  assert.deepEqual(books.map(row=>row.studentId).sort(),['student-a','student-b']);
  assert.ok(books.every(row=>row.name==='全班统一作业'&&row.classId==='class-a'&&row.completedAmount===0&&row.batchId));
  assert.equal(JSON.stringify(data.hw_daily_plans),plansBefore);
  assert.equal(await evaluate('document.getElementById("bookStudentLabel").hidden'),true);
  assert.ok((await evaluate('window.__test.confirms')).at(-1).includes('全部启用学生'));
 });
 await check('several names keep their own quantities in one class submission',async()=>{
  const plansBefore=JSON.stringify(data.hw_daily_plans),before=data.hw_homework_books.length;
  await evaluate(`(()=>{document.getElementById('bookName').value='语文阅读';document.getElementById('bookTotal').value='12';document.getElementById('addBookItemButton').click();const row=document.querySelectorAll('[data-book-item]')[1];row.querySelector('[data-book-field="name"]').value='数学口算';row.querySelector('[data-book-field="totalAmount"]').value='30';row.querySelector('[data-book-field="unit"]').value='题';document.getElementById('bookForm').requestSubmit()})()`);
  await until('document.body.innerText.includes("已保存 2 项作业，覆盖 2 名学生、4 本作业本")');
  const books=data.hw_homework_books.slice(before);assert.equal(books.length,4);
  for(const studentId of ['student-a','student-b']) assert.deepEqual(books.filter(row=>row.studentId===studentId).map(row=>[row.name,row.totalAmount,row.unit]),[['语文阅读',12,'页'],['数学口算',30,'题']]);
  assert.equal(JSON.stringify(data.hw_daily_plans),plansBefore);
  assert.equal(await evaluate('document.querySelectorAll("[data-book-item]").length'),1);
  assert.ok((await evaluate('window.__test.confirms')).at(-1).includes('数学口算：30 题'));
 });
 await check('mobile layout, navigation and expandable tasks',async()=>{
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await evaluate('document.getElementById("sidebarToggle").click()');
  await until('document.getElementById("sidebar").classList.contains("open")');
  assert.equal(await evaluate('document.querySelectorAll(".adm-nav-item.active").length'),1);
  await evaluate('document.getElementById("sidebarToggle").click()');
 });
 await check('empty authorized class, retry and class switching',async()=>{
  await evaluate('document.getElementById("classSelect").value="class-b";document.getElementById("classSelect").dispatchEvent(new Event("change"))');
  await until('document.body.innerText.includes("该班级暂无学生")');
  await evaluate('document.getElementById("classSelect").value="class-a";document.getElementById("classSelect").dispatchEvent(new Event("change"))');
  await until('document.querySelectorAll(".hw-student").length===2');
 });
 await check('session expiry clears all displayed student data',async()=>{
  await evaluate('window.__test.loggedIn=false;document.getElementById("refreshButton").click()');
  assert.equal(await evaluate('document.querySelectorAll(".hw-student").length'),0);
  assert.equal(await evaluate('document.getElementById("loginPanel").hidden'),false);
  await evaluate('document.getElementById("homeworkUsername").value="test";document.getElementById("homeworkPassword").value="fictional";document.getElementById("homeworkLogin").requestSubmit()');
  await until('document.querySelectorAll(".hw-student").length===2');
  assert.equal(await evaluate('document.getElementById("homeworkPassword").value'),'');
 });
 await check('logout uses platform adapter and clears data',async()=>{
  await evaluate('document.getElementById("btnLogout").click()');
  await until('document.body.innerText.includes("作业账号已退出")');
  assert.equal(await evaluate('window.__test.loggedIn'),false);
  assert.equal(await evaluate('document.querySelectorAll(".hw-student").length'),0);
 });
 await check('unavailable backend errors without sample fallback',async()=>{
  unavailable=true;await openPage();await until('document.body.innerText.includes("作业服务连接失败")');
  assert.equal(await evaluate('document.querySelectorAll(".hw-student").length'),0);
  unavailable=false;await evaluate('document.getElementById("retryButton").click()');
  await until('document.querySelectorAll(".hw-student").length===2');
 });
 await check('server revocation clears workspace; script-like names are rendered as text',async()=>{
  data.hw_students[0].name='<img src=x onerror=alert(1)>';
  await evaluate('document.getElementById("refreshButton").click()');
  await until('document.querySelector(".hw-student summary")?.textContent.includes("<img")');
  assert.equal(await evaluate('document.querySelectorAll(".hw-student img").length'),0);
  data.hw_teachers[0].isActive=false;
  await evaluate('document.getElementById("refreshButton").click()');
  await until('document.body.innerText.includes("作业老师未启用")');
  assert.equal(await evaluate('document.querySelectorAll(".hw-student").length'),0);
 });
 await check('original sidebar destinations and logout behavior remain intact',async()=>{
  await openPage('/nav-smoke.html');await until('typeof window.initSidebar==="function"');
  await evaluate('window.adminAuth={logout(){window.oldLogoutCalled=true}};window.initSidebar("dashboard.html")');
  const links=await evaluate('Array.from(document.querySelectorAll("nav a")).map(a=>a.getAttribute("href"))');
  for(const link of ['dashboard.html','students.html','report-editor.html','mistakes.html','homework-classes.html','homework-students.html','homework.html'])assert.ok(links.includes(link));
  await evaluate('document.getElementById("btnLogout").click()');assert.equal(await evaluate('window.oldLogoutCalled'),true);
 });
 await check('installed real SDK exposes required auth/call interfaces (no cloud calls)',async()=>{
  await openPage('/sdk-smoke.html');await until('typeof window.cloudbase!=="undefined"');
  const methods=await evaluate(`(()=>{const app=cloudbase.init({env:'test-env'});return [typeof app.callFunction,typeof app.auth.signInWithPassword,typeof app.auth.getSession,typeof app.auth.signOut]})()`);
  assert.deepEqual(methods,['function','function','function','function']);
 });
 assert.ok(mock.writes>=6);
 console.log('RESULT '+passes+' browser checks passed; simulated DB writes='+mock.writes+'; external requests blocked='+blocked);
} finally {
 if(socket){for(const p of pending.values())clearTimeout(p.timer);socket.close();}
 chrome.kill();await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));
 await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});
}
