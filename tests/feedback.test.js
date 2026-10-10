'use strict';
const { test }=require('node:test');const assert=require('node:assert/strict');
const {createService}=require('../cloudfunctions/webHomework/service');
const {createRepository}=require('../cloudfunctions/webHomework/repository');
const {fixture,mockDatabase}=require('./helpers/homework-fixture');
function setup(){const data=fixture();data.hw_students[0].feedbackChildId='feedback-child-a';data.daily_reports=[];data.mistakes=[];const mock=mockDatabase(data);let uploads=0;
 const caller={uid:'test-uid',isAnonymous:false};const storage={upload:async()=>{uploads++;return 'cloud://fixture/mistake.png';},urls:async ids=>Object.fromEntries(ids.map(id=>[id,'https://images.example.test/mistake.png']))};
 return{data,mock,caller,get uploads(){return uploads;},handle:createService({repo:createRepository(mock.db),identity:async()=>caller,environmentId:'test-env',now:()=>new Date('2026-09-15T04:00:00Z'),storage})};}
const query={action:'studentFeedback',studentId:'student-a',date:'2026-09-15'};
const report={...query,action:'saveStudentFeedback',attendance:'正常',meal:'一般',learning:'虚构学习内容',behavior:'虚构表现',remarks:'虚构评语'};
const mistake={...query,action:'saveStudentMistake',subject:'数学',note:'虚构错题',requestId:'fictional-request-1',imageBase64:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64')};
test('feedback reads preserve all history with zero writes and permit dates older than seven days',async()=>{
 const s=setup();s.data.daily_reports.push({_id:'history',childId:'feedback-child-a',date:'2026-09-01',remarks:'历史'});const before=structuredClone(s.data);
 assert.equal((await s.handle({...query,date:'2026-09-01'})).data.report._id,'history');assert.deepEqual(s.data,before);assert.equal(s.mock.writes,0);assert.equal(s.uploads,0);
});
test('feedback shares original parent IDs and collection; repeated saves update one report preserving history',async()=>{
 const s=setup();s.data.daily_reports.push({_id:'old',childId:'feedback-child-a',date:'2026-09-01',remarks:'保留'});
 const a=await s.handle(report),b=await s.handle({...report,remarks:'更新'});assert.equal(a.code,'OK');assert.equal(a.data.id,b.data.id);assert.equal(s.data.daily_reports.length,2);
 assert.equal(s.data.daily_reports[1].childId,'feedback-child-a');assert.equal(s.data.daily_reports[1].remarks,'更新');assert.equal(s.data.daily_reports[0].remarks,'保留');
 assert.ok(s.mock.mutations.every(m=>m.collection==='daily_reports'));
});
test('feedback rejects forged identity, unauthorized, inactive, unlinked or duplicate-linked students',async()=>{
 for(const change of [s=>s.caller.uid='unknown',s=>s.data.hw_students[0].classId='class-c',s=>s.data.hw_students[0].isActive=false,s=>delete s.data.hw_students[0].feedbackChildId,s=>s.data.hw_students[1].feedbackChildId='feedback-child-a']){
 const s=setup();change(s);for(const action of [query,report,mistake])assert.notEqual((await s.handle(action)).code,'OK');assert.equal(s.mock.writes,0);assert.equal(s.uploads,0);}
 const s=setup();assert.equal((await s.handle({...report,childId:'feedback-child-b'})).code,'BAD_REQUEST');assert.equal((await s.handle({...report,role:'boss'})).code,'BAD_REQUEST');
});
test('feedback validates dates and fields and refuses duplicate history rather than overwriting it',async()=>{
 for(const change of [{date:'2026-02-30'},{date:'2026-08-01'},{date:'2026-09-16'},{remarks:'x'.repeat(3001)},{attendance:'bad'}]){const s=setup();assert.notEqual((await s.handle({...report,...change})).code,'OK');assert.equal(s.mock.writes,0);}
 const s=setup();s.data.daily_reports=[{_id:'one',childId:'feedback-child-a',date:query.date},{_id:'two',childId:'feedback-child-a',date:query.date}];assert.equal((await s.handle(report)).code,'DATA_CHANGED');assert.equal(s.mock.writes,0);
});
test('mistake upload is idempotent, parent-readable and deletion is explicit and scoped',async()=>{
 const s=setup();const r=await s.handle(mistake);assert.equal(r.code,'OK');assert.equal((await s.handle(mistake)).data.repeated,true);assert.equal(s.uploads,1);assert.equal(s.data.mistakes.length,1);assert.equal(s.data.mistakes[0].childId,'feedback-child-a');
 const before=s.mock.writes;const view=await s.handle(query);assert.equal(view.data.mistakes[0].imageURL,'https://images.example.test/mistake.png');assert.equal(s.mock.writes,before);
 s.data.mistakes.push({_id:'other',childId:'feedback-child-b'});assert.equal((await s.handle({action:'deleteStudentMistake',studentId:'student-a',mistakeId:'other'})).code,'FORBIDDEN');
 assert.equal((await s.handle({action:'deleteStudentMistake',studentId:'student-a',mistakeId:r.data.id})).code,'OK');assert.deepEqual(s.data.mistakes,[{_id:'other',childId:'feedback-child-b'}]);
});
test('invalid image and future mistake fail before any storage or DB mutation',async()=>{
 for(const value of [{imageBase64:'PHN2Zz4='},{imageBase64:'a'.repeat(2800001)},{date:'2026-09-16'},{requestId:'bad'}]){const s=setup();assert.notEqual((await s.handle({...mistake,...value})).code,'OK');assert.equal(s.uploads,0);assert.equal(s.mock.writes,0);}
});
test('permissions are rechecked after upload and before transaction commit',async()=>{
 const s=setup();s.mock.db.runTransaction=async callback=>{s.data.hw_teachers[0].isActive=false;return callback(s.mock.db);};assert.equal((await s.handle(mistake)).code,'TEACHER_DISABLED');assert.equal(s.mock.writes,0);
});

test('dashboard preserves authorized student and daily feedback counts without writes',async()=>{
 const s=setup();await s.handle(report);s.data.daily_reports.push({_id:'unrelated',childId:'unrelated-child',date:query.date});const before=structuredClone(s.data),writes=s.mock.writes;
 const result=await s.handle({action:'feedbackOverview'});assert.equal(result.code,'OK');assert.deepEqual(result.data,{total:2,done:1,pending:1,date:query.date});assert.equal(s.mock.writes,writes);assert.deepEqual(s.data,before);
});
