'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/webHomework/service');
const { createRepository } = require('../cloudfunctions/webHomework/repository');
const { project, risk, validDate, shanghaiDate, calcPriorityScore } = require('../cloudfunctions/webHomework/projection');
const { buildProjection, distributeIntegers } = require('../cloudfunctions/webHomework/plan-engine');
const { AppError } = require('../cloudfunctions/webHomework/errors');
const { fixture, mockDatabase } = require('./helpers/homework-fixture');
function setup(data = fixture(), who = { uid: 'test-uid', isAnonymous: false }, pageSize = 17) {
  const mock = mockDatabase(data, pageSize);
  const handle = createService({ repo: createRepository(mock.db), identity: async () => {
    if (who instanceof Error) throw who; return who;
  }, environmentId: 'test-env', now: () => new Date('2026-09-15T04:00:00Z') });
  return { handle, mock, data };
}
const request = { action: 'workspace', classId: 'class-a', date: '2026-09-15' };
test('missing, anonymous and expired identities are rejected', async () => {
  for (const who of [null, {}, { uid: 'test-uid' }, { uid: 'test-uid', isAnonymous: true }, new AppError('AUTH_REQUIRED', 'expired')]) {
    assert.equal((await setup(fixture(), who).handle({ action: 'session' })).code, 'AUTH_REQUIRED');
  }
});
test('unlinked, inactive, duplicate, cross-environment mappings fail closed', async () => {
  for (const mode of ['missing', 'inactive', 'duplicate', 'environment']) {
    const d = fixture();
    if (mode === 'missing') d.integration_teacher_links = [];
    if (mode === 'inactive') d.integration_teacher_links[0].status = 'revoked';
    if (mode === 'duplicate') d.integration_teacher_links.push({ ...d.integration_teacher_links[0], _id: 'link-2' });
    if (mode === 'environment') d.integration_teacher_links[0].homeworkEnvId = 'other-env';
    assert.equal((await setup(d).handle({ action: 'session' })).code, 'TEACHER_UNLINKED');
  }
});
test('disabled/missing teacher and unknown role denied', async () => {
  const d = fixture(); d.hw_teachers[0].isActive = false;
  assert.equal((await setup(d).handle(request)).code, 'TEACHER_DISABLED');
  d.hw_teachers = [];
  assert.equal((await setup(d).handle(request)).code, 'TEACHER_DISABLED');
  const e = fixture(); e.hw_teachers[0].role = 'superuser';
  assert.equal((await setup(e).handle(request)).code, 'FORBIDDEN');
});
test('ordinary teacher and substitute see only confirmed classes; boss from database sees all', async () => {
  for (const role of ['teacher', 'substituteTeacher', 'boss']) {
    const d = fixture(); d.hw_teachers[0].role = role;
    const result = await setup(d).handle({ action: 'classes' });
    assert.equal(result.code, 'OK');
    assert.deepEqual(result.data.map(c => c.id), role === 'boss' ? ['class-a', 'class-b', 'class-c'] : ['class-a', 'class-b']);
  }
});
test('zero permissions never fall through to all classes; each call rechecks revocation', async () => {
  const d = fixture(); const s = setup(d);
  assert.equal((await s.handle(request)).code, 'OK');
  d.hw_teachers[0].classIds = []; d.hw_classes[1].substituteTeacherId = null;
  assert.deepEqual((await s.handle({ action: 'classes' })).data, []);
  assert.equal((await s.handle(request)).code, 'FORBIDDEN');
});
test('unauthorized class is rejected before any student query', async () => {
  const s = setup(); assert.equal((await s.handle({ ...request, classId: 'class-c' })).code, 'FORBIDDEN');
  assert.ok(s.mock.reads.every(r => r.collection !== 'hw_students'));
});
test('arbitrary actions, collections and client supplied identities never authorize', async () => {
  for (const event of [{ action: 'submit' }, { ...request, uid: 'boss' }, { ...request, collection: 'teachers' },
    { ...request, role: 'boss' }, { ...request, openid: 'boss-openid' }]) {
    assert.equal((await setup().handle(event)).code, 'BAD_REQUEST');
  }
  assert.equal((await setup(fixture(), null).handle({ ...request, userInfo: { openId: 'boss-openid' } })).code, 'AUTH_REQUIRED');
});
test('v3 transport metadata is ignored and cannot supply identity', async () => {
  const metadata = { uid: 'attacker', role: 'boss', teacherId: 'teacher-a' };
  assert.equal((await setup().handle({ action: 'session', tcbContext: metadata })).code, 'OK');
  assert.equal((await setup(fixture(), null).handle({ action: 'session', tcbContext: metadata })).code, 'AUTH_REQUIRED');
  for (const bad of [null, 'context', [], 1]) {
    assert.equal((await setup().handle({ action: 'session', tcbContext: bad })).code, 'BAD_REQUEST');
  }
});
test('invalid dates and query object injection fail', async () => {
  for (const date of ['2026-02-30', 'bad', { $gt: '' }]) assert.equal((await setup().handle({ ...request, date })).code, 'BAD_REQUEST');
  assert.equal((await setup().handle({ ...request, classId: { $ne: '' } })).code, 'BAD_REQUEST');
  assert.equal(validDate('2024-02-29'), true);
});
test('partial, zero, missing actual and record without a plan remain distinct', async () => {
  const r = await setup().handle(request); assert.equal(r.code, 'OK');
  const [s, empty] = r.data.students;
  assert.equal(s.tasks[0].actual, 2); assert.equal(s.tasks[0].status, 'partial');
  assert.equal(s.tasks[1].actual, 0); assert.equal(s.tasks[1].status, 'zero');
  assert.equal(s.tasks[2].actual, null); assert.equal(s.tasks[2].status, 'unrecorded');
  assert.equal(s.actualRate, null); assert.equal(empty.hasPlan, false);
  assert.equal(empty.tasks[0].actual, 1); assert.equal(empty.tasks[0].planned, null);
});
test('weighted actual rate converts units instead of summing pages and questions', async () => {
  const d = fixture(); d.hw_daily_plans = d.hw_daily_plans.slice(0, 2);
  const r = await setup(d).handle(request);
  // 2 pages * 2 workload / (4 pages * 2 + 2 questions * 5) = 4/18.
  assert.equal(r.data.students[0].actualRate, 4 / 18);
  d.hw_homework_books[1].workloadPerUnit = undefined;
  assert.equal((await setup(d).handle(request)).data.students[0].actualRate, null);
});
test('duplicates are flagged and not added or silently selected', async () => {
  const d = fixture(); d.hw_daily_records.push({ ...d.hw_daily_records[0], _id: 'record-duplicate' });
  const task = (await setup(d).handle(request)).data.students[0].tasks[0];
  assert.equal(task.status, 'conflict'); assert.equal(task.actual, null);
});
test('pagination reads all 257 rows even with server page size lower than requested', async () => {
  const d = fixture(); d.hw_students = Array.from({ length: 257 }, (_, i) => ({
    _id: 'student-' + String(i).padStart(4, '0'), classId: 'class-a', isActive: true
  }));
  const s = setup(d, { uid: 'test-uid', isAnonymous: false }, 17);
  assert.equal((await s.handle(request)).data.students.length, 257);
  assert.ok(s.mock.reads.filter(r => r.collection === 'hw_students').length > 15);
});
test('paginated plan/record/book rows are also complete', async () => {
  const d = fixture(); d.hw_students = [d.hw_students[0]];
  d.hw_homework_books = []; d.hw_daily_plans = []; d.hw_daily_records = [];
  for (let i = 0; i < 125; i++) {
    const book = 'book-' + i;
    d.hw_homework_books.push({ _id: book, studentId: 'student-a', unit: '页', workloadPerUnit: 1, totalAmount: 10, completedAmount: 1, isActive: true });
    d.hw_daily_plans.push({ _id: 'p-' + i, studentId: 'student-a', homeworkBookId: book, date: request.date, plannedAmount: 2 });
    d.hw_daily_records.push({ _id: 'r-' + i, studentId: 'student-a', homeworkBookId: book, date: request.date, actualAmount: 1 });
  }
  assert.equal((await setup(d).handle(request)).data.students[0].tasks.length, 125);
});
test('all queries have zero writes and exclude credentials/contact fields', async () => {
  const s = setup(), before = JSON.stringify(s.data);
  for (const e of [{ action: 'session' }, { action: 'classes' }, { action: 'students' }, request]) assert.equal((await s.handle(e)).code, 'OK');
  assert.equal(s.mock.writes, 0); assert.equal(JSON.stringify(s.data), before);
  for (const r of s.mock.reads) for (const k of ['password', 'phone', 'openid', 'parentPhone', 'note']) assert.ok(!r.fields[k]);
});
test('database errors are sanitized', async () => {
  const handle = createService({ repo: { list() { throw new Error('sensitive-value'); } }, identity: async () => ({ uid: 'u', isAnonymous: false }), environmentId: 'test-env' });
  assert.deepEqual(await handle({ action: 'session' }), { code: 'UNAVAILABLE', message: '作业服务暂不可用，请重试或联系管理员' });
});
test('projection keeps v3 rate formula and exact 60/80 percent soft boundaries', () => {
  const settings = { termEndDate: '2026-09-30' }, books = [{ totalAmount: 100, completedAmount: 0, workloadPerUnit: 2 }];
  for (const [coefficient, color] of [[0.5999, 'red'], [0.6, 'yellow'], [0.7999, 'yellow'], [0.8, 'green'], [1.3, 'green']]) {
    const p = project({ speedCoefficient: coefficient }, books, settings, request.date, request.date);
    assert.ok(Math.abs(p.rate - Math.min(1, coefficient)) < 1e-10); assert.equal(p.color, color);
  }
  assert.equal(risk(0.8), 'green'); assert.equal(risk(0.6), 'yellow'); assert.equal(risk(null), 'unknown');
});
test('no prediction invented for missing data, past dates or exhausted workdays', () => {
  const d = fixture(), s = d.hw_students[0], b = d.hw_homework_books.filter(b => b.studentId === s._id);
  for (const [student, books, settings, date] of [[{}, b, d.hw_settings[0], request.date],
    [s, [], d.hw_settings[0], request.date], [s, b, null, request.date],
    [s, b, { termEndDate: '2026-09-01' }, request.date], [s, b, d.hw_settings[0], '2026-09-14']]) {
    assert.equal(project(student, books, settings, date, request.date).rate, null);
  }
});

test('priority uses v3 risk, urgency and capacity gap weights', () => {
  // risk=.5, streak=.3, urgency=.5, capacity gap=.5 => .44
  assert.equal(calcPriorityScore({ rate: 0.5, remainingWorkdays: 10, todayTarget: 60, studentCapacity: 40 }, 20), 0.44);
  assert.equal(calcPriorityScore({ rate: null }, 20), null);
  assert.equal(calcPriorityScore({ rate: 0.5 }, null), null);
});

test('workspace sorts red, yellow, green, unknown; same color by descending priority', async () => {
  const d = fixture();
  d.hw_students = [0.9, 0.7, 0.5, 0.3, null].map((speedCoefficient, i) => ({
    _id: 's' + i, classId: 'class-a', isActive: true, speedCoefficient
  }));
  d.hw_homework_books = d.hw_students.map(s => ({ _id: 'b' + s._id, studentId: s._id,
    totalAmount: 100, completedAmount: 0, workloadPerUnit: 1, isActive: true }));
  const cards = (await setup(d).handle(request)).data.students;
  assert.deepEqual(cards.map(s => s.id), ['s3', 's2', 's1', 's0', 's4']);
  assert.deepEqual(cards.map(s => s.projection.color), ['red', 'red', 'yellow', 'green', 'unknown']);
  assert.ok(cards[0].priorityScore > cards[1].priorityScore);
  assert.equal(cards[4].priorityScore, null);
});

test('settings thresholds, capacity, term dates and holidays drive projections', async () => {
  const d = fixture(); Object.assign(d.hw_settings[0], {
    minCompletionRate: 0.95, severeCompletionRate: 0.85, dailyCapacity: 1,
    holidays: ['2026-09-16']
  });
  const s = setup(d), result = await s.handle(request);
  const p = result.data.students.find(c => c.id === 'student-a').projection;
  assert.equal(p.color, 'red'); assert.equal(p.studentCapacity, 0.8);
  assert.equal(p.remainingWorkdays, 11);
  assert.ok(p.alerts.some(a => a.type === 'capacity'));
  assert.ok(Number.isFinite(p.priorityScore));
  for (const field of ['termStartDate', 'termEndDate', 'workDays', 'holidays', 'dailyCapacity', 'minCompletionRate', 'severeCompletionRate']) {
    assert.equal(s.mock.reads.find(r => r.collection === 'hw_settings').fields[field], true);
  }
  d.hw_settings[0].minCompletionRate = 0.5;
  assert.equal((await s.handle(request)).data.students[0].projection.rate, null);
});

test('missing plans stay missing across repeated reads; no generation or writes', async () => {
  const d = fixture(); d.hw_daily_plans = []; d.hw_daily_records = [];
  const before = JSON.stringify(d), s = setup(d);
  for (let i = 0; i < 3; i++) {
    const result = await s.handle(request);
    assert.equal(result.code, 'OK');
    for (const card of result.data.students) {
      assert.equal(card.hasPlan, false); assert.deepEqual(card.tasks, []);
      assert.equal(card.actualRate, null); assert.equal(card.actualRateReason, '尚未生成计划');
    }
  }
  assert.equal(s.mock.writes, 0); assert.equal(JSON.stringify(d), before);
  assert.equal(require('../cloudfunctions/webHomework/projection').generatePlan, undefined);
});

test('missing actual records are unrecorded, never fabricated as zero percent', async () => {
  const d = fixture(); d.hw_daily_records = [];
  const card = (await setup(d).handle(request)).data.students.find(c => c.id === 'student-a');
  assert.equal(card.actualRate, null); assert.equal(card.actualRateReason, '未记录');
  assert.ok(card.tasks.every(t => t.actual === null && t.status === 'unrecorded'));
});

test('every non-allowlisted action is rejected before identity or database access', async () => {
  let accessed = false;
  const handle = createService({ environmentId: 'test-env',
    identity: async () => { accessed = true; throw new Error('unexpected identity call'); },
    repo: { list() { accessed = true; throw new Error('unexpected query'); } }
  });
  for (const action of ['submit', 'halve', 'boost', 'postpone', 'today', 'student', 'generatePlan',
    'add', 'update', 'remove', 'set', 'delete', 'initdb', 'plans.submit', '', null, {}, ['workspace']]) {
    assert.equal((await handle({ action })).code, 'BAD_REQUEST');
  }
  assert.equal(accessed, false);
});

test('each allowed action rechecks teacher state and role', async () => {
  for (const change of [t => { t.isActive = false; }, t => { t.role = 'invalid'; }]) {
    const d = fixture(), s = setup(d); assert.equal((await s.handle(request)).code, 'OK');
    change(d.hw_teachers[0]);
    for (const event of [{ action: 'session' }, { action: 'classes' }, request]) {
      s.mock.reads.length = 0;
      assert.notEqual((await s.handle(event)).code, 'OK');
      assert.ok(!s.mock.reads.some(r => r.collection === 'hw_students' || r.collection === 'hw_daily_plans'));
    }
  }
});

test('extracted plan engine keeps homework-manager distribution, warnings and priority inputs', () => {
  assert.deepEqual(distributeIntegers(10, 3), [4, 3, 3]);
  const projection = buildProjection({ _id: 'student-a', speedCoefficient: 0.5 },
    [{ totalAmount: 100, completedAmount: 0, workloadPerUnit: 1 }],
    { termEndDate: '2026-09-15', workDays: [1, 2, 3, 4, 5], dailyCapacity: 40,
      minCompletionRate: 0.8, severeCompletionRate: 0.6 }, '2026-09-15');
  assert.equal(projection.projectedRate, 0.5);
  assert.equal(projection.color, 'red');
  assert.equal(projection.alerts[0].message, '预计仅完成 50%，强烈建议干预');
});

test('createBook uses mini-program fields and defaults without changing plans', async () => {
  const d = fixture(), s = setup(d), plansBefore = structuredClone(d.hw_daily_plans);
  const result = await s.handle({ action: 'createBook', studentId: 'student-a', name: '  新练习册  ', totalAmount: 20 });
  assert.equal(result.code, 'OK'); assert.equal(result.data.planGenerated, false);
  const book = d.hw_homework_books.find(row => row._id === result.data.id);
  assert.deepEqual({ studentId: book.studentId, classId: book.classId, name: book.name, subject: book.subject,
    totalAmount: book.totalAmount, workloadPerUnit: book.workloadPerUnit, unit: book.unit,
    completedAmount: book.completedAmount, isActive: book.isActive },
  { studentId: 'student-a', classId: 'class-a', name: '新练习册', subject: 'other', totalAmount: 20,
    workloadPerUnit: 5, unit: '页', completedAmount: 0, isActive: true });
  assert.deepEqual(d.hw_daily_plans, plansBefore);
  const decimal = await s.handle({ action: 'createBook', studentId: 'student-a', name: '负载测试', totalAmount: 2, workloadPerUnit: 1.5 });
  assert.equal(decimal.code, 'OK'); assert.equal(decimal.data.book.workloadPerUnit, 1.5);
});

test('createBook validates fields and student authorization before writing', async () => {
  for (const event of [
    { action: 'createBook', studentId: 'student-a', name: '', totalAmount: 10 },
    { action: 'createBook', studentId: 'student-a', name: '作业', totalAmount: 0 },
    { action: 'createBook', studentId: 'student-a', name: '作业', totalAmount: 1.5 },
    { action: 'createBook', studentId: 'missing', name: '作业', totalAmount: 10 }
  ]) {
    const s = setup(); assert.notEqual((await s.handle(event)).code, 'OK'); assert.equal(s.mock.writes, 0);
  }
  const d = fixture(); d.hw_students.push({ _id: 'student-c', classId: 'class-c', isActive: true });
  const s = setup(d); assert.equal((await s.handle({ action: 'createBook', studentId: 'student-c', name: '作业', totalAmount: 10 })).code, 'FORBIDDEN');
  assert.equal(s.mock.writes, 0);
});

test('generateTodayPlan creates only today with mini-program integer allocation and never rebuilds future plans', async () => {
  const d = fixture(); d.hw_daily_plans.push({ _id: 'future-b', studentId: 'student-b', classId: 'class-a',
    homeworkBookId: 'book-d', date: '2026-09-16', plannedAmount: 77, plannedWorkload: 154, isCompleted: false });
  const s = setup(d), result = await s.handle({ action: 'generateTodayPlan', studentId: 'student-b' });
  assert.equal(result.code, 'OK'); assert.equal(result.data.date, '2026-09-15'); assert.equal(result.data.plansGenerated, 1);
  const todayPlan = d.hw_daily_plans.find(row => row.studentId === 'student-b' && row.date === '2026-09-15');
  assert.equal(todayPlan.plannedAmount, distributeIntegers(99, 12)[0]);
  assert.equal(d.hw_daily_plans.find(row => row._id === 'future-b').plannedAmount, 77);
  const writes = s.mock.writes;
  assert.equal((await s.handle({ action: 'generateTodayPlan', studentId: 'student-b' })).code, 'PLAN_EXISTS');
  assert.equal(s.mock.writes, writes);
  assert.equal(d.hw_daily_plans.filter(row => row.studentId === 'student-b' && row.date === '2026-09-15').length, 1);
});

test('saveDailyRecord preserves zero, updates same record, syncs plan and book without duplicates', async () => {
  const d = fixture(), s = setup(d);
  let result = await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 0 });
  assert.equal(result.code, 'OK'); assert.equal(result.data.actualAmount, 0); assert.equal(result.data.status, 'partial'); assert.equal(result.data.updated, true);
  assert.equal(d.hw_daily_records.filter(row => row.studentId === 'student-a' && row.homeworkBookId === 'book-a' && row.date === '2026-09-15').length, 1);
  assert.equal(d.hw_daily_records.find(row => row._id === 'record-a').actualAmount, 0);
  assert.equal(d.hw_daily_plans.find(row => row._id === 'plan-a').isCompleted, false);
  assert.equal(d.hw_homework_books.find(row => row._id === 'book-a').completedAmount, 0);
  result = await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 4 });
  assert.equal(result.data.status, 'completed'); assert.equal(d.hw_daily_plans.find(row => row._id === 'plan-a').isCompleted, true);
  assert.equal(d.hw_homework_books.find(row => row._id === 'book-a').completedAmount, 4);
  assert.equal(d.hw_daily_records.filter(row => row.homeworkBookId === 'book-a').length, 1);
});

test('saveDailyRecord inserts one deterministic record then updates it on repeat', async () => {
  const d = fixture(); d.hw_daily_records = d.hw_daily_records.filter(row => row.homeworkBookId !== 'book-c');
  const s = setup(d), event = { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-c', date: '2026-09-15', actualAmount: 0 };
  let result = await s.handle(event); assert.equal(result.code, 'OK'); assert.equal(result.data.updated, false);
  let records = d.hw_daily_records.filter(row => row.studentId === 'student-a' && row.homeworkBookId === 'book-c' && row.date === '2026-09-15');
  assert.equal(records.length, 1); assert.equal(records[0].actualAmount, 0); const documentId = records[0]._id;
  result = await s.handle({ ...event, actualAmount: 2 }); assert.equal(result.code, 'OK'); assert.equal(result.data.updated, true);
  records = d.hw_daily_records.filter(row => row.studentId === 'student-a' && row.homeworkBookId === 'book-c' && row.date === '2026-09-15');
  assert.equal(records.length, 1); assert.equal(records[0]._id, documentId); assert.equal(records[0].actualAmount, 2);
});

test('repeated saves update completedAmount by new minus old without accumulating twice', async () => {
  for (const [oldActual, newActual] of [[5, 3], [5, 0], [0, 5]]) {
    const d = fixture();
    d.hw_daily_records.find(row => row._id === 'record-a').actualAmount = oldActual;
    d.hw_homework_books.find(row => row._id === 'book-a').completedAmount = oldActual;
    const s = setup(d);
    const result = await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: newActual });
    assert.equal(result.code, 'OK'); assert.equal(result.data.completedAmount, newActual);
    assert.equal(d.hw_homework_books.find(row => row._id === 'book-a').completedAmount, newActual);
    assert.equal(d.hw_daily_records.find(row => row._id === 'record-a').actualAmount, newActual);
    assert.equal(d.hw_daily_records.filter(row => row.homeworkBookId === 'book-a' && row.date === '2026-09-15').length, 1);
  }
});

test('concurrent duplicate record saves serialize and never double-count', async () => {
  const d = fixture(), s = setup(d);
  const event = { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 5 };
  const results = await Promise.all([s.handle(event), s.handle(event)]);
  assert.deepEqual(results.map(result => result.code), ['OK', 'OK']);
  assert.equal(d.hw_daily_records.filter(row => row.homeworkBookId === 'book-a' && row.date === '2026-09-15').length, 1);
  assert.equal(d.hw_daily_records.find(row => row._id === 'record-a').actualAmount, 5);
  assert.equal(d.hw_homework_books.find(row => row._id === 'book-a').completedAmount, 5);
  assert.equal(d.hw_daily_plans.find(row => row._id === 'plan-a').isCompleted, true);
});

test('record, plan and book updates commit together or all roll back', async () => {
  for (const failingCollection of ['hw_daily_records', 'hw_homework_books', 'hw_daily_plans']) {
    const d = fixture(), before = structuredClone(d), s = setup(d);
    s.mock.failWrite = ({ collection }) => collection === failingCollection;
    const result = await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 5 });
    assert.equal(result.code, 'UNAVAILABLE'); assert.deepEqual(d, before); assert.equal(s.mock.writes, 0);
  }
  const d = fixture(), s = setup(d);
  assert.equal((await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 5 })).code, 'OK');
  assert.deepEqual(s.mock.mutations.slice(-3).map(item => item.collection), ['hw_daily_records', 'hw_homework_books', 'hw_daily_plans']);
});

test('completedAmount stays within zero and totalAmount bounds', async () => {
  const over = fixture(); over.hw_homework_books.find(row => row._id === 'book-a').totalAmount = 4;
  let s = setup(over);
  assert.equal((await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 5 })).code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal(over.hw_homework_books.find(row => row._id === 'book-a').completedAmount, 2); assert.equal(s.mock.writes, 0);
  const below = fixture(); below.hw_daily_records.find(row => row._id === 'record-a').actualAmount = 5;
  below.hw_homework_books.find(row => row._id === 'book-a').completedAmount = 0; s = setup(below);
  assert.equal((await s.handle({ action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 0 })).code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal(below.hw_homework_books.find(row => row._id === 'book-a').completedAmount, 0); assert.equal(s.mock.writes, 0);
});

test('book total below completed amount is rejected before plan or record writes', async () => {
  for (const action of ['generate', 'save']) {
    const d = fixture(); const book = d.hw_homework_books.find(row => row._id === 'book-d');
    book.totalAmount = 3; book.completedAmount = 5; const s = setup(d);
    const event = action === 'generate' ? { action: 'generateTodayPlan', studentId: 'student-b' } :
      { action: 'saveDailyRecord', studentId: 'student-b', homeworkBookId: 'book-d', date: '2026-09-15', actualAmount: 1 };
    if (action === 'save') d.hw_daily_plans.push({ _id: 'plan-d', studentId: 'student-b', classId: 'class-a', homeworkBookId: 'book-d', date: '2026-09-15', plannedAmount: 1, isCompleted: false });
    assert.equal((await s.handle(event)).code, 'DATA_INVALID'); assert.equal(s.mock.writes, 0);
  }
});

test('concurrent today-plan generation succeeds exactly once', async () => {
  const d = fixture(), s = setup(d), event = { action: 'generateTodayPlan', studentId: 'student-b' };
  const results = await Promise.all([s.handle(event), s.handle(event)]);
  assert.deepEqual(results.map(result => result.code).sort(), ['OK', 'PLAN_EXISTS']);
  assert.equal(d.hw_daily_plans.filter(row => row.studentId === 'student-b' && row.date === '2026-09-15').length, 1);
});

test('today-plan generation with no remaining task performs no successful write', async () => {
  const d = fixture(); d.hw_homework_books.find(row => row._id === 'book-d').completedAmount = 100;
  const s = setup(d), result = await s.handle({ action: 'generateTodayPlan', studentId: 'student-b' });
  assert.equal(result.code, 'NO_TASKS'); assert.equal(s.mock.writes, 0);
  assert.equal(d.hw_daily_plans.some(row => row.studentId === 'student-b' && row.date === '2026-09-15'), false);
});

test('today uses Asia/Shanghai at the UTC day boundary', async () => {
  assert.equal(shanghaiDate(new Date('2026-09-18T15:59:59.999Z')), '2026-09-18');
  assert.equal(shanghaiDate(new Date('2026-09-18T16:00:00.000Z')), '2026-09-19');
  const d = fixture(); d.hw_settings[0].termEndDate = '2026-09-30';
  const mock = mockDatabase(d);
  const handle = createService({ repo: createRepository(mock.db), identity: async () => ({ uid: 'test-uid', isAnonymous: false }),
    environmentId: 'test-env', now: () => new Date('2026-09-18T16:00:00.000Z') });
  const result = await handle({ action: 'generateTodayPlan', studentId: 'student-b' });
  assert.equal(result.code, 'OK'); assert.equal(result.data.date, '2026-09-19');
  assert.ok(d.hw_daily_plans.every(row => row.studentId !== 'student-b' || row.date === '2026-09-19'));
  assert.equal((await handle({ action: 'saveDailyRecord', studentId: 'student-b', homeworkBookId: 'book-d', date: '2026-09-20', actualAmount: 1 })).code, 'FUTURE_DATE');
});

test('saveDailyRecord rejects future, missing-plan, cross-student and unauthorized writes', async () => {
  const cases = [
    { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-16', actualAmount: 1, code: 'FUTURE_DATE' },
    { action: 'saveDailyRecord', studentId: 'student-b', homeworkBookId: 'book-d', date: '2026-09-15', actualAmount: 1, code: 'PLAN_REQUIRED' },
    { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-d', date: '2026-09-15', actualAmount: 1, code: 'FORBIDDEN' }
  ];
  for (const { code, ...event } of cases) {
    const s = setup(); assert.equal((await s.handle(event)).code, code); assert.equal(s.mock.writes, 0);
  }
  const d = fixture(); d.hw_students.push({ _id: 'student-c', classId: 'class-c', isActive: true });
  d.hw_homework_books.push({ _id: 'book-c', studentId: 'student-c', classId: 'class-c', isActive: true });
  const s = setup(d); assert.equal((await s.handle({ action: 'saveDailyRecord', studentId: 'student-c', homeworkBookId: 'book-c', date: '2026-09-15', actualAmount: 1 })).code, 'FORBIDDEN');
  assert.equal(s.mock.writes, 0);
});

test('write actions recheck teacher status and reject browser-supplied authority fields', async () => {
  for (const event of [
    { action: 'createBook', studentId: 'student-a', name: '作业', totalAmount: 10, role: 'boss' },
    { action: 'generateTodayPlan', studentId: 'student-b', teacherId: 'teacher-a' },
    { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 1, collection: 'hw_daily_records' }
  ]) assert.equal((await setup().handle(event)).code, 'BAD_REQUEST');
  for (const action of [
    { action: 'createBook', studentId: 'student-a', name: '作业', totalAmount: 10 },
    { action: 'generateTodayPlan', studentId: 'student-b' },
    { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 1 }
  ]) {
    const d = fixture(); d.hw_teachers[0].isActive = false; const s = setup(d);
    assert.equal((await s.handle(action)).code, 'TEACHER_DISABLED'); assert.equal(s.mock.writes, 0);
  }
});

test('students lists only authorized classes with server-side class and name filters', async () => {
  const d = fixture();
  d.hw_students[1].isActive = false;
  delete d.hw_students[1].speedLevel; delete d.hw_students[1].speedCoefficient;
  d.hw_students.push({ _id: 'student-c', name: '不可见学生', grade: '三年级', classId: 'class-c', speedLevel: 'fast', speedCoefficient: 1.3, isActive: true });
  d.hw_homework_books.push({ _id: 'book-extra', studentId: 'student-a', isActive: false });
  d.hw_daily_plans.push({ _id: 'future-a', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-16' });
  const s = setup(d);
  let result = await s.handle({ action: 'students' });
  assert.equal(result.code, 'OK'); assert.deepEqual(result.data.classes.map(cls => cls.id), ['class-a', 'class-b']);
  assert.deepEqual(result.data.students.map(student => student.id), ['student-a', 'student-b']);
  assert.equal(result.data.students[0].bookCount, 4); assert.equal(result.data.students[0].hasCurrentOrFuturePlan, true);
  assert.equal(result.data.students[1].isActive, false); assert.equal(result.data.students[1].speedLevel, 'normal');
  assert.equal(result.data.students[1].speedCoefficient, 1); assert.equal(d.hw_students[1].speedLevel, undefined);
  result = await s.handle({ action: 'students', classId: 'class-a', query: '学生乙' });
  assert.deepEqual(result.data.students.map(student => student.id), ['student-b']);
  assert.equal((await s.handle({ action: 'students', classId: 'class-c', query: '' })).code, 'FORBIDDEN');
  assert.equal((await s.handle({ action: 'students', query: { $ne: '' } })).code, 'BAD_REQUEST');
  assert.equal(s.mock.writes, 0);
});

test('createStudent uses mini-program speed defaults and audit fields', async () => {
  const d = fixture(), s = setup(d);
  let result = await s.handle({ action: 'createStudent', name: '  新学生  ', grade: ' 二年级 ', classId: 'class-a' });
  assert.equal(result.code, 'OK');
  let student = d.hw_students.find(row => row._id === result.data.id);
  assert.deepEqual({ name: student.name, grade: student.grade, classId: student.classId, speedLevel: student.speedLevel,
    speedCoefficient: student.speedCoefficient, isActive: student.isActive, operatorTeacherId: student.operatorTeacherId },
  { name: '新学生', grade: '二年级', classId: 'class-a', speedLevel: 'normal', speedCoefficient: 1,
    isActive: true, operatorTeacherId: 'teacher-a' });
  assert.ok(student.createdAt instanceof Date); assert.ok(student.updatedAt instanceof Date);
  result = await s.handle({ action: 'createStudent', name: '偏快学生', grade: '三年级', classId: 'class-b', speedLevel: 'fast' });
  student = d.hw_students.find(row => row._id === result.data.id); assert.equal(student.speedCoefficient, 1.3);
});

test('createStudent rejects invalid fields, unavailable classes and unauthorized classes', async () => {
  for (const event of [
    { action: 'createStudent', name: '', grade: '二年级', classId: 'class-a' },
    { action: 'createStudent', name: '学生', grade: '', classId: 'class-a' },
    { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a', speedLevel: 'rapid' },
    { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-c' },
    { action: 'createStudent', name: '学生', grade: '二年级', classId: { $ne: '' } }
  ]) {
    const s = setup(); assert.notEqual((await s.handle(event)).code, 'OK'); assert.equal(s.mock.writes, 0);
  }
  const inactive = fixture(); inactive.hw_classes[0].isActive = false; const blocked = setup(inactive);
  assert.equal((await blocked.handle({ action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a' })).code, 'FORBIDDEN');
  assert.equal(blocked.mock.writes, 0);
  const bossData = fixture(); bossData.hw_teachers[0].role = 'boss'; const boss = setup(bossData);
  assert.equal((await boss.handle({ action: 'createStudent', name: '管理员学生', grade: '一年级', classId: 'class-c' })).code, 'OK');
});

test('updateStudent edits allowed fields and derives speed coefficient', async () => {
  const d = fixture(), s = setup(d);
  const result = await s.handle({ action: 'updateStudent', studentId: 'student-a', name: ' 更新姓名 ', grade: '四年级', speedLevel: 'fast' });
  assert.equal(result.code, 'OK');
  const student = d.hw_students.find(row => row._id === 'student-a');
  assert.equal(student.name, '更新姓名'); assert.equal(student.grade, '四年级');
  assert.equal(student.speedLevel, 'fast'); assert.equal(student.speedCoefficient, 1.3);
  assert.equal(student.operatorTeacherId, 'teacher-a'); assert.ok(student.updatedAt instanceof Date);
  assert.equal((await s.handle({ action: 'updateStudent', studentId: 'student-a' })).code, 'BAD_REQUEST');
  assert.equal((await s.handle({ action: 'updateStudent', studentId: 'student-a', speedLevel: 'invalid' })).code, 'BAD_REQUEST');
});

test('missing legacy speed fields are read-only defaults until an explicit edit saves them', async () => {
  const d = fixture(), student = d.hw_students.find(row => row._id === 'student-b');
  delete student.speedLevel; delete student.speedCoefficient;
  const s = setup(d), listed = await s.handle({ action: 'students', classId: 'class-a', query: '学生乙' });
  assert.equal(listed.code, 'OK'); assert.equal(listed.data.students[0].speedLevel, 'normal');
  assert.equal(listed.data.students[0].speedCoefficient, 1); assert.equal(student.speedLevel, undefined); assert.equal(s.mock.writes, 0);
  const saved = await s.handle({ action: 'updateStudent', studentId: 'student-b', name: student.name,
    grade: student.grade, classId: student.classId, speedLevel: listed.data.students[0].speedLevel });
  assert.equal(saved.code, 'OK'); assert.equal(student.speedLevel, 'normal'); assert.equal(student.speedCoefficient, 1);
});

test('class changes require both permissions and are blocked by today or future plans', async () => {
  const blocked = setup();
  assert.equal((await blocked.handle({ action: 'updateStudent', studentId: 'student-a', classId: 'class-b' })).code, 'CLASS_CHANGE_BLOCKED');
  assert.equal(blocked.data.hw_students.find(row => row._id === 'student-a').classId, 'class-a'); assert.equal(blocked.mock.writes, 0);
  const futureData = fixture(); futureData.hw_daily_plans = [{ _id: 'future', studentId: 'student-b', date: '2026-09-16' }];
  const future = setup(futureData);
  assert.equal((await future.handle({ action: 'updateStudent', studentId: 'student-b', classId: 'class-b' })).code, 'CLASS_CHANGE_BLOCKED');
  assert.equal(future.mock.writes, 0);
  const allowedData = fixture(); allowedData.hw_daily_plans = allowedData.hw_daily_plans.filter(plan => plan.studentId !== 'student-a');
  const allowed = setup(allowedData);
  assert.equal((await allowed.handle({ action: 'updateStudent', studentId: 'student-a', classId: 'class-b' })).code, 'OK');
  assert.equal(allowedData.hw_students.find(row => row._id === 'student-a').classId, 'class-b');
  const unauthorizedData = fixture(); unauthorizedData.hw_daily_plans = []; const unauthorized = setup(unauthorizedData);
  assert.equal((await unauthorized.handle({ action: 'updateStudent', studentId: 'student-a', classId: 'class-c' })).code, 'FORBIDDEN');
  unauthorizedData.hw_students.push({ _id: 'student-c', name: '越权', grade: '一年级', classId: 'class-c', isActive: true });
  assert.equal((await unauthorized.handle({ action: 'updateStudent', studentId: 'student-c', name: '不能改' })).code, 'FORBIDDEN');
});

test('setStudentActive only toggles state, preserves history and gates homework writes', async () => {
  const d = fixture(), history = {
    books: structuredClone(d.hw_homework_books), plans: structuredClone(d.hw_daily_plans), records: structuredClone(d.hw_daily_records)
  }, s = setup(d);
  let result = await s.handle({ action: 'setStudentActive', studentId: 'student-a', isActive: false });
  assert.equal(result.code, 'OK'); assert.equal(result.data.historyPreserved, true);
  assert.equal(d.hw_students.find(row => row._id === 'student-a').isActive, false);
  assert.deepEqual(d.hw_homework_books, history.books); assert.deepEqual(d.hw_daily_plans, history.plans); assert.deepEqual(d.hw_daily_records, history.records);
  for (const event of [
    { action: 'createBook', studentId: 'student-a', name: '禁止新增', totalAmount: 10 },
    { action: 'generateTodayPlan', studentId: 'student-a' },
    { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 1 }
  ]) assert.equal((await s.handle(event)).code, 'NOT_FOUND');
  result = await s.handle({ action: 'setStudentActive', studentId: 'student-a', isActive: true });
  assert.equal(result.code, 'OK'); assert.equal(d.hw_students.find(row => row._id === 'student-a').isActive, true);
  assert.equal((await s.handle({ action: 'createBook', studentId: 'student-a', name: '重新启用后可新增', totalAmount: 1 })).code, 'OK');
  assert.equal((await s.handle({ action: 'setStudentActive', studentId: 'student-a', isActive: 'false' })).code, 'BAD_REQUEST');
  assert.equal((await s.handle({ action: 'deleteStudent', studentId: 'student-a' })).code, 'BAD_REQUEST');
});

test('student mutations roll back on storage failure', async () => {
  for (const event of [
    { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a' },
    { action: 'updateStudent', studentId: 'student-a', name: '新姓名' },
    { action: 'setStudentActive', studentId: 'student-a', isActive: false }
  ]) {
    const d = fixture(), before = structuredClone(d), s = setup(d);
    s.mock.failWrite = ({ collection }) => collection === 'hw_students';
    assert.equal((await s.handle(event)).code, 'UNAVAILABLE'); assert.deepEqual(d, before); assert.equal(s.mock.writes, 0);
  }
});

test('student actions recheck teacher state, role and browser-supplied fields', async () => {
  const events = [
    { action: 'students' },
    { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a' },
    { action: 'updateStudent', studentId: 'student-a', name: '学生' },
    { action: 'setStudentActive', studentId: 'student-a', isActive: false }
  ];
  for (const mutate of [teacher => { teacher.isActive = false; }, teacher => { teacher.role = 'invalid'; }]) {
    for (const event of events) {
      const d = fixture(), s = setup(d); mutate(d.hw_teachers[0]);
      assert.notEqual((await s.handle(event)).code, 'OK'); assert.equal(s.mock.writes, 0);
    }
  }
  for (const event of [
    { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a', isActive: true },
    { action: 'updateStudent', studentId: 'student-a', operatorTeacherId: 'fake' },
    { action: 'setStudentActive', studentId: 'student-a', isActive: false, collection: 'hw_students' }
  ]) assert.equal((await setup().handle(event)).code, 'BAD_REQUEST');
});
