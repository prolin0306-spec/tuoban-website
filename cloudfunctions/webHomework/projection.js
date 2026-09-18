'use strict';
// Pure calculations adapted from homework-manager plans/common/planEngine.js
// and plans/index.js calcPriorityScore. No DB, cloud function or plan generation imports.
const numeric = value => typeof value === 'number' && Number.isFinite(value);
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function chinaDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function risk(rate, minRate = 0.8, severeRate = 0.6) {
  return !numeric(rate) ? 'unknown' : rate >= minRate ? 'green' : rate >= severeRate ? 'yellow' : 'red';
}
function countWorkdays(from, to, workDays, holidays) {
  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
  if (!validDate(from) || !validDate(to) || end - start > 3660 * 86400000) return null;
  let days = 0;
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    if (workDays.includes(d.getUTCDay()) && !holidays.includes(d.toISOString().slice(0, 10))) days++;
  }
  return days;
}
function calcPriorityScore(proj, totalWorkdays) {
  if (!proj || !numeric(proj.rate) || !numeric(totalWorkdays) || totalWorkdays <= 0) return null;
  const riskScore = Math.max(0, 1 - proj.rate);
  const streakScore = Math.min(riskScore * 0.6, 1);
  const urgencyScore = Math.max(0, 1 - proj.remainingWorkdays / totalWorkdays);
  const capGap = proj.studentCapacity > 0
    ? Math.min(Math.max(0, (proj.todayTarget - proj.studentCapacity) / proj.studentCapacity), 1) : 0;
  return Math.round((0.5 * riskScore + 0.3 * streakScore + 0.1 * urgencyScore + 0.1 * capGap) * 100) / 100;
}
function compareStudents(a, b) {
  const order = { red: 0, yellow: 1, green: 2, unknown: 3 };
  return (order[a.projection.color] ?? 3) - (order[b.projection.color] ?? 3) ||
    (b.priorityScore ?? -1) - (a.priorityScore ?? -1) || a.id.localeCompare(b.id);
}
function project(student, books, settings, date, today) {
  const unknown = reason => ({ rate: null, color: 'unknown', reason, alerts: [], priorityScore: null });
  if (date !== today) return unknown('历史日期缺少当时的进度快照，无法预测');
  if (!settings || !validDate(settings.termEndDate)) return unknown('缺少有效学期配置');
  if (!numeric(student.speedCoefficient) || student.speedCoefficient <= 0) return unknown('缺少有效速度系数');
  if (!books.length) return unknown('没有可用于预测的作业本');
  const workDays = settings.workDays === undefined ? [1, 2, 3, 4, 5] : settings.workDays;
  const holidays = settings.holidays === undefined ? [] : settings.holidays;
  if (!Array.isArray(workDays) || !workDays.length || workDays.some(d => !Number.isInteger(d) || d < 0 || d > 6) ||
      !Array.isArray(holidays) || holidays.some(d => !validDate(d))) return unknown('工作日配置不完整');
  const end = Date.parse(settings.termEndDate + 'T00:00:00Z'), start = Date.parse(date + 'T00:00:00Z');
  if (end - start > 3660 * 86400000) return unknown('学期范围异常');
  const minRate = settings.minCompletionRate === undefined ? 0.8 : settings.minCompletionRate;
  const severeRate = settings.severeCompletionRate === undefined ? 0.6 : settings.severeCompletionRate;
  const capacity = settings.dailyCapacity === undefined ? 40 : settings.dailyCapacity;
  if (!numeric(minRate) || !numeric(severeRate) || severeRate < 0 || minRate > 1 || severeRate > minRate ||
      !numeric(capacity) || capacity <= 0) return unknown('预警阈值或日容量配置无效');
  const days = countWorkdays(date, settings.termEndDate, workDays, holidays);
  if (!days) return unknown('已无剩余工作日');
  let total = 0, done = 0, remaining = 0;
  for (const b of books) {
    if (![b.totalAmount, b.completedAmount, b.workloadPerUnit].every(numeric) ||
        b.totalAmount < 0 || b.completedAmount < 0 || b.workloadPerUnit <= 0) return unknown('作业总量、完成量或单位负载缺失');
    total += b.totalAmount * b.workloadPerUnit;
    done += b.completedAmount * b.workloadPerUnit;
    remaining += Math.max(0, (b.totalAmount - b.completedAmount) * b.workloadPerUnit);
  }
  if (total <= 0) return unknown('缺少有效作业总量');
  const todayTarget = remaining / days;
  const rate = Math.max(0, Math.min(1, (done + todayTarget * student.speedCoefficient * days) / total));
  if (![total, done, remaining, todayTarget, rate].every(numeric)) return unknown('数据超出可计算范围');
  const studentCapacity = capacity * student.speedCoefficient;
  if (!numeric(studentCapacity)) return unknown('日容量超出可计算范围');
  const color = risk(rate, minRate, severeRate);
  const messages = {
    green: rate >= 1 ? '预计可按时完成全部作业' : `预计完成 ${Math.round(rate * 100)}%，进度正常`,
    yellow: `预计仅完成 ${Math.round(rate * 100)}%，可能无法完成全部作业`,
    red: `预计仅完成 ${Math.round(rate * 100)}%，需要重点关注`
  };
  const alerts = [{ level: color, type: 'completion', message: messages[color] }];
  if (todayTarget > studentCapacity) alerts.push({ level: 'yellow', type: 'capacity',
    message: `今日目标 ${Math.round(todayTarget)} 负载超出该生日容量 ${Math.round(studentCapacity)} 负载` });
  const projection = { rate, color, reason: null, remainingWorkdays: days, todayTarget, studentCapacity, alerts };
  const totalDays = settings.termStartDate <= settings.termEndDate
    ? countWorkdays(settings.termStartDate, settings.termEndDate, workDays, holidays) : null;
  projection.priorityScore = calcPriorityScore(projection, totalDays);
  projection.priorityReason = projection.priorityScore === null ? '缺少有效学期起止日期，无法计算优先级' : null;
  return projection;
}
module.exports = { project, risk, validDate, chinaDate, numeric, countWorkdays, calcPriorityScore, compareStudents };
