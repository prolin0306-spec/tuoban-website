'use strict';
const { AppError, fail } = require('./errors');
const { project, validDate, chinaDate, numeric, compareStudents } = require('./projection');
const ROLES = new Set(['boss', 'teacher', 'substituteTeacher']);
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function createService({ repo, identity, environmentId, now = () => new Date() }) {
  async function authorize() {
    const caller = await identity(); // platform context, NEVER event.userInfo / event.uid
    if (!caller || !id(caller.uid) || caller.isAnonymous !== false) fail('AUTH_REQUIRED', '请登录作业访问账号');
    const links = await repo.list('integration_teacher_links', { authUid: caller.uid, authEnvId: environmentId });
    if (links.length !== 1 || links[0].status !== 'active') fail('TEACHER_UNLINKED', '账号尚未关联作业老师或关联已停用，请联系管理员');
    const link = links[0];
    if (link.homeworkEnvId !== environmentId || !id(link.homeworkTeacherId)) fail('TEACHER_UNLINKED', '老师关联环境不匹配');
    const teachers = await repo.list('hw_teachers', { _id: link.homeworkTeacherId });
    if (teachers.length !== 1 || teachers[0].isActive !== true) fail('TEACHER_DISABLED', '作业老师未启用，请联系管理员');
    const teacher = teachers[0];
    if (!ROLES.has(teacher.role)) fail('FORBIDDEN', '账号没有作业查看权限');
    const all = await repo.list('hw_classes');
    const own = Array.isArray(teacher.classIds) ? teacher.classIds.filter(id) : [];
    const classes = all.filter(c => c.isActive !== false && (teacher.role === 'boss' ||
      own.includes(c._id) || c.substituteTeacherId === teacher._id));
    return { teacher, classes };
  }
  async function workspace(classId, date, auth) {
    const cls = auth.classes.find(c => c._id === classId);
    if (!cls) fail('FORBIDDEN', '无权查看该班级');
    const students = await repo.list('hw_students', { classId, isActive: true });
    const settingsRows = await repo.list('hw_settings', { _id: 'global' });
    const cards = [];
    // Each query is constrained to an authorized student. No cross-class scans.
    for (const student of students) {
      const [books, plans, records] = await Promise.all([
        repo.list('hw_homework_books', { studentId: student._id }),
        repo.list('hw_daily_plans', { studentId: student._id, date }),
        repo.list('hw_daily_records', { studentId: student._id, date })
      ]);
      const bookMap = new Map(books.map(b => [b._id, b]));
      const keys = [...new Set([...plans, ...records].map(row => row.homeworkBookId))];
      const tasks = keys.map(bookId => {
        const b = bookMap.get(bookId);
        const ps = plans.filter(p => p.homeworkBookId === bookId);
        const rs = records.filter(r => r.homeworkBookId === bookId);
        const conflict = ps.length > 1 || rs.length > 1;
        const p = ps.length === 1 ? ps[0] : null, r = rs.length === 1 ? rs[0] : null;
        const amount = v => numeric(v) && v >= 0 ? v : null;
        const planned = p ? amount(p.plannedAmount) : null;
        const actual = !conflict && r ? amount(r.actualAmount) : null;
        const unitWorkload = b && numeric(b.workloadPerUnit) && b.workloadPerUnit > 0 ? b.workloadPerUnit : null;
        const status = conflict ? 'conflict' : !r ? 'unrecorded' : actual === null ? 'invalid' :
          actual === 0 ? 'zero' : planned === null ? 'recorded' : actual >= planned ? 'completed' : 'partial';
        return { homeworkBookId: bookId || null, bookName: b ? b.name : '作业本信息缺失',
          unit: b ? b.unit || '' : '', planned, actual, status, hasPlan: ps.length > 0,
          planCompleted: p ? p.isCompleted === true : false, unitWorkload,
          warning: conflict ? '存在重复计划或记录，请管理员核对' : !b ? '关联的作业本信息缺失' : null };
      });
      let plannedWl = 0, actualWl = 0, missing = false;
      const plannedTasks = tasks.filter(t => t.hasPlan);
      for (const t of plannedTasks) {
        if (t.planned === null || t.actual === null || t.unitWorkload === null || t.status === 'conflict') { missing = true; continue; }
        plannedWl += t.planned * t.unitWorkload;
        actualWl += t.actual * t.unitWorkload;
      }
      const actualRate = !missing && plannedWl > 0 && numeric(actualWl) && numeric(plannedWl) ? actualWl / plannedWl : null;
      const projection = project(student, books.filter(b => b.isActive === true), settingsRows[0], date, chinaDate(now()));
      const actualRateReason = !plans.length ? '尚未生成计划' : !records.length ? '未记录' :
        tasks.some(t => t.hasPlan && t.status === 'unrecorded') ? '部分任务未记录，无法计算完整完成率' : '计划、实际记录或单位负载不足，无法计算';
      cards.push({ id: student._id, name: student.name || '', grade: student.grade || '',
        tasks, hasPlan: plans.length > 0,
        actualRate, actualRateReason: actualRate === null ? actualRateReason : null,
        projection, priorityScore: projection.priorityScore });
    }
    cards.sort(compareStudents);
    return { date, classId, className: cls.name || '', students: cards,
      summary: { studentCount: cards.length, taskCount: cards.reduce((n, c) => n + c.tasks.length, 0),
        recordedTaskCount: cards.reduce((n, c) => n + c.tasks.filter(t => t.actual !== null).length, 0) } };
  }
  return async function handle(event) {
    try {
      if (!environmentId) fail('NOT_CONFIGURED', '后端环境尚未配置');
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail('BAD_REQUEST', '请求格式错误');
      const keys = event.action === 'workspace' ? ['action', 'classId', 'date'] : ['action'];
      // Ignore optional platform-injected userInfo; identity comes ONLY from SDK context.
      // Reject arbitrary forwarding parameters and all other client identities.
      // Web SDK v3 injects tcbContext. It is transport metadata only and is never
      // used for identity or authorization; trusted identity comes from getEndUserInfo().
      if (Object.hasOwn(event, 'tcbContext') && (!event.tcbContext || typeof event.tcbContext !== 'object' || Array.isArray(event.tcbContext))) {
        fail('BAD_REQUEST', '请求格式错误');
      }
      if (Object.keys(event).some(k => !['userInfo', 'tcbContext', ...keys].includes(k))) fail('BAD_REQUEST', '请求包含不支持的字段');
      if (!['session', 'classes', 'workspace'].includes(event.action)) fail('BAD_REQUEST', '不支持的操作');
      const auth = await authorize();
      let data;
      if (event.action === 'session') data = { teacher: { id: auth.teacher._id, name: auth.teacher.name || '', role: auth.teacher.role } };
      if (event.action === 'classes') data = auth.classes.map(c => ({ id: c._id, name: c.name || '' }));
      if (event.action === 'workspace') {
        if (!id(event.classId) || !validDate(event.date)) fail('BAD_REQUEST', '班级或日期无效');
        data = await workspace(event.classId, event.date, auth);
      }
      return { code: 'OK', data };
    } catch (e) {
      // Never return raw SDK errors, database values, credentials or stack traces.
      return e instanceof AppError ? { code: e.code, message: e.message } :
        { code: 'UNAVAILABLE', message: '作业服务暂不可用，请重试或联系管理员' };
    }
  };
}
module.exports = { createService };
