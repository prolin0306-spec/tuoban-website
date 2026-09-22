'use strict';

const PHONE = /^1\d{10}$/;
const shanghaiToday = date => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(date);

function createService({ repo, identity, now = () => new Date() }) {
  return async event => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        Object.keys(event).some(key => !['action', 'childId', 'phone'].includes(key)) || event.action !== 'summary') {
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
      const studentId = students[0]._id;
      const date = shanghaiToday(now());
      const [books, plans, records] = await Promise.all([
        repo.list('hw_homework_books', { studentId }),
        repo.list('hw_daily_plans', { studentId, date }),
        repo.list('hw_daily_records', { studentId, date })
      ]);
      const validBooks = books.filter(book => book.studentId === studentId);
      const bookIds = new Set(validBooks.map(book => book._id));
      const planByBook = new Map(plans.filter(plan => plan.studentId === studentId && plan.date === date && bookIds.has(plan.homeworkBookId))
        .map(plan => [plan.homeworkBookId, plan]));
      const recordByBook = new Map(records.filter(record => record.studentId === studentId && record.date === date && bookIds.has(record.homeworkBookId))
        .map(record => [record.homeworkBookId, record]));
      return { code: 'OK', data: { linked: true, date, books: validBooks.map(book => {
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
