'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/webHomework/service');
const { createRepository } = require('../cloudfunctions/webHomework/repository');
const { project, risk, validDate, calcPriorityScore } = require('../cloudfunctions/webHomework/projection');
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
  for (const e of [{ action: 'session' }, { action: 'classes' }, request]) assert.equal((await s.handle(e)).code, 'OK');
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
