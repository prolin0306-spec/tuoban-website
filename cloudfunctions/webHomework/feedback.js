'use strict';
const crypto = require('node:crypto');
const { fail } = require('./errors');
const { validDate, shanghaiDate } = require('./projection');
const KEYS = {
  studentFeedback: ['action', 'studentId', 'date'],
  saveStudentFeedback: ['action', 'studentId', 'date', 'attendance', 'meal', 'learning', 'behavior', 'remarks'],
  saveStudentMistake: ['action', 'studentId', 'date', 'subject', 'note', 'imageBase64', 'requestId'],
  deleteStudentMistake: ['action', 'studentId', 'mistakeId']
};
const fields = ['attendance', 'meal', 'learning', 'behavior', 'remarks'];
function value(input, max = 3000) {
  if (input === undefined) return '';
  if (typeof input !== 'string' || input.length > max) fail('BAD_REQUEST', '反馈内容过长或格式无效');
  return input.trim();
}
function createFeedback({ repo, authorize, resolveStudent, now, storage }) {
  async function linked(event, auth, source) {
    const student = await resolveStudent(event.studentId, auth, source);
    if (!student.feedbackChildId) fail('FEEDBACK_UNLINKED', '请先在学生管理关联家长反馈');
    const [children, owners] = await Promise.all([source.list('children', { _id: student.feedbackChildId }), source.list('hw_students', { feedbackChildId: student.feedbackChildId })]);
    if (children.length !== 1 || owners.length !== 1 || owners[0]._id !== student._id) fail('DATA_CHANGED', '学生反馈关联异常');
    return student.feedbackChildId;
  }
  async function dateCheck(date, source, writing = false) {
    if (!validDate(date)) fail('BAD_REQUEST', '日期无效');
    const settings = await source.list('hw_settings', { _id: 'global' });
    if (settings.length !== 1 || !validDate(settings[0].termStartDate) || !validDate(settings[0].termEndDate)) fail('TERM_NOT_CONFIGURED', '学期配置无效');
    if (date < settings[0].termStartDate || date > settings[0].termEndDate) fail('DATE_OUTSIDE_TERM', '日期不在学期内');
    if (writing && date > shanghaiDate(now())) fail('FUTURE_DATE', '不能录入未来反馈');
  }
  const onDate = (rows, date) => rows.filter(row => typeof row.date === 'string' && row.date.slice(0, 10) === date);
  return async function feedback(event, auth) {
    if (event.action === 'studentFeedback') {
      const childId = await linked(event, auth, repo); await dateCheck(event.date, repo);
      const [reports, allMistakes] = await Promise.all([repo.list('daily_reports', { childId }), repo.list('mistakes', { childId })]);
      const today = onDate(reports, event.date); if (today.length > 1) fail('DATA_CHANGED', '该日期存在多份反馈，请先核对');
      const mistakes = onDate(allMistakes, event.date);
      const urls = storage && mistakes.length ? await storage.urls(mistakes.map(row => row.imageFileID).filter(Boolean)) : {};
      return { childId, date: event.date, report: today[0] || null,
        mistakes: mistakes.map(row => ({ ...row, imageURL: urls[row.imageFileID] || '' })) };
    }
    if (event.action === 'saveStudentFeedback') {
      const content = Object.fromEntries(fields.map(key => [key, value(event[key])]));
      if (!['', '正常', '请假', '迟到'].includes(content.attendance) || !['', '全部吃完', '一般', '较少'].includes(content.meal)) fail('BAD_REQUEST', '出勤或饮食选项无效');
      return repo.runTransaction(async tx => {
        const fresh = await authorize(tx), childId = await linked(event, fresh, tx); await dateCheck(event.date, tx, true);
        const rows = onDate(await tx.list('daily_reports', { childId }), event.date);
        if (rows.length > 1) fail('DATA_CHANGED', '该日期存在多份反馈，请先核对');
        const stamp = now(), record = { ...content, childId, date: event.date, updatedAt: stamp };
        let reportId;
        if (rows.length) { reportId = rows[0]._id; await tx.update('daily_reports', reportId, record); }
        else { reportId = 'webreport_' + crypto.createHash('sha256').update(childId + '\0' + event.date).digest('hex').slice(0, 48); await tx.set('daily_reports', reportId, { ...record, createdAt: stamp }); }
        return { id: reportId, childId, date: event.date };
      });
    }
    if (event.action === 'saveStudentMistake') {
      const childId = await linked(event, auth, repo); await dateCheck(event.date, repo, true);
      const subject = value(event.subject, 32), note = value(event.note);
      if (!subject || typeof event.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(event.requestId)) fail('BAD_REQUEST', '错题信息无效');
      const base64 = event.imageBase64;
      if (typeof base64 !== 'string' || base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('BAD_REQUEST', '图片限 2 MB 的 JPEG、PNG 或 WebP');
      const bytes = Buffer.from(base64, 'base64');
      const ext = bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'jpg' : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' ? 'webp' : '';
      if (!ext || bytes.length > 2*1024*1024) fail('BAD_REQUEST', '图片格式不支持或超过 2 MB');
      const recordId = 'webmistake_' + crypto.createHash('sha256').update(childId + '\0' + event.requestId).digest('hex').slice(0,48);
      const existing = await repo.list('mistakes', { _id: recordId });
      if (existing.length) return { id: recordId, childId, repeated: true };
      if (!storage) fail('UNAVAILABLE', '图片服务不可用');
      const fileID = await storage.upload('mistakes/web/' + crypto.randomUUID() + '.' + ext, bytes);
      if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) fail('UNAVAILABLE', '图片上传失败');
      return repo.runTransaction(async tx => {
        const fresh = await authorize(tx), currentChild = await linked(event, fresh, tx);
        if (currentChild !== childId) fail('DATA_CHANGED', '学生关联已变化');
        await dateCheck(event.date, tx, true);
        if ((await tx.list('mistakes', { _id: recordId })).length) return { id: recordId, childId, repeated: true };
        const stamp = now(); await tx.set('mistakes', recordId, { childId, date: event.date, subject, note, imageFileID: fileID, createdAt: stamp, updatedAt: stamp });
        return { id: recordId, childId };
      });
    }
    if (event.action === 'deleteStudentMistake') {
      if (typeof event.mistakeId !== 'string' || !event.mistakeId || event.mistakeId.length > 128) fail('BAD_REQUEST', '错题标识无效');
      return repo.runTransaction(async tx => {
        const fresh = await authorize(tx), childId = await linked(event, fresh, tx);
        const rows = await tx.list('mistakes', { _id: event.mistakeId });
        if (rows.length !== 1 || rows[0].childId !== childId) fail('FORBIDDEN', '无权删除此错题');
        await tx.deleteMistake(event.mistakeId); return { id: event.mistakeId };
      });
    }
  };
}
module.exports = { createFeedback, KEYS };
