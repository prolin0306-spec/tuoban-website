'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHomeworkAPI } = require('../admin/js/homework-api');
const config = { envId: 'test-env', functionName: 'webHomework', enabled: true };
function sdk({ state = {}, result = { code: 'OK', data: {} }, error } = {}) {
  const calls = [], auth = { getLoginState: async () => state,
    signInWithUsernameAndPassword: async () => {}, signOut: async () => calls.push('signOut'), onLoginStateExpired() {} };
  return { calls, auth, init() { return { auth: () => auth, callFunction: async arg => {
    calls.push(arg); if (error) throw error; return { result };
  } }; } };
}
function modernSdk({ session = { data: { session: { sub: 'test-uid' } } }, result = { code: 'OK', data: {} } } = {}) {
  const calls = [], auth = {
    getSession: async () => session,
    signInWithPassword: async args => { calls.push({ login: { username: args.username, passwordPresent: !!args.password } }); return { data: {} }; },
    signOut: async () => { calls.push('signOut'); return { data: {} }; }
  };
  return { calls, auth, init(options) { calls.push({ init: options }); return { auth, callFunction: async arg => { calls.push(arg); return { result }; } }; } };
}
test('unconfigured/unavailable backend never returns mock data', async () => {
  await assert.rejects(createHomeworkAPI({}, sdk()).classes(), { code: 'NOT_CONFIGURED' });
  await assert.rejects(createHomeworkAPI(config, sdk({ error: new Error('network') })).classes(), { code: 'UNAVAILABLE' });
  await assert.rejects(createHomeworkAPI(config, sdk({ result: null })).classes(), { code: 'UNAVAILABLE' });
});
test('anonymous, missing and expired platform sessions are rejected', async () => {
  for (const state of [null, { isAnonymousAuth: true }, { loginType: 'ANONYMOUS' }]) {
    const s = sdk({ state }); await assert.rejects(createHomeworkAPI(config, s).session(), { code: 'AUTH_REQUIRED' }); assert.deepEqual(s.calls, []);
  }
  await assert.rejects(createHomeworkAPI(config, sdk({ error: { code: 'ACCESS_TOKEN_EXPIRED' } })).classes(), { code: 'AUTH_REQUIRED' });
});
test('function and actions are fixed; no teacher identity or collection forwarded', async () => {
  const s = sdk(), a = createHomeworkAPI(config, s);
  await a.session(); await a.classes(); await a.workspace('class-a', '2026-09-15');
  await a.students({ classId: 'class-a', query: '甲' });
  await a.createStudent({ name: '学生', grade: '二年级', classId: 'class-a' });
  await a.updateStudent({ studentId: 'student-a', name: '新姓名' });
  await a.setStudentActive('student-a', false);
  await a.createBook({ studentId: 'student-a', name: '练习册', totalAmount: 10 });
  await a.generateTodayPlan('student-a');
  await a.saveDailyRecord({ studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 0 });
  assert.deepEqual(s.calls, [
    { name: 'webHomework', data: { action: 'session' } },
    { name: 'webHomework', data: { action: 'classes' } },
    { name: 'webHomework', data: { action: 'workspace', classId: 'class-a', date: '2026-09-15' } },
    { name: 'webHomework', data: { action: 'students', classId: 'class-a', query: '甲' } },
    { name: 'webHomework', data: { action: 'createStudent', name: '学生', grade: '二年级', classId: 'class-a' } },
    { name: 'webHomework', data: { action: 'updateStudent', studentId: 'student-a', name: '新姓名' } },
    { name: 'webHomework', data: { action: 'setStudentActive', studentId: 'student-a', isActive: false } },
    { name: 'webHomework', data: { action: 'createBook', studentId: 'student-a', name: '练习册', totalAmount: 10 } },
    { name: 'webHomework', data: { action: 'generateTodayPlan', studentId: 'student-a' } },
    { name: 'webHomework', data: { action: 'saveDailyRecord', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 0 } }
  ]);
  assert.equal(a.invoke, undefined); assert.equal(a.submit, undefined); assert.equal(a.deleteBook, undefined); assert.equal(a.deleteStudent, undefined);
});
test('login uses platform auth and logout uses SDK signOut', async () => {
  const s = sdk(); let loginCalled = false;
  s.auth.signInWithUsernameAndPassword = async () => { loginCalled = true; };
  const a = createHomeworkAPI(config, s); await a.login('test-only', 'fictional-test-value'); await a.logout();
  assert.equal(loginCalled, true); assert.equal(s.calls.at(-1), 'signOut');
});
test('modern SDK uses v3 password and session APIs without forwarding identity', async () => {
  const s = modernSdk(), a = createHomeworkAPI(config, s);
  await a.login(' test-user ', 'fictional-test-value'); await a.workspace('class-a', '2026-09-18'); await a.logout();
  assert.deepEqual(s.calls, [
    { init: { env: 'test-env', region: 'ap-shanghai' } },
    { login: { username: 'test-user', passwordPresent: true } },
    { name: 'webHomework', data: { action: 'session' } },
    { name: 'webHomework', data: { action: 'workspace', classId: 'class-a', date: '2026-09-18' } },
    'signOut'
  ]);
  await assert.rejects(createHomeworkAPI(config, modernSdk({ session: { data: { session: null } } })).classes(), { code: 'AUTH_REQUIRED' });
});
test('backend refusals and raw error messages do not leak data', async () => {
  for (const code of ['TEACHER_DISABLED', 'TEACHER_UNLINKED', 'FORBIDDEN']) {
    await assert.rejects(createHomeworkAPI(config, sdk({ result: { code, message: 'sensitive-value' } })).classes(), e => e.code === code && !e.message.includes('sensitive-value'));
  }
});
