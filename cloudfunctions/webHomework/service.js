'use strict';
const crypto = require('node:crypto');
const { AppError, fail } = require('./errors');
const { project, validDate, shanghaiDate, numeric, compareStudents } = require('./projection');
const { countWorkdays, distributeIntegers, safeNumber, safeInt } = require('./plan-engine');
const ROLES = new Set(['boss', 'teacher', 'substituteTeacher']);
const SPEED_MAP = Object.freeze({ slow: 0.7, normal: 1, fast: 1.3 });
const ACTION_KEYS = Object.freeze({
  session: ['action'], classes: ['action'], workspace: ['action', 'classId', 'date'],
  managedClasses: ['action'],
  createClass: ['action', 'name', 'grade'],
  updateClass: ['action', 'classId', 'name', 'grade'],
  setClassActive: ['action', 'classId', 'isActive'],
  students: ['action', 'classId', 'query'],
  createStudent: ['action', 'name', 'grade', 'classId', 'speedLevel'],
  updateStudent: ['action', 'studentId', 'name', 'grade', 'classId', 'speedLevel'],
  setStudentActive: ['action', 'studentId', 'isActive'],
  createBook: ['action', 'studentId', 'name', 'subject', 'totalAmount', 'workloadPerUnit', 'unit'],
  createClassBooks: ['action', 'classId', 'requestId', 'name', 'subject', 'totalAmount', 'workloadPerUnit', 'unit'],
  createBookList: ['action', 'classId', 'studentId', 'requestId', 'books'],
  generateTodayPlan: ['action', 'studentId'],
  saveDailyRecord: ['action', 'studentId', 'homeworkBookId', 'date', 'actualAmount']
});
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function text(value, name, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('BAD_REQUEST', `${name}无效`);
  return value.trim();
}
function optionalSearch(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > 100) fail('BAD_REQUEST', '搜索关键词无效');
  return value.trim().toLocaleLowerCase('zh-CN');
}
function speed(value = 'normal') {
  if (typeof value !== 'string' || !Object.hasOwn(SPEED_MAP, value)) fail('BAD_REQUEST', '速度等级无效');
  return { speedLevel: value, speedCoefficient: SPEED_MAP[value] };
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
    return { teacher, classes, allClasses: all };
  }
  async function resolveStudent(studentId, auth, source = repo) {
    if (!id(studentId)) fail('BAD_REQUEST', '学生无效');
    const students = await source.list('hw_students', { _id: studentId });
    if (students.length !== 1 || students[0].isActive !== true) fail('NOT_FOUND', '学生不存在或已停用');
    const student = students[0];
    if (!auth.classes.some(cls => cls._id === student.classId)) fail('FORBIDDEN', '无权操作该学生');
    return student;
  }
  async function resolveManagedStudent(studentId, auth, source = repo) {
    if (!id(studentId)) fail('BAD_REQUEST', '学生无效');
    const rows = await source.list('hw_students', { _id: studentId });
    if (rows.length !== 1) fail('NOT_FOUND', '学生不存在');
    if (!auth.classes.some(cls => cls._id === rows[0].classId)) fail('FORBIDDEN', '无权操作该学生');
    return rows[0];
  }
  async function resolveWritableClass(classId, auth, source = repo) {
    if (!id(classId) || !auth.classes.some(cls => cls._id === classId)) fail('FORBIDDEN', '无权操作该班级');
    const rows = await source.list('hw_classes', { _id: classId });
    if (rows.length !== 1 || rows[0].isActive === false) fail('FORBIDDEN', '班级不存在、不可用或无权操作');
    return rows[0];
  }
  async function resolveManagedClass(classId, auth, source = repo) {
    if (!id(classId)) fail('BAD_REQUEST', '班级无效');
    const rows = await source.list('hw_classes', { _id: classId });
    if (rows.length !== 1) fail('NOT_FOUND', '班级不存在');
    if (auth.teacher.role !== 'boss' && !auth.classes.some(cls => cls._id === classId)) fail('FORBIDDEN', '无权操作该班级');
    return rows[0];
  }
  async function managedClasses(auth) {
    const source = auth.teacher.role === 'boss' ? auth.allClasses : auth.classes;
    const rows = [];
    for (const cls of source) {
      const [students, books, plans] = await Promise.all([
        repo.list('hw_students', { classId: cls._id }),
        repo.list('hw_homework_books', { classId: cls._id }),
        repo.list('hw_daily_plans', { classId: cls._id })
      ]);
      rows.push({ id: cls._id, name: cls.name || '', grade: cls.grade || '', isActive: cls.isActive !== false,
        studentCount: students.length, activeStudentCount: students.filter(student => student.isActive === true).length,
        bookCount: books.length, planCount: plans.length });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    return { role: auth.teacher.role, canCreate: ['boss', 'teacher'].includes(auth.teacher.role),
      canDeactivate: auth.teacher.role === 'boss', classes: rows };
  }
  async function createClass(event, auth) {
    if (!['boss', 'teacher'].includes(auth.teacher.role)) fail('FORBIDDEN', '当前角色不能新增班级');
    const name = text(event.name, '班级名称', 100), grade = text(event.grade, '年级', 32), timestamp = now();
    return repo.runTransaction(async transaction => {
      const existing = await transaction.list('hw_classes');
      if (existing.some(cls => cls.isActive !== false && String(cls.name || '').trim() === name && String(cls.grade || '').trim() === grade)) {
        fail('CLASS_EXISTS', '同名同年级班级已存在');
      }
      const teacherIds = auth.teacher.role === 'teacher' ? [auth.teacher._id] : [];
      const data = { name, grade, teacherIds, substituteTeacherId: null, studentCount: 0, isActive: true,
        createdAt: timestamp, updatedAt: timestamp, operatorTeacherId: auth.teacher._id };
      const classId = await transaction.add('hw_classes', data);
      if (auth.teacher.role === 'teacher') {
        const current = await transaction.list('hw_teachers', { _id: auth.teacher._id });
        if (current.length !== 1 || current[0].isActive !== true || current[0].role !== 'teacher') fail('FORBIDDEN', '老师状态或角色已变化');
        const classIds = [...new Set([...(Array.isArray(current[0].classIds) ? current[0].classIds : []), classId])];
        await transaction.update('hw_teachers', auth.teacher._id, { classIds, updatedAt: timestamp });
      }
      return { id: classId, class: { ...data, id: classId } };
    });
  }
  async function updateClass(event, auth) {
    if (event.name === undefined && event.grade === undefined) fail('BAD_REQUEST', '没有可更新的班级字段');
    const update = {};
    if (event.name !== undefined) update.name = text(event.name, '班级名称', 100);
    if (event.grade !== undefined) update.grade = text(event.grade, '年级', 32);
    return repo.runTransaction(async transaction => {
      const cls = await resolveManagedClass(event.classId, auth, transaction);
      const name = update.name === undefined ? String(cls.name || '').trim() : update.name;
      const grade = update.grade === undefined ? String(cls.grade || '').trim() : update.grade;
      const existing = await transaction.list('hw_classes');
      if (existing.some(row => row._id !== cls._id && row.isActive !== false && String(row.name || '').trim() === name && String(row.grade || '').trim() === grade)) {
        fail('CLASS_EXISTS', '同名同年级班级已存在');
      }
      update.updatedAt = now(); update.operatorTeacherId = auth.teacher._id;
      await transaction.update('hw_classes', cls._id, update);
      return { id: cls._id, ...cls, ...update };
    });
  }
  async function setClassActive(event, auth) {
    if (auth.teacher.role !== 'boss') fail('FORBIDDEN', '只有负责人可以停用或重新启用班级');
    if (typeof event.isActive !== 'boolean') fail('BAD_REQUEST', '班级状态无效');
    return repo.runTransaction(async transaction => {
      const cls = await resolveManagedClass(event.classId, auth, transaction);
      if (!event.isActive) {
        const activeStudents = await transaction.list('hw_students', { classId: cls._id, isActive: true });
        if (activeStudents.length) fail('CLASS_HAS_ACTIVE_STUDENTS', '班级仍有启用学生，请先停用这些学生');
      }
      const update = { isActive: event.isActive, updatedAt: now(), operatorTeacherId: auth.teacher._id };
      await transaction.update('hw_classes', cls._id, update);
      return { id: cls._id, isActive: event.isActive, historyPreserved: true };
    });
  }
  async function students(event, auth) {
    const query = optionalSearch(event.query);
    let classes = auth.classes;
    if (event.classId !== undefined && event.classId !== '') {
      if (!id(event.classId)) fail('BAD_REQUEST', '班级无效');
      const selected = classes.find(cls => cls._id === event.classId);
      if (!selected) fail('FORBIDDEN', '无权查看该班级');
      classes = [selected];
    }
    const today = shanghaiDate(now()), rows = [];
    for (const cls of classes) {
      const classStudents = await repo.list('hw_students', { classId: cls._id });
      for (const student of classStudents) {
        if (query && !String(student.name || '').toLocaleLowerCase('zh-CN').includes(query)) continue;
        const [books, plans] = await Promise.all([
          repo.list('hw_homework_books', { studentId: student._id }),
          repo.list('hw_daily_plans', { studentId: student._id })
        ]);
        const hasCompleteSpeed = Object.hasOwn(SPEED_MAP, student.speedLevel) && numeric(student.speedCoefficient);
        rows.push({ id: student._id, name: student.name || '', grade: student.grade || '',
          classId: student.classId, className: cls.name || '', speedLevel: hasCompleteSpeed ? student.speedLevel : 'normal',
          speedCoefficient: hasCompleteSpeed ? student.speedCoefficient : SPEED_MAP.normal,
          isActive: student.isActive === true, bookCount: books.length,
          hasCurrentOrFuturePlan: plans.some(plan => validDate(plan.date) && plan.date >= today) });
      }
    }
    rows.sort((a, b) => a.className.localeCompare(b.className, 'zh-CN') ||
      a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    return { classes: auth.classes.map(cls => ({ id: cls._id, name: cls.name || '' })), students: rows };
  }
  async function createStudent(event, auth) {
    const name = text(event.name, '姓名', 100), grade = text(event.grade, '年级', 32);
    const speedFields = speed(event.speedLevel), timestamp = now();
    return repo.runTransaction(async transaction => {
      const cls = await resolveWritableClass(event.classId, auth, transaction);
      const student = { name, grade, classId: cls._id, ...speedFields, isActive: true,
        createdAt: timestamp, updatedAt: timestamp, operatorTeacherId: auth.teacher._id };
      const studentId = await transaction.add('hw_students', student);
      return { id: studentId, student: { ...student, id: studentId, className: cls.name || '', bookCount: 0,
        hasCurrentOrFuturePlan: false } };
    });
  }
  async function updateStudent(event, auth) {
    if (![event.name, event.grade, event.classId, event.speedLevel].some(value => value !== undefined)) {
      fail('BAD_REQUEST', '没有可更新的学生字段');
    }
    const update = {};
    if (event.name !== undefined) update.name = text(event.name, '姓名', 100);
    if (event.grade !== undefined) update.grade = text(event.grade, '年级', 32);
    if (event.speedLevel !== undefined) Object.assign(update, speed(event.speedLevel));
    return repo.runTransaction(async transaction => {
      const student = await resolveManagedStudent(event.studentId, auth, transaction);
      if (event.classId !== undefined) {
        if (!id(event.classId)) fail('BAD_REQUEST', '班级无效');
        if (event.classId !== student.classId) {
          await resolveWritableClass(event.classId, auth, transaction);
          const plans = await transaction.list('hw_daily_plans', { studentId: student._id });
          const today = shanghaiDate(now());
          if (plans.some(plan => validDate(plan.date) && plan.date >= today)) {
            fail('CLASS_CHANGE_BLOCKED', '学生已有今天或未来计划，V1 禁止调整班级');
          }
          update.classId = event.classId;
        }
      }
      update.updatedAt = now(); update.operatorTeacherId = auth.teacher._id;
      await transaction.update('hw_students', student._id, update);
      return { id: student._id, ...student, ...update };
    });
  }
  async function setStudentActive(event, auth) {
    if (typeof event.isActive !== 'boolean') fail('BAD_REQUEST', '启用状态无效');
    return repo.runTransaction(async transaction => {
      const student = await resolveManagedStudent(event.studentId, auth, transaction);
      const update = { isActive: event.isActive, updatedAt: now(), operatorTeacherId: auth.teacher._id };
      await transaction.update('hw_students', student._id, update);
      return { id: student._id, isActive: event.isActive, historyPreserved: true };
    });
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
  async function createClassBooks(event, auth) {
    if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(event.requestId)) fail('BAD_REQUEST', '批量请求标识无效');
    const name = text(event.name, '作业本名称', 100);
    const subject = text(event.subject, '科目', 32, 'other');
    const unit = text(event.unit, '单位', 16, '页');
    const totalAmount = positive(event.totalAmount, '总量');
    const workloadPerUnit = positiveNumber(event.workloadPerUnit, '单位负载', 5);
    const createdAt = now();
    return repo.runTransaction(async transaction => {
      const cls = await resolveWritableClass(event.classId, auth, transaction);
      const students = await transaction.list('hw_students', { classId: cls._id, isActive: true });
      if (!students.length) fail('NO_ACTIVE_STUDENTS', '班级没有启用学生');
      if (students.length > 100) fail('DATA_LIMIT', '单次最多为 100 名学生批量新增作业本');
      const pending = []; let existingCount = 0;
      for (const student of students) {
        const bookId = stableId('webbatchbook', event.requestId, student._id);
        const book = { studentId: student._id, classId: cls._id, subject, name, totalAmount,
          workloadPerUnit, unit, completedAmount: 0, isActive: true, batchId: event.requestId,
          createdAt, updatedAt: createdAt };
        const existing = await transaction.list('hw_homework_books', { _id: bookId });
        if (existing.length) {
          const row = existing[0], same = ['studentId', 'classId', 'subject', 'name', 'totalAmount', 'workloadPerUnit', 'unit', 'batchId']
            .every(key => row[key] === book[key]);
          if (!same || row.isActive !== true) fail('DATA_CHANGED', '批量请求对应的数据已变化，请刷新核对');
          existingCount++; continue;
        }
        pending.push({ id: bookId, data: book });
      }
      if (existingCount) {
        if (existingCount !== students.length) fail('DATA_CHANGED', '批量请求只完成了部分数据，请联系管理员核对');
        return { classId: cls._id, className: cls.name || '', bookName: name,
          createdCount: existingCount, planGenerated: false, repeated: true };
      }
      for (const book of pending) await transaction.set('hw_homework_books', book.id, book.data);
      return { classId: cls._id, className: cls.name || '', bookName: name,
        createdCount: pending.length, planGenerated: false, repeated: false };
    });
  }
  async function createBookList(event, auth) {
    if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(event.requestId)) fail('BAD_REQUEST', '批量请求标识无效');
    if (!Array.isArray(event.books) || event.books.length < 1 || event.books.length > 20) fail('BAD_REQUEST', '每次须填写 1 至 20 项作业');
    const books = event.books.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['name', 'subject', 'totalAmount', 'workloadPerUnit', 'unit'].includes(key))) fail('BAD_REQUEST', '作业项目包含不支持的字段');
      return { name: text(item.name, '作业名称', 100), subject: text(item.subject, '科目', 32, 'other'),
        totalAmount: positive(item.totalAmount, '作业数量'),
        workloadPerUnit: positiveNumber(item.workloadPerUnit, '单位负载', 5), unit: text(item.unit, '单位', 16, '页') };
    });
    const createdAt = now();
    return repo.runTransaction(async transaction => {
      const cls = await resolveWritableClass(event.classId, auth, transaction);
      let students;
      if (event.studentId === undefined) {
        students = await transaction.list('hw_students', { classId: cls._id, isActive: true });
        if (!students.length) fail('NO_ACTIVE_STUDENTS', '班级没有启用学生');
      } else {
        const student = await resolveStudent(event.studentId, auth, transaction);
        if (student.classId !== cls._id) fail('FORBIDDEN', '学生不属于所选班级');
        students = [student];
      }
      if (students.length > 100 || students.length * books.length > 300) fail('DATA_LIMIT', '单次最多创建 300 本作业本，请分批录入');
      const expectedIds = new Set(students.flatMap(student => books.map((_, index) =>
        stableId('weblistbook', event.requestId, cls._id, student._id, index))));
      const priorBatch = await transaction.list('hw_homework_books', { batchId: event.requestId });
      if (priorBatch.length && (priorBatch.length !== expectedIds.size || priorBatch.some(row => !expectedIds.has(row._id)))) {
        fail('DATA_CHANGED', '批量请求对应的数据已变化，请刷新核对');
      }
      const pending = []; let existingCount = 0;
      for (const student of students) {
        for (const [index, item] of books.entries()) {
          const bookId = stableId('weblistbook', event.requestId, cls._id, student._id, index);
          const book = { studentId: student._id, classId: cls._id, ...item, completedAmount: 0,
            isActive: true, batchId: event.requestId, createdAt, updatedAt: createdAt };
          const existing = await transaction.list('hw_homework_books', { _id: bookId });
          if (existing.length) {
            const row = existing[0];
            if (['studentId', 'classId', 'name', 'subject', 'totalAmount', 'workloadPerUnit', 'unit', 'batchId']
              .some(key => row[key] !== book[key]) || row.isActive !== true) fail('DATA_CHANGED', '批量请求对应的数据已变化，请刷新核对');
            existingCount++; continue;
          }
          pending.push({ id: bookId, data: book });
        }
      }
      if (existingCount) {
        if (pending.length) fail('DATA_CHANGED', '批量请求只完成了部分数据，请联系管理员核对');
        return { classId: cls._id, studentCount: students.length, bookCount: books.length,
          createdCount: existingCount, planGenerated: false, repeated: true };
      }
      for (const book of pending) await transaction.set('hw_homework_books', book.id, book.data);
      return { classId: cls._id, studentCount: students.length, bookCount: books.length,
        createdCount: pending.length, planGenerated: false, repeated: false };
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
      if (event.action === 'classes') data = auth.classes.map(cls => ({ id: cls._id, name: cls.name || '', grade: cls.grade || '' }));
      if (event.action === 'managedClasses') data = await managedClasses(auth);
      if (event.action === 'createClass') data = await createClass(event, auth);
      if (event.action === 'updateClass') data = await updateClass(event, auth);
      if (event.action === 'setClassActive') data = await setClassActive(event, auth);
      if (event.action === 'workspace') {
        if (!id(event.classId) || !validDate(event.date)) fail('BAD_REQUEST', '班级或日期无效');
        data = await workspace(event.classId, event.date, auth);
      }
      if (event.action === 'students') data = await students(event, auth);
      if (event.action === 'createStudent') data = await createStudent(event, auth);
      if (event.action === 'updateStudent') data = await updateStudent(event, auth);
      if (event.action === 'setStudentActive') data = await setStudentActive(event, auth);
      if (event.action === 'createBook') data = await createBook(event, auth);
      if (event.action === 'createClassBooks') data = await createClassBooks(event, auth);
      if (event.action === 'createBookList') data = await createBookList(event, auth);
      if (event.action === 'generateTodayPlan') data = await generateTodayPlan(event, auth);
      if (event.action === 'saveDailyRecord') data = await saveDailyRecord(event, auth);
      return { code: 'OK', data };
    } catch (error) {
      return error instanceof AppError ? { code: error.code, message: error.message } :
        { code: 'UNAVAILABLE', message: '作业服务暂不可用，请重试或联系管理员' };
    }
  };
}
module.exports = { createService, ACTION_KEYS, SPEED_MAP };
