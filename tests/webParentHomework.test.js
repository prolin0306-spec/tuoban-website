'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, shanghaiToday } = require('../cloudfunctions/webParentHomework/service');
const { createRepository } = require('../cloudfunctions/webParentHomework/repository');
const { fixture, mockDatabase } = require('./helpers/homework-fixture');

function setup() {
  const data = fixture(), mock = mockDatabase(data);
  const handle = createService({ repo: createRepository(mock.db), identity: async () => ({ uid: 'anonymous-parent' }),
    now: () => new Date('2026-09-15T16:30:00Z') });
  return { data, mock, handle };
}
const request = { action: 'summary', childId: 'feedback-child-a', phone: '13800000001' };

test('parent summary reads only explicitly linked child and keeps zero distinct from missing record', async () => {
  const { data, mock, handle } = setup();
  data.hw_students[0].feedbackChildId = 'feedback-child-a';
  const result = await handle(request);
  assert.equal(result.code, 'OK');
  assert.equal(result.data.date, '2026-09-16');
  assert.equal(result.data.books.length, 3);
  assert.equal(result.data.books[0].todayPlannedAmount, null);
  assert.equal(result.data.books[0].todayActualAmount, null);
  assert.equal(JSON.stringify(result).includes('student-a'), false);
  assert.equal(JSON.stringify(result).includes('13800000001'), false);
  assert.equal(mock.writes, 0);
});

test('daily plan and actual are for Shanghai date; recorded zero is preserved', async () => {
  const { data, handle } = setup();
  data.hw_students[0].feedbackChildId = 'feedback-child-a';
  data.hw_daily_plans[0].date = '2026-09-16';
  data.hw_daily_records[0].date = '2026-09-16';
  data.hw_daily_records[0].actualAmount = 0;
  const result = await handle(request);
  assert.equal(result.data.books[0].todayPlannedAmount, 4);
  assert.equal(result.data.books[0].todayActualAmount, 0);
  assert.equal(result.data.books[1].todayActualAmount, null);
});

test('wrong phone, wrong child and unrelated students never disclose books', async () => {
  const { data, handle } = setup();
  data.hw_students[0].feedbackChildId = 'feedback-child-a';
  assert.equal((await handle({ ...request, phone: '13800000002' })).code, 'NOT_FOUND');
  assert.equal((await handle({ ...request, childId: 'feedback-child-b' })).code, 'NOT_FOUND');
  assert.equal((await handle({ ...request, action: 'createBook' })).code, 'BAD_REQUEST');
  assert.equal((await handle({ ...request, studentId: 'student-a' })).code, 'BAD_REQUEST');
});

test('missing and duplicate mappings fail closed without name matching', async () => {
  const { data, handle } = setup();
  assert.deepEqual((await handle(request)).data.books, []);
  assert.equal((await handle(request)).data.linked, false);
  data.hw_students[0].feedbackChildId = 'feedback-child-a';
  data.hw_students[1].feedbackChildId = 'feedback-child-a';
  assert.equal((await handle(request)).code, 'DATA_CONFLICT');
});

test('identity is required; Shanghai date uses China day boundary', async () => {
  const { data, mock } = setup();
  data.hw_students[0].feedbackChildId = 'feedback-child-a';
  const handle = createService({ repo: createRepository(mock.db), identity: async () => null });
  assert.equal((await handle(request)).code, 'AUTH_REQUIRED');
  assert.equal(shanghaiToday(new Date('2026-09-15T15:59:59Z')), '2026-09-15');
  assert.equal(shanghaiToday(new Date('2026-09-15T16:00:00Z')), '2026-09-16');
});
