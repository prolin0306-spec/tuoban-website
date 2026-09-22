'use strict';
// All identities and records in this file are invented exclusively for tests.
function fixture() {
  return {
    integration_teacher_links: [{ _id: 'link-1', authUid: 'test-uid', authEnvId: 'test-env', homeworkEnvId: 'test-env', homeworkTeacherId: 'teacher-a', status: 'active' }],
    hw_teachers: [{ _id: 'teacher-a', name: '测试老师', role: 'teacher', classIds: ['class-a'], isActive: true }],
    hw_classes: [{ _id: 'class-a', name: '测试甲班', grade: '测试年级', teacherIds: ['teacher-a'], isActive: true },
      { _id: 'class-b', name: '测试代班', grade: '测试年级', teacherIds: [], substituteTeacherId: 'teacher-a', isActive: true },
      { _id: 'class-c', name: '不可访问班级', grade: '测试年级', teacherIds: [], isActive: true }],
    hw_students: [{ _id: 'student-a', name: '虚构学生甲', grade: '测试年级', classId: 'class-a', speedLevel: 'normal', speedCoefficient: 0.8, isActive: true },
      { _id: 'student-b', name: '虚构学生乙', grade: '测试年级', classId: 'class-a', speedLevel: 'normal', speedCoefficient: 1, isActive: true }],
    children: [{ _id: 'feedback-child-a', name: '虚构学生甲', class: '测试甲班', parentPhone: 13800000001 },
      { _id: 'feedback-child-b', name: '虚构学生乙', class: '测试甲班', parentPhone: 13800000002 }],
    hw_homework_books: ['a', 'b', 'c', 'd'].map((v, i) => ({ _id: 'book-' + v, studentId: i === 3 ? 'student-b' : 'student-a', classId: 'class-a', name: '测试作业' + v,
      unit: i === 1 ? '题' : '页', workloadPerUnit: i === 1 ? 5 : 2, totalAmount: 100,
      completedAmount: v === 'a' ? 2 : v === 'd' ? 1 : 0, isActive: true })),
    hw_daily_plans: ['a', 'b', 'c'].map((v, i) => ({ _id: 'plan-' + v, studentId: 'student-a', classId: 'class-a', homeworkBookId: 'book-' + v, date: '2026-09-15', plannedAmount: i === 0 ? 4 : 2, isCompleted: false })),
    hw_daily_records: [{ _id: 'record-a', studentId: 'student-a', classId: 'class-a', homeworkBookId: 'book-a', date: '2026-09-15', actualAmount: 2 },
      { _id: 'record-b', studentId: 'student-a', classId: 'class-a', homeworkBookId: 'book-b', date: '2026-09-15', actualAmount: 0 },
      { _id: 'record-d', studentId: 'student-b', classId: 'class-a', homeworkBookId: 'book-d', date: '2026-09-15', actualAmount: 1 }],
    hw_settings: [{ _id: 'global', termStartDate: '2026-09-01', termEndDate: '2026-09-30', workDays: [1, 2, 3, 4, 5], holidays: [], dailyCapacity: 40, minCompletionRate: 0.8, severeCompletionRate: 0.6 }]
  };
}
function mockDatabase(data, serverPageSize = 17) {
  const state = { reads: [], writes: 0, mutations: [], nextId: 1, failWrite: null };
  let transactionTail = Promise.resolve();
  function beforeWrite(op, collection, id) {
    if (typeof state.failWrite === 'function' && state.failWrite({ op, collection, id, writeNumber: state.writes + 1 })) {
      throw new Error('SIMULATED_TRANSACTION_WRITE_FAILURE');
    }
  }
  function collection(collection) {
    let where = {}, fields = null, offset = 0, size = 100;
    const matches = row => Object.entries(where).every(([key, value]) => row[key] === value);
    const query = {
      where(value) { where = value; return this; }, field(value) { fields = value; return this; },
      orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { size = value; return this; },
      async get() {
        state.reads.push({ collection, fields: fields || {}, where: { ...where }, offset });
        const rows = (data[collection] || []).filter(matches)
          .sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + Math.min(size, serverPageSize));
        return { data: rows.map(row => fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])) : { ...row }) };
      },
      async add(value) {
        beforeWrite('add', collection);
        const id = `mock-${state.nextId++}`; if (!data[collection]) data[collection] = [];
        data[collection].push({ ...value, _id: id }); state.writes++; state.mutations.push({ op: 'add', collection, id }); return { id };
      },
      async update(value) {
        let updated = 0; for (const row of data[collection] || []) if (matches(row)) { Object.assign(row, value); updated++; }
        state.writes++; state.mutations.push({ op: 'update', collection, count: updated }); return { updated };
      },
      doc(documentId) {
        return {
          set: async value => {
            beforeWrite('set', collection, documentId);
            if (!data[collection]) data[collection] = [];
            const index = data[collection].findIndex(row => row._id === documentId);
            const row = { ...value, _id: documentId };
            if (index < 0) data[collection].push(row); else data[collection][index] = row;
            state.writes++; state.mutations.push({ op: 'set', collection, id: documentId }); return { updated: 1 };
          },
          update: async value => {
            beforeWrite('update', collection, documentId);
            const row = (data[collection] || []).find(item => item._id === documentId);
            if (!row) throw new Error('DOCUMENT_NOT_FOUND'); Object.assign(row, value);
            state.writes++; state.mutations.push({ op: 'update', collection, id: documentId }); return { updated: 1 };
          }
        };
      }
    };
    return query;
  }
  state.db = { collection, runTransaction(callback) {
    const execute = async () => {
      const snapshot = structuredClone(data), writeCount = state.writes, mutationCount = state.mutations.length, nextId = state.nextId;
      try { return await callback({ collection }); }
      catch (error) {
        for (const key of Object.keys(data)) delete data[key]; Object.assign(data, snapshot);
        state.writes = writeCount; state.mutations.length = mutationCount; state.nextId = nextId; throw error;
      }
    };
    const result = transactionTail.then(execute, execute);
    transactionTail = result.catch(() => {});
    return result;
  } };
  return state;
}
module.exports = { fixture, mockDatabase };
