'use strict';
const crypto = require('node:crypto');
const { AppError, fail } = require('./errors');
const { project, validDate, shanghaiDate, numeric, compareStudents } = require('./projection');
const { countWorkdays, distributeIntegers, safeNumber, safeInt } = require('./plan-engine');
const ROLES = new Set(['boss', 'teacher', 'substituteTeacher']);
const ACTION_KEYS = Object.freeze({
  session: ['action'], classes: ['action'], workspace: ['action', 'classId', 'date'],
  createBook: ['action', 'studentId', 'name', 'subject', 'totalAmount', 'workloadPerUnit', 'unit'],
  generateTodayPlan: ['action', 'studentId'],
  saveDailyRecord: ['action', 'studentId', 'homeworkBookId', 'date', 'actualAmount']
});
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function text(value, name, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('BAD_REQUEST', `${name}无效`);
  return value.trim();
}
function positive(value, name, fallback) {
  const input = value === undefined ? fallback : value;
  const number = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number) || number > 1000000) fail('BAD_REQUEST', `${name}必须是有效正整数`);
  return number;
}
function positiveNumber(value, name, fallback) {
  const input = value === undefined ? fallback : value;
  const number = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(number) || number <= 0 || number > 1000000) fail('BAD_REQUEST', `${name}必须是有效正数`);
  return number;
}
function normalizeActual(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000) fail('BAD_REQUEST', '实际完成量必须是大于等于 0 的数字');
  return safeInt(number);
}
function stableId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 48)}`;
}
function createService({ repo, identity, environmentId, now = () => new Date() }) {
  async function authorize(source = repo) {
    const caller = await identity();
    if (!caller || !id(caller.uid) || caller.isAnonymous !== false) fail('AUTH_REQUIRED', '请登录作业访问账号');
    const links = await source.list('integration_teacher_links', { authUid: caller.uid, authEnvId: environmentId });
    if (links.length !== 1 || links[0].status !== 'active') fail('TEACHER_UNLINKED', '账号尚未关联作业老师或关联已停用，请联系管理员');
    const link = links[0];
    if (link.homeworkEnvId !== environmentId || !id(link.homeworkTeacherId)) fail('TEACHER_UNLINKED', '老师关联环境不匹配');
    const teachers = await source.list('hw_teachers', { _id: link.homeworkTeacherId });
    if (teachers.length !== 1 || teachers[0].isActive !== true) fail('TEACHER_DISABLED', '作业老师未启用，请联系管理员');
    const teacher = teachers[0];
    if (!ROLES.has(teacher.role)) fail('FORBIDDEN', '账号没有作业操作权限');
    const all = await source.list('hw_classes');
    const own = Array.isArray(teacher.classIds) ? teacher.classIds.filter(id) : [];
    const classes = all.filter(cls => cls.isActive !== false && (teacher.role === 'boss' ||
      own.includes(cls._id) || cls.substituteTeacherId === teacher._id));
    return { teacher, classes };
  }
  async function resolveStudent(studentId, auth, source = repo) {
    if (!id(studentId)) fail('BAD_REQUEST', '学生无效');
    const students = await source.list('hw_students', { _id: studentId });
    if (students.length !== 1 || students[0].isActive !== true) fail('NOT_FOUND', '学生不存在或已停用');
    const student = students[0];
    if (!auth.classes.some(cls => cls._id === student.classId)) fail('FORBIDDEN', '无权操作该学生');
    return student;
  }
  async function workspace(classId, date, auth) {
    const cls = auth.classes.find(item => item._id === classId);
    if (!cls) fail('FORBIDDEN', '无权查看该班级');
    const students = await repo.list('hw_students', { classId, isActive: true });
    const settingsRows = await repo.list('hw_settings', { _id: 'global' });
    const cards = [];
    let totalPlannedWorkload = 0, totalCompletedWorkload = 0;
    for (const student of students) {
      const [books, plans, records] = await Promise.all([
        repo.list('hw_homework_books', { studentId: student._id }),
        repo.list('hw_daily_plans', { studentId: student._id, date }),
        repo.list('hw_daily_records', { studentId: student._id, date })
      ]);
      const bookMap = new Map(books.map(book => [book._id, book]));
      const keys = [...new Set([...plans, ...records].map(row => row.homeworkBookId))];
      const tasks = keys.map(bookId => {
        const book = bookMap.get(bookId);
        const matchingPlans = plans.filter(plan => plan.homeworkBookId === bookId);
        const matchingRecords = records.filter(record => record.homeworkBookId === bookId);
        const conflict = matchingPlans.length > 1 || matchingRecords.length > 1;
        const plan = matchingPlans.length === 1 ? matchingPlans[0] : null;
        const record = matchingRecords.length === 1 ? matchingRecords[0] : null;
        const amount = value => numeric(value) && value >= 0 ? value : null;
        const planned = plan ? amount(plan.plannedAmount) : null;
        const actual = !conflict && record ? amount(record.actualAmount) : null;
        const unitWorkload = book && numeric(book.workloadPerUnit) && book.workloadPerUnit > 0 ? book.workloadPerUnit : null;
        const status = conflict ? 'conflict' : !record ? 'unrecorded' : actual === null ? 'invalid' :
          actual === 0 ? 'zero' : planned === null ? 'recorded' : actual >= planned ? 'completed' : 'partial';
        return { homeworkBookId: bookId || null, bookName: book ? book.name : '作业本信息缺失',
          subject: book ? book.subject || 'other' : 'other', unit: book ? book.unit || '' : '',
          planned, plannedWorkload: plan && numeric(plan.plannedWorkload) ? plan.plannedWorkload :
            planned !== null && unitWorkload !== null ? planned * unitWorkload : null,
          actual, status, hasPlan: !!plan, planCompleted: plan ? plan.isCompleted === true : false,
          unitWorkload, warning: conflict ? '存在重复计划或记录，请管理员核对' : !book ? '关联的作业本信息缺失' : null };
      });
      let plannedWorkload = 0, completedWorkload = 0, actualWorkload = 0, incompleteRecords = false;
      for (const task of tasks.filter(task => task.hasPlan)) {
        if (!numeric(task.plannedWorkload)) continue;
        plannedWorkload += task.plannedWorkload;
        if (task.planCompleted) completedWorkload += task.plannedWorkload;
        if (task.actual === null || task.unitWorkload === null || task.status === 'conflict') incompleteRecords = true;
        else actualWorkload += task.actual * task.unitWorkload;
      }
      totalPlannedWorkload += plannedWorkload; totalCompletedWorkload += completedWorkload;
      const completionRate = plannedWorkload > 0 ? completedWorkload / plannedWorkload : 0;
      const actualRate = !incompleteRecords && plannedWorkload > 0 ? actualWorkload / plannedWorkload : null;
      const projection = project(student, books.filter(book => book.isActive === true), settingsRows[0], date, shanghaiDate(now()));
      const actualRateReason = !plans.length ? '尚未生成计划' : !records.length ? '未记录' :
        tasks.some(task => task.hasPlan && task.status === 'unrecorded') ? '部分任务未记录，无法计算完整完成率' : '计划、实际记录或单位负载不足，无法计算';
      cards.push({ id: student._id, name: student.name || '', grade: student.grade || '',
        speedLevel: student.speedLevel || '', tasks, hasPlan: plans.length > 0, completionRate,
        actualRate, actualRateReason: actualRate === null ? actualRateReason : null,
        projection, priorityScore: projection.priorityScore });
    }
    cards.sort(compareStudents);
    return { date, today: shanghaiDate(now()), classId, className: cls.name || '', students: cards,
      summary: { studentCount: cards.length, taskCount: cards.reduce((count, card) => count + card.tasks.length, 0),
        recordedTaskCount: cards.reduce((count, card) => count + card.tasks.filter(task => task.actual !== null).length, 0),
        overallProgress: totalPlannedWorkload > 0 ? Math.round(totalCompletedWorkload / totalPlannedWorkload * 100) : 0 } };
  }
  async function createBook(event, auth) {
    const name = text(event.name, '作业本名称', 100);
    const subject = text(event.subject, '科目', 32, 'other');
    const unit = text(event.unit, '单位', 16, '页');
    const totalAmount = positive(event.totalAmount, '总量');
    const workloadPerUnit = positiveNumber(event.workloadPerUnit, '单位负载', 5);
    const createdAt = now();
    return repo.runTransaction(async transaction => {
      const student = await resolveStudent(event.studentId, auth, transaction);
      const book = { studentId: student._id, classId: student.classId, subject, name, totalAmount,
        workloadPerUnit, unit, completedAmount: 0, isActive: true, createdAt, updatedAt: createdAt };
      const bookId = await transaction.add('hw_homework_books', book);
      return { id: bookId, book: { ...book, _id: bookId }, planGenerated: false };
    });
  }
  async function generateTodayPlan(event, auth) {
    const date = shanghaiDate(now());
    return repo.runTransaction(async transaction => {
      const student = await resolveStudent(event.studentId, auth, transaction);
      const existing = await transaction.list('hw_daily_plans', { studentId: student._id, date });
      if (existing.length) fail('PLAN_EXISTS', '当天已有计划，不能重复生成');
      const settingsRows = await transaction.list('hw_settings', { _id: 'global' });
      if (settingsRows.length !== 1 || !validDate(settingsRows[0].termEndDate)) fail('NOT_CONFIGURED', '学期配置未初始化');
      const settings = settingsRows[0];
      const remainingDays = countWorkdays(date, settings.termEndDate, settings);
      if (remainingDays <= 0) fail('NO_WORKDAYS', '已无剩余工作日，无法生成计划');
      const books = await transaction.list('hw_homework_books', { studentId: student._id, isActive: true });
      const plans = [];
      for (const book of books) {
        const totalAmount = Number(book.totalAmount), completedAmount = Number(book.completedAmount);
        if (!Number.isFinite(totalAmount) || !Number.isFinite(completedAmount) || totalAmount < 0 ||
            completedAmount < 0 || completedAmount > totalAmount) fail('DATA_INVALID', '作业本总量或已完成量无效');
        const remaining = totalAmount - completedAmount;
        const plannedAmount = safeInt(distributeIntegers(remaining, remainingDays)[0]);
        if (plannedAmount <= 0) continue;
        const plan = { studentId: student._id, classId: student.classId, homeworkBookId: book._id,
          date, plannedAmount, plannedWorkload: plannedAmount * safeNumber(book.workloadPerUnit, 1),
          isCompleted: false, createdAt: now() };
        plans.push({ id: stableId('webplan', student._id, book._id, date), data: plan });
      }
      if (!plans.length) fail('NO_TASKS', '没有可生成的剩余作业');
      for (const plan of plans) await transaction.set('hw_daily_plans', plan.id, plan.data);
      return { date, plansGenerated: plans.length, plans: plans.map(plan => ({ homeworkBookId: plan.data.homeworkBookId,
        plannedAmount: plan.data.plannedAmount, plannedWorkload: plan.data.plannedWorkload })) };
    });
  }
  async function saveDailyRecord(event, auth) {
    if (!validDate(event.date)) fail('BAD_REQUEST', '日期无效');
    const today = shanghaiDate(now());
    if (event.date > today) fail('FUTURE_DATE', '不能录入未来日期');
    const actual = normalizeActual(event.actualAmount);
    return repo.runTransaction(async transaction => {
      const student = await resolveStudent(event.studentId, auth, transaction);
      if (!id(event.homeworkBookId)) fail('BAD_REQUEST', '作业本无效');
      const books = await transaction.list('hw_homework_books', { _id: event.homeworkBookId });
      if (books.length !== 1 || books[0].isActive !== true || books[0].studentId !== student._id) fail('FORBIDDEN', '作业本不属于该学生或已停用');
      const plans = await transaction.list('hw_daily_plans', { studentId: student._id, homeworkBookId: event.homeworkBookId, date: event.date });
      if (plans.length !== 1) fail(plans.length ? 'DATA_CHANGED' : 'PLAN_REQUIRED', plans.length ? '当天存在重复计划，请先核对数据' : '当天没有该作业计划，不能录入');
      const book = books[0];
      const totalAmount = Number(book.totalAmount), currentCompleted = Number(book.completedAmount);
      if (!Number.isFinite(totalAmount) || !Number.isFinite(currentCompleted) || totalAmount < 0 ||
          currentCompleted < 0 || currentCompleted > totalAmount) fail('DATA_INVALID', '作业本总量或已完成量无效');
      const records = await transaction.list('hw_daily_records', { studentId: student._id, homeworkBookId: event.homeworkBookId, date: event.date });
      if (records.length > 1) fail('DATA_CHANGED', '当天存在重复记录，请先核对数据');
      const plan = plans[0], status = actual >= safeInt(plan.plannedAmount) ? 'completed' : 'partial';
      const previousActual = records.length === 1 ? safeInt(records[0].actualAmount) : 0;
      const completedAmount = currentCompleted + actual - previousActual;
      if (!Number.isFinite(completedAmount) || completedAmount < 0 || completedAmount > totalAmount) {
        fail('AMOUNT_OUT_OF_RANGE', '保存后总完成量将超出作业本总量范围');
      }
      const timestamp = now();
      const base = { studentId: student._id, classId: student.classId, homeworkBookId: event.homeworkBookId,
        date: event.date, plannedAmount: safeInt(plan.plannedAmount), actualAmount: actual, status,
        note: '', recordedBy: auth.teacher._id, idempotencyKey: '', updatedAt: timestamp };
      if (records.length === 1) await transaction.update('hw_daily_records', records[0]._id, base);
      else await transaction.set('hw_daily_records', stableId('webrecord', student._id, event.homeworkBookId, event.date), { ...base, createdAt: timestamp });
      await transaction.update('hw_homework_books', event.homeworkBookId, { completedAmount, updatedAt: timestamp });
      await transaction.update('hw_daily_plans', plan._id, { isCompleted: status === 'completed' });
      return { studentId: student._id, homeworkBookId: event.homeworkBookId, date: event.date,
        actualAmount: actual, plannedAmount: safeInt(plan.plannedAmount), status, completedAmount,
        updated: records.length === 1 };
    });
  }
  return async function handle(event) {
    try {
      if (!environmentId) fail('NOT_CONFIGURED', '后端环境尚未配置');
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.action !== 'string' || !Object.hasOwn(ACTION_KEYS, event.action)) fail('BAD_REQUEST', '不支持的操作');
      if (Object.hasOwn(event, 'tcbContext') && (!event.tcbContext || typeof event.tcbContext !== 'object' || Array.isArray(event.tcbContext))) fail('BAD_REQUEST', '请求格式错误');
      if (Object.keys(event).some(key => !['userInfo', 'tcbContext', ...ACTION_KEYS[event.action]].includes(key))) fail('BAD_REQUEST', '请求包含不支持的字段');
      const auth = await authorize();
      let data;
      if (event.action === 'session') data = { teacher: { id: auth.teacher._id, name: auth.teacher.name || '', role: auth.teacher.role } };
      if (event.action === 'classes') data = auth.classes.map(cls => ({ id: cls._id, name: cls.name || '' }));
      if (event.action === 'workspace') {
        if (!id(event.classId) || !validDate(event.date)) fail('BAD_REQUEST', '班级或日期无效');
        data = await workspace(event.classId, event.date, auth);
      }
      if (event.action === 'createBook') data = await createBook(event, auth);
      if (event.action === 'generateTodayPlan') data = await generateTodayPlan(event, auth);
      if (event.action === 'saveDailyRecord') data = await saveDailyRecord(event, auth);
      return { code: 'OK', data };
    } catch (error) {
      return error instanceof AppError ? { code: error.code, message: error.message } :
        { code: 'UNAVAILABLE', message: '作业服务暂不可用，请重试或联系管理员' };
    }
  };
}
module.exports = { createService, ACTION_KEYS };
