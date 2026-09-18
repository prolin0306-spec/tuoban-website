'use strict';
const { fail } = require('./errors');
// Read projections deliberately exclude credentials and contact details.
const FIELDS = Object.freeze({
  integration_teacher_links: ['_id', 'authUid', 'authEnvId', 'homeworkEnvId', 'homeworkTeacherId', 'status'],
  hw_teachers: ['_id', 'name', 'role', 'classIds', 'isActive'],
  hw_classes: ['_id', 'name', 'substituteTeacherId', 'isActive'],
  hw_students: ['_id', 'name', 'grade', 'classId', 'speedLevel', 'speedCoefficient', 'isActive'],
  hw_homework_books: ['_id', 'studentId', 'classId', 'name', 'subject', 'unit', 'totalAmount', 'completedAmount', 'workloadPerUnit', 'isActive', 'createdAt', 'updatedAt'],
  hw_daily_plans: ['_id', 'studentId', 'classId', 'homeworkBookId', 'date', 'plannedAmount', 'plannedWorkload', 'isCompleted', 'createdAt'],
  hw_daily_records: ['_id', 'studentId', 'classId', 'homeworkBookId', 'date', 'plannedAmount', 'actualAmount', 'status', 'recordedBy', 'createdAt', 'updatedAt'],
  hw_settings: ['_id', 'termStartDate', 'termEndDate', 'workDays', 'holidays', 'dailyCapacity', 'minCompletionRate', 'severeCompletionRate']
});
const WRITES = Object.freeze({
  hw_homework_books: new Set(['studentId', 'classId', 'subject', 'name', 'totalAmount', 'workloadPerUnit', 'unit', 'completedAmount', 'isActive', 'createdAt', 'updatedAt']),
  hw_daily_plans: new Set(['studentId', 'classId', 'homeworkBookId', 'date', 'plannedAmount', 'plannedWorkload', 'isCompleted', 'createdAt']),
  hw_daily_records: new Set(['studentId', 'classId', 'homeworkBookId', 'date', 'plannedAmount', 'actualAmount', 'status', 'note', 'recordedBy', 'idempotencyKey', 'createdAt', 'updatedAt'])
});
function writeData(collection, data) {
  if (!Object.hasOwn(WRITES, collection) || !data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !WRITES[collection].has(key))) fail('BAD_REQUEST', '不支持的写入');
  return data;
}
function accessor(source) {
  return Object.freeze({
    async list(collection, where = {}) {
      if (!Object.hasOwn(FIELDS, collection)) fail('BAD_REQUEST', '不支持的查询');
      const rows = [], seen = new Set();
      const fields = Object.fromEntries(FIELDS[collection].map(key => [key, true]));
      for (;;) {
        const result = await source.collection(collection).where(where).field(fields)
          .orderBy('_id', 'asc').skip(rows.length).limit(100).get();
        if (!result || !Array.isArray(result.data)) fail('DATA_UNAVAILABLE', '数据读取失败，请重试');
        if (!result.data.length) return rows;
        for (const row of result.data) {
          if (!row._id || seen.has(row._id)) fail('DATA_CHANGED', '数据发生变化，请重新加载');
          seen.add(row._id); rows.push(row);
        }
        if (rows.length > 50000) fail('DATA_LIMIT', '数据量超出单次读取范围，请联系管理员');
      }
    },
    async add(collection, data) {
      const result = await source.collection(collection).add(writeData(collection, data));
      if (!result || !result.id) fail('DATA_UNAVAILABLE', '写入失败，请重试');
      return result.id;
    },
    async set(collection, documentId, data) {
      if (typeof documentId !== 'string' || !documentId) fail('BAD_REQUEST', '文档标识无效');
      await source.collection(collection).doc(documentId).set(writeData(collection, data));
      return documentId;
    },
    async update(collection, documentId, data) {
      if (typeof documentId !== 'string' || !documentId) fail('BAD_REQUEST', '文档标识无效');
      await source.collection(collection).doc(documentId).update(writeData(collection, data));
      return documentId;
    }
  });
}
function createRepository(db) {
  const base = accessor(db);
  return Object.freeze({ ...base,
    async runTransaction(callback) {
      if (!db || typeof db.runTransaction !== 'function') fail('UNAVAILABLE', '数据库事务不可用');
      let value;
      await db.runTransaction(async transaction => { value = await callback(accessor(transaction)); });
      return value;
    }
  });
}
module.exports = { createRepository, FIELDS, WRITES };
