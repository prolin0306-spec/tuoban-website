// End-to-end local integration only. The teacher and parent share one fictional database.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBrowserProfile, stopBrowser } from './helpers/browser-profile.mjs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),site=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {fixture,mockDatabase}=require('./helpers/homework-fixture');
const {createService}=require('../cloudfunctions/webHomework/service');
const {createRepository}=require('../cloudfunctions/webHomework/repository');
const parentService=require('../cloudfunctions/webParentHomework/service').createService;
const parentRepo=require('../cloudfunctions/webParentHomework/repository').createRepository;
const data=fixture(),today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const offset=days=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
data.hw_settings[0].termStartDate=offset(-30);data.hw_settings[0].termEndDate=offset(30);
for(const row of [...data.hw_daily_plans,...data.hw_daily_records])row.date=today;
data.hw_students[0].feedbackChildId='feedback-child-a';data.daily_reports=[];data.mistakes=[];
const mock=mockDatabase(data);let authenticated=false;
const teacher=createService({repo:createRepository(mock.db),identity:async()=>authenticated?{uid:'test-uid',isAnonymous:false}:null,environmentId:'test-env',storage:{upload:async()=> 'cloud://fixture/new.png',urls:async ids=>Object.fromEntries(ids.map(id=>[id,'https://images.example.test/new.png']))}});
const parent=parentService({repo:parentRepo(mock.db),identity:async()=>({uid:'fixture-parent'})});
const modern=`window.cloudbase={init(){return{auth:{getSession:async()=>({data:{session:sessionStorage.getItem('mock-session')?{sub:'test-uid'}:null}}),signInWithPassword:async v=>{if(v.password!=='fictional-pass')return{error:{message:'invalid'}};await fetch('/__login',{method:'POST'});sessionStorage.setItem('mock-session','yes');return{data:{}}},signInAnonymously:async()=>{sessionStorage.setItem('anonymous-called','yes');return{data:{}}},signOut:async()=>{await fetch('/__logout',{method:'POST'});sessionStorage.removeItem('mock-session');return{data:{}}}},callFunction:async req=>({result:await(await fetch(req.name==='webHomework'?'/__teacher':'/__parent',{method:'POST',body:JSON.stringify(req.data)})).json()})}}};`;
const legacy=`window.cloudbase={init(){return{auth:()=>({currentUser:{uid:'fixture-parent'},signInAnonymously:async()=>({})}),database:()=>({collection(name){return{where(query){return{orderBy(){return this},get:async()=>({data:await(await fetch('/__db',{method:'POST',body:JSON.stringify({name,query})})).json()})}}}}}),getTempFileURL:async()=>({fileList:[{tempFileURL:'https://images.example.test/new.png'}]})}}};`;
const allowed=new Set(['/admin/login.html','/admin/homework.html','/admin/dashboard.html','/admin/report-editor.html','/admin/mistakes.html','/admin/students.html','/admin/homework-classes.html','/daily-feedback.html','/css/style.css','/css/daily-feedback.css','/js/daily-feedback.js']);
const server=http.createServer(async(req,res)=>{try{
 const pathname=new URL(req.url,'http://localhost').pathname;let body='';
 if(pathname.startsWith('/__')){
  for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};res.setHeader('Content-Type','application/json');
  if(pathname==='/__login'){authenticated=true;res.end('{}');return;}if(pathname==='/__logout'){authenticated=false;res.end('{}');return;}
  if(pathname==='/__teacher'){res.end(JSON.stringify(await teacher(input)));return;}if(pathname==='/__parent'){res.end(JSON.stringify(await parent(input)));return;}
  if(pathname==='/__db'&&['children','daily_reports','mistakes'].includes(input.name)){res.end(JSON.stringify((data[input.name]||[]).filter(row=>Object.entries(input.query).every(([k,v])=>row[k]===v)).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')))));return;}
  res.writeHead(404);res.end();return;
 }
 if(pathname==='/js/cloudbase-v3.10.0.full.min.js'){res.setHeader('Content-Type','text/javascript');res.end(modern);return;}
 if(pathname==='/js/cloudbase.full.min.js'){res.setHeader('Content-Type','text/javascript');res.end(legacy);return;}
 if(pathname==='/admin/js/homework-config.js'){res.setHeader('Content-Type','text/javascript');res.end('window.HOMEWORK_CONFIG={enabled:true,envId:"test-env",functionName:"webHomework"};');return;}
 if(!allowed.has(pathname)&&!/^\/admin\/(js|css)\/[a-z-]+\.(js|css)$/.test(pathname)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(await readFile(join(site,pathname)));
}catch(_){res.writeHead(500);res.end('Test fixture failed');}});
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
  await send('Page.navigate',{url:origin+'/admin/homework.html'});
  await until('document.getElementById("loginPanel")?.hidden===false');
  await evaluate('sessionStorage.setItem("admin_teacher",JSON.stringify({id:"forged",role:"boss"}))');
  assert.equal(await evaluate('document.querySelectorAll(".hw-student").length'),0);
  await send('Page.navigate',{url:origin+'/admin/login.html?next=https://untrusted.example.test/'});
  await until('document.getElementById("adminLogin") && window.adminAuth');
  assert.equal(await evaluate('window.adminAuth.destination("https://untrusted.example.test/")'),'homework.html');
  await evaluate('document.getElementById("username").value="fixture-teacher";document.getElementById("password").value="fictional-pass";document.getElementById("adminLogin").requestSubmit()');
  await until('document.querySelectorAll(".hw-student").length===2');
  assert.equal(await evaluate('location.pathname'),'/admin/homework.html');
  assert.equal(await evaluate('sessionStorage.getItem("admin_teacher")'),null);
  assert.equal(await evaluate('document.getElementById("homeworkSectionNav")'),null);
  console.log('PASS one platform login; forged legacy cache and external redirects rejected');
  await evaluate('document.querySelector("[data-student-id=student-a]").open=true;document.querySelector("[data-feedback-student=student-a]").open=true');
  await until('document.querySelector("[data-feedback-form=student-a]")');
  await evaluate(`{const form=document.querySelector('[data-feedback-form=student-a]');form.elements.learning.value='虚构同步学习内容 <img src=x onerror=alert(1)>';form.elements.remarks.value='家长可见的虚构评语';form.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await evaluate('document.getElementById("refreshButton").click()');
  await until('document.querySelector("[data-feedback-form=student-a] textarea[name=remarks]")?.value==="家长可见的虚构评语"');
  await evaluate('document.querySelector("[data-feedback-form=student-a]").requestSubmit()');
  await until('document.body.textContent.includes("已保存，家长端可查询本次反馈")');
  assert.equal(data.daily_reports.length,1);assert.equal(data.daily_reports[0].childId,'feedback-child-a');
  console.log('PASS in-card feedback saves original parent collection and preserves drafts on refresh');
  await evaluate(`{const form=document.querySelector('[data-mistake-form=student-a]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])],'fixture.png',{type:'image/png'}));form.querySelector('input').files=transfer.files;form.elements.note.value='虚构同步错题';form.requestSubmit();}`);
  await until('document.body.textContent.includes("错题已保存，家长端可查询")');
  assert.equal(data.mistakes.length,1);assert.equal(data.mistakes[0].childId,'feedback-child-a');
  for(const width of [375,1280]){await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);}
  console.log('PASS in-card photo upload and desktop/mobile layouts');
  const before=structuredClone(data),writes=mock.writes;
  await send('Page.navigate',{url:origin+'/daily-feedback.html'});
  await until('document.getElementById("queryBtn") && window.cloudbase');
  await evaluate('document.getElementById("phoneInput").value="13800000001";document.getElementById("queryBtn").click()');
  await until('document.body.textContent.includes("家长可见的虚构评语") && document.body.textContent.includes("虚构同步错题")');
  assert.equal(await evaluate('document.querySelectorAll("#reportSection img[src=x]").length'),0);
  assert.equal(await evaluate('sessionStorage.getItem("anonymous-called")'),null);
  assert.equal(mock.writes,writes);assert.deepEqual(data,before);
  console.log('PASS parent reads teacher-saved feedback/mistake without writes or replacing teacher session');
  await send('Page.navigate',{url:origin+'/admin/report-editor.html?childId=feedback-child-a'});
  await until('location.pathname==="/admin/homework.html" && document.querySelector("[data-feedback-form=student-a]")');
  await send('Page.navigate',{url:origin+'/admin/dashboard.html'});
  await until('document.getElementById("dashboardLinks")?.hidden===false');
  assert.equal(await evaluate('document.querySelectorAll("#sidebarNav .adm-nav-item:not(.adm-nav-logout)").length'),3);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#statsGrid strong")).map(node=>node.textContent)'),['2','1','1']);
  await evaluate('document.getElementById("btnLogout").click()');
  await until('location.pathname==="/admin/login.html" && document.getElementById("adminLogin")');
  assert.equal(authenticated,false);assert.equal(await evaluate('sessionStorage.getItem("mock-session")'),null);
  console.log('PASS old links open integrated cards; dashboard shares login and logout');
  console.log('RESULT 5 integrated workflow browser checks passed, all data fictional');
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
