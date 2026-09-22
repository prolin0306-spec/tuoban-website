'use strict';
const FIELDS = Object.freeze({
  children: ['_id', 'parentPhone'],
  hw_students: ['_id', 'feedbackChildId'],
  hw_homework_books: ['_id', 'studentId', 'name', 'subject', 'unit', 'totalAmount', 'completedAmount'],
  hw_daily_plans: ['_id', 'studentId', 'homeworkBookId', 'date', 'plannedAmount'],
  hw_daily_records: ['_id', 'studentId', 'homeworkBookId', 'date', 'actualAmount']
});
function createRepository(db) {
  return Object.freeze({ async list(collection, where) {
    if (!Object.hasOwn(FIELDS, collection)) throw new Error('Unsupported collection');
    const fields = Object.fromEntries(FIELDS[collection].map(field => [field, true]));
    const rows = [], seen = new Set();
    for (;;) {
      const response = await db.collection(collection).where(where).field(fields).orderBy('_id', 'asc').skip(rows.length).limit(100).get();
      if (!response || !Array.isArray(response.data)) throw new Error('Read failed');
      if (!response.data.length) return rows;
      for (const row of response.data) {
        if (!row._id || seen.has(row._id)) throw new Error('Data changed');
        seen.add(row._id); rows.push(row);
      }
      if (rows.length > 50000) throw new Error('Too many rows');
    }
  } });
}
module.exports = { createRepository, FIELDS };
