'use strict';

const PHONE = /^1\d{10}$/;
// Match the teacher service exactly; never depend on runtime ICU locale formatting.
const shanghaiToday = date => new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createService({ repo, identity, now = () => new Date() }) {
  return async event => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        Object.keys(event).some(key => !['action', 'childId', 'phone', 'date', 'userInfo', 'tcbContext'].includes(key)) ||
        (Object.hasOwn(event, 'tcbContext') && (!event.tcbContext || typeof event.tcbContext !== 'object' || Array.isArray(event.tcbContext))) ||
        event.action !== 'summary') {
      return { code: 'BAD_REQUEST', message: '不支持的请求' };
    }
    if (typeof event.childId !== 'string' || !event.childId || event.childId.length > 128 ||
        typeof event.phone !== 'string' || !PHONE.test(event.phone)) {
      return { code: 'BAD_REQUEST', message: '查询信息无效' };
    }
    try {
      const caller = await identity();
      if (!caller || typeof caller.uid !== 'string' || !caller.uid) return { code: 'AUTH_REQUIRED', message: '请重新查询' };
      const children = await repo.list('children', { _id: event.childId });
      if (children.length !== 1 || String(children[0].parentPhone) !== event.phone) {
        return { code: 'NOT_FOUND', message: '未找到对应反馈' };
      }
      const students = await repo.list('hw_students', { feedbackChildId: event.childId });
      if (!students.length) return { code: 'OK', data: { linked: false, books: [], date: shanghaiToday(now()) } };
      if (students.length !== 1) return { code: 'DATA_CONFLICT', message: '学生关联异常，请联系老师' };
      const student = students[0], studentId = student._id;
      const today = shanghaiToday(now());
      const date = event.date === undefined ? today : event.date;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date || date > today) return { code:'BAD_DATE', message:'查询日期无效' };
      if (date !== today) {
        const settings = await repo.list('hw_settings', { _id:'global' });
        if (settings.length!==1 || !settings[0].termStartDate || !settings[0].termEndDate) return { code:'TERM_NOT_CONFIGURED', message:'学期未配置' };
        if (date < settings[0].termStartDate || date > settings[0].termEndDate) return { code:'DATE_OUTSIDE_TERM', message:'日期不在学期内' };
      }
      const classes = student.classId ? await repo.list('hw_classes', { _id: student.classId }) : [];
      const profile = { name: student.name || '', className: classes.length === 1 ? classes[0].name || '' : '' };
      if (student.isActive === false) return { code: 'OK', data: { linked: true, isActive: false, student: profile, books: [], date } };
      const [books, plans, records] = await Promise.all([
        repo.list('hw_homework_books', { studentId }),
        repo.list('hw_daily_plans', { studentId, date }),
        repo.list('hw_daily_records', { studentId, date })
      ]);
      const datedActivity = new Set([...plans, ...records].filter(row => row.studentId === studentId && row.date === date).map(row => row.homeworkBookId));
      const validBooks = books.filter(book => book.studentId === studentId && book.isActive !== false &&
        (book.assignmentDate === date || datedActivity.has(book._id)));
      const bookIds = new Set(validBooks.map(book => book._id));
      const planByBook = new Map(plans.filter(plan => plan.studentId === studentId && plan.date === date && bookIds.has(plan.homeworkBookId))
        .map(plan => [plan.homeworkBookId, plan]));
      const recordByBook = new Map(records.filter(record => record.studentId === studentId && record.date === date && bookIds.has(record.homeworkBookId))
        .map(record => [record.homeworkBookId, record]));
      return { code: 'OK', data: { linked: true, isActive: true, student: profile, date, books: validBooks.map(book => {
        const plan = planByBook.get(book._id), record = recordByBook.get(book._id);
        const totalAmount = Number(book.totalAmount), completedAmount = Number(book.completedAmount);
        return {
          name: String(book.name || ''), subject: String(book.subject || ''), unit: String(book.unit || ''),
          totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
          completedAmount: Number.isFinite(completedAmount) ? completedAmount : 0,
          isCompleted: Number.isFinite(totalAmount) && totalAmount > 0 && completedAmount >= totalAmount,
          todayPlannedAmount: plan ? Number(plan.plannedAmount) : null,
          todayActualAmount: record ? Number(record.actualAmount) : null
        };
      }) } };
    } catch (_) { return { code: 'DATA_UNAVAILABLE', message: '作业信息暂不可用，请稍后重试' }; }
  };
}
module.exports = { createService, shanghaiToday };
