'use strict';
// Pure rules extracted from homework-manager/cloudfunctions/common/planEngine.js
// and homework-manager/cloudfunctions/plans/index.js. Database mutations stay in service.js.
function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function safeInt(value, fallback = 0) { return Math.round(safeNumber(value, fallback)); }
function safeDivide(a, b, fallback = 0) {
  const denominator = safeNumber(b);
  return denominator !== 0 ? safeNumber(a) / denominator : fallback;
}
function safeClamp(value, min, max) { return Math.min(Math.max(safeNumber(value, min), min), max); }
function toDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function countWorkdays(from, to, settings) {
  const workDays = settings.workDays || [1, 2, 3, 4, 5];
  const holidays = new Set(settings.holidays || []);
  let count = 0;
  const current = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (current <= end) {
    const date = toDateStr(current);
    if (workDays.includes(current.getDay()) && !holidays.has(date)) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}
function distributeIntegers(remaining, remainingDays) {
  if (remainingDays <= 0) return [];
  if (remaining <= 0) return new Array(remainingDays).fill(0);
  const dailyTarget = safeDivide(remaining, remainingDays, 0);
  const result = [];
  let distributed = 0;
  for (let index = 0; index < remainingDays; index++) {
    result[index] = Math.floor(safeNumber(dailyTarget));
    distributed += result[index];
  }
  const remainder = safeInt(remaining) - distributed;
  for (let index = 0; index < remainder && index < remainingDays; index++) result[index] += 1;
  return result;
}
function buildAlerts(projectedRate, todayTarget, studentCapacity, minRate, severeRate) {
  const alerts = [];
  if (projectedRate >= 1) alerts.push({ level: 'green', type: 'completion', message: '预计可按时完成全部作业' });
  else if (projectedRate >= minRate) alerts.push({ level: 'green', type: 'completion', message: `预计完成 ${Math.round(projectedRate * 100)}%，进度正常` });
  else if (projectedRate >= severeRate) alerts.push({ level: 'yellow', type: 'completion', message: `预计仅完成 ${Math.round(projectedRate * 100)}%，可能无法完成全部作业`, suggestion: '建议关注该生，可考虑减半或延长截止日期' });
  else alerts.push({ level: 'red', type: 'completion', message: `预计仅完成 ${Math.round(projectedRate * 100)}%，强烈建议干预`, suggestion: '建议减少作业项、延长截止日期或手动加量' });
  if (todayTarget > studentCapacity) alerts.push({ level: 'yellow', type: 'capacity', message: `今日目标 ${Math.round(todayTarget)}wl 超出该生日容量 ${Math.round(studentCapacity)}wl` });
  return alerts;
}
function buildProjection(student, books, settings, fromDate) {
  const remainingDays = countWorkdays(fromDate, settings.termEndDate, settings);
  if (remainingDays <= 0 || !books || books.length === 0) {
    return { projectedRate: 0, projectedDaily: 0, todayTarget: 0, studentCapacity: 0,
      remainingDays: 0, color: 'red', alerts: [{ level: 'red', type: 'overdue', message: '无剩余工作日或无作业' }] };
  }
  let totalWorkload = 0, completedWorkload = 0, remainingWorkload = 0;
  for (const book of books) {
    const unitWorkload = safeNumber(book.workloadPerUnit, 1);
    totalWorkload += safeNumber(book.totalAmount) * unitWorkload;
    completedWorkload += safeNumber(book.completedAmount) * unitWorkload;
    remainingWorkload += Math.max(0, (safeNumber(book.totalAmount) - safeNumber(book.completedAmount)) * unitWorkload);
  }
  const todayTarget = safeDivide(remainingWorkload, remainingDays, 0);
  const speedCoeff = safeNumber(student.speedCoefficient, 1);
  const projectedDaily = safeNumber(todayTarget * speedCoeff, 0);
  const projectedRate = safeClamp(safeDivide(completedWorkload + projectedDaily * remainingDays, totalWorkload, 0), 0, 1);
  const studentCapacity = safeNumber(settings.dailyCapacity, 40) * speedCoeff;
  const minRate = safeNumber(settings.minCompletionRate, 0.8);
  const severeRate = safeNumber(settings.severeCompletionRate, 0.6);
  const color = projectedRate < severeRate ? 'red' : projectedRate < minRate ? 'yellow' : 'green';
  return { studentId: student._id, name: student.name, speedCoeff, W_total: totalWorkload,
    W_done: completedWorkload, W_rem: remainingWorkload, projectedRate, projectedDaily, todayTarget,
    studentCapacity, remainingDays, color,
    alerts: buildAlerts(projectedRate, todayTarget, studentCapacity, minRate, severeRate) };
}
function calcPriorityScore(projection, totalWorkdays) {
  if (!projection) return 0;
  const riskScore = Math.max(0, 1 - safeNumber(projection.projectedRate));
  const streakScore = Math.min(riskScore * 0.6, 1);
  const urgencyScore = totalWorkdays > 0
    ? Math.max(0, 1 - safeNumber(projection.remainingDays) / totalWorkdays) : 0;
  const capacityGap = safeNumber(projection.studentCapacity) > 0
    ? Math.min(Math.max(0, (safeNumber(projection.todayTarget) - safeNumber(projection.studentCapacity)) / safeNumber(projection.studentCapacity)), 1) : 0;
  return Math.round((0.5 * riskScore + 0.3 * streakScore + 0.1 * urgencyScore + 0.1 * capacityGap) * 100) / 100;
}
module.exports = { safeNumber, safeInt, safeDivide, safeClamp, countWorkdays, distributeIntegers,
  buildAlerts, buildProjection, calcPriorityScore };
