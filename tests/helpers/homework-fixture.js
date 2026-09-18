'use strict';
// All identities and records in this file are invented exclusively for tests.
function fixture() {
  return {
    integration_teacher_links: [{ _id: 'link-1', authUid: 'test-uid', authEnvId: 'test-env', homeworkEnvId: 'test-env', homeworkTeacherId: 'teacher-a', status: 'active' }],
    hw_teachers: [{ _id: 'teacher-a', name: '测试老师', role: 'teacher', classIds: ['class-a'], isActive: true }],
    hw_classes: [{ _id: 'class-a', name: '测试甲班' }, { _id: 'class-b', name: '测试代班', substituteTeacherId: 'teacher-a' }, { _id: 'class-c', name: '不可访问班级' }],
    hw_students: [{ _id: 'student-a', name: '虚构学生甲', grade: '测试年级', classId: 'class-a', speedCoefficient: 0.8, isActive: true },
      { _id: 'student-b', name: '虚构学生乙', grade: '测试年级', classId: 'class-a', speedCoefficient: 1, isActive: true }],
    hw_homework_books: ['a', 'b', 'c', 'd'].map((v, i) => ({ _id: 'book-' + v, studentId: i === 3 ? 'student-b' : 'student-a', name: '测试作业' + v,
      unit: i === 1 ? '题' : '页', workloadPerUnit: i === 1 ? 5 : 2, totalAmount: 100, completedAmount: 0, isActive: true })),
    hw_daily_plans: ['a', 'b', 'c'].map((v, i) => ({ _id: 'plan-' + v, studentId: 'student-a', homeworkBookId: 'book-' + v, date: '2026-09-15', plannedAmount: i === 0 ? 4 : 2, isCompleted: false })),
    hw_daily_records: [{ _id: 'record-a', studentId: 'student-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 2 },
      { _id: 'record-b', studentId: 'student-a', homeworkBookId: 'book-b', date: '2026-09-15', actualAmount: 0 },
      { _id: 'record-d', studentId: 'student-b', homeworkBookId: 'book-d', date: '2026-09-15', actualAmount: 1 }],
    hw_settings: [{ _id: 'global', termStartDate: '2026-09-01', termEndDate: '2026-09-30', workDays: [1, 2, 3, 4, 5], holidays: [], dailyCapacity: 40, minCompletionRate: 0.8, severeCompletionRate: 0.6 }]
  };
}
function mockDatabase(data, serverPageSize = 17) {
  const state = { reads: [], writes: 0 };
  state.db = { collection(collection) {
    let where = {}, fields = {}, offset = 0, size = 100;
    const query = {
      where(value) { where = value; return this; }, field(value) { fields = value; return this; },
      orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { size = value; return this; },
      async get() {
        state.reads.push({ collection, fields, where, offset });
        const rows = (data[collection] || []).filter(row => Object.entries(where).every(([key, value]) => row[key] === value))
          .sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + Math.min(size, serverPageSize));
        return { data: rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields[key]))) };
      }
    };
    for (const op of ['add', 'set', 'update', 'remove', 'delete', 'createIndex']) query[op] = () => { state.writes++; throw new Error('DATABASE WRITE FORBIDDEN'); };
    return query;
  } };
  return state;
}
module.exports = { fixture, mockDatabase };
