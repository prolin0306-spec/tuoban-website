'use strict';
const { fail } = require('./errors');
// Field projections deliberately exclude credentials, contact details and notes.
const FIELDS = Object.freeze({
  integration_teacher_links: ['_id', 'authUid', 'authEnvId', 'homeworkEnvId', 'homeworkTeacherId', 'status'],
  hw_teachers: ['_id', 'name', 'role', 'classIds', 'isActive'],
  hw_classes: ['_id', 'name', 'substituteTeacherId', 'isActive'],
  hw_students: ['_id', 'name', 'grade', 'classId', 'speedCoefficient', 'isActive'],
  hw_homework_books: ['_id', 'studentId', 'name', 'subject', 'unit', 'totalAmount', 'completedAmount', 'workloadPerUnit', 'isActive'],
  hw_daily_plans: ['_id', 'studentId', 'homeworkBookId', 'date', 'plannedAmount', 'plannedWorkload', 'isCompleted'],
  hw_daily_records: ['_id', 'studentId', 'homeworkBookId', 'date', 'actualAmount', 'status'],
  hw_settings: ['_id', 'termStartDate', 'termEndDate', 'workDays', 'holidays', 'dailyCapacity', 'minCompletionRate', 'severeCompletionRate']
});
function createRepository(db) {
  return Object.freeze({
    async list(collection, where = {}) {
      if (!Object.hasOwn(FIELDS, collection)) fail('BAD_REQUEST', '不支持的查询');
      const rows = [], seen = new Set();
      const fields = Object.fromEntries(FIELDS[collection].map(key => [key, true]));
      // Continue until an EMPTY page, even when a provider returns fewer than limit.
      // Stable ordering and duplicate detection prevent silently returning partial data.
      for (;;) {
        const result = await db.collection(collection).where(where).field(fields)
          .orderBy('_id', 'asc').skip(rows.length).limit(100).get();
        if (!result || !Array.isArray(result.data)) fail('DATA_UNAVAILABLE', '数据读取失败，请重试');
        if (!result.data.length) return rows;
        for (const row of result.data) {
          if (!row._id || seen.has(row._id)) fail('DATA_CHANGED', '数据发生变化，请重新加载');
          seen.add(row._id); rows.push(row);
        }
        if (rows.length > 50000) fail('DATA_LIMIT', '数据量超出单次读取范围，请联系管理员');
      }
    }
  });
}
module.exports = { createRepository, FIELDS };
