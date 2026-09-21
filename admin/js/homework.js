(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  let generation = 0, active = false, pendingBatchId = null;
  const requestedClassId = new URLSearchParams(window.location.search).get('classId') || '';
  const statuses = { unrecorded: '未记录', zero: '已记录：完成量为 0', partial: '部分完成', completed: '已完成',
    recorded: '已有实际记录', invalid: '记录数据不足', conflict: '数据需核对' };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const requestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
    `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const percent = value => finite(value) ? `${Math.round(value * 10000) / 100}%` : '数据不足';
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function message(text, type) {
    const area = $('homeworkStatus'); area.replaceChildren();
    if (text) { const node = element('p', text, 'hw-notice'); node.dataset.type = type || 'info'; area.append(node); }
  }
  function clearData() {
    $('studentCards').replaceChildren(); $('homeworkSummary').textContent = '';
    $('bookStudent').replaceChildren();
  }
  function syncBookTarget() {
    const batch = $('bookTarget').value === 'class';
    $('bookStudentLabel').hidden = batch; $('bookStudent').required = !batch;
    $('createBookButton').textContent = batch ? '为全班新增作业本' : '新增作业本';
  }
  function failure(error) {
    clearData(); message(error.message || '加载失败，请重试', 'error');
    const authError = error.code === 'AUTH_REQUIRED';
    $('loginPanel').hidden = !authError; $('retryButton').hidden = authError;
    if (authError || ['TEACHER_DISABLED', 'TEACHER_UNLINKED', 'FORBIDDEN'].includes(error.code)) {
      active = false; $('workspacePanel').hidden = true; $('topbarInfo').textContent = '';
    }
  }
  async function runAction(button, operation, successText) {
    if (button.disabled) return;
    button.disabled = true; message('正在保存…');
    try {
      const result = await operation();
      await loadWorkspace();
      message(typeof successText === 'function' ? successText(result) : successText);
    } catch (error) { message(error.message || '操作失败，请重试', 'error'); }
    finally { button.disabled = false; }
  }
  function recordEditor(student, task, date, today) {
    const form = element('div', undefined, 'hw-record');
    const label = element('label', '实际完成量');
    const input = element('input');
    input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1';
    input.className = 'adm-form-input'; input.dataset.recordInput = task.homeworkBookId;
    if (finite(task.actual)) input.value = String(task.actual);
    input.placeholder = '未录入';
    const button = element('button', '保存本项', 'adm-btn adm-btn-primary'); button.type = 'button';
    const result = element('span', '', 'hw-action-result');
    const invalid = !task.hasPlan || task.status === 'conflict' || date > today;
    input.disabled = invalid; button.disabled = invalid;
    if (date > today) result.textContent = '未来日期不可录入';
    button.addEventListener('click', async () => {
      if (input.value.trim() === '') { result.textContent = '请输入完成量；0 表示已录入 0'; return; }
      const amount = Number(input.value);
      if (!Number.isFinite(amount) || amount < 0) { result.textContent = '完成量必须大于等于 0'; return; }
      result.textContent = '';
      await runAction(button, () => api.saveDailyRecord({ studentId: student.id,
        homeworkBookId: task.homeworkBookId, date, actualAmount: amount }), saved =>
        `已保存 ${student.name || '该学生'} · ${task.bookName}：${saved.actualAmount} ${task.unit || ''}`);
    });
    label.append(input); form.append(label, button, result); return form;
  }
  function completionToggle(student, task, date, today) {
    const label = element('label', undefined, 'hw-complete-toggle');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = task.status === 'completed';
    checkbox.dataset.completionToggle = task.homeworkBookId;
    const invalid = !task.hasPlan || !finite(task.planned) || task.status === 'conflict' || date > today;
    checkbox.disabled = invalid;
    checkbox.addEventListener('change', async () => {
      const checked = checkbox.checked, amount = checked ? task.planned : 0; checkbox.disabled = true; message('正在保存完成状态…');
      try {
        await api.saveDailyRecord({ studentId: student.id, homeworkBookId: task.homeworkBookId, date, actualAmount: amount });
        await loadWorkspace(); message(`${student.name || '该学生'} · ${task.bookName} 已标记为${checked ? '完成' : '未完成'}`);
      } catch (error) { checkbox.checked = !checked; checkbox.disabled = invalid; message(error.message || '保存失败，请重试', 'error'); }
    });
    label.append(checkbox, element('span', checkbox.checked ? '已完成' : '完成')); return label;
  }
  function render(data) {
    if (!data || !Array.isArray(data.students) || !data.summary) throw new Error('作业服务返回无效数据');
    $('studentCards').replaceChildren(); $('bookStudent').replaceChildren();
    $('homeworkSummary').textContent = `${data.className || '未命名班级'} · ${data.date} · ${data.students.length} 位学生 · ` +
      `${data.summary.taskCount} 项任务 · ${data.summary.recordedTaskCount} 项有实际记录 · 全班计划进度 ${data.summary.overallProgress}%。` +
      '按红、黄、绿及优先级降序排列。';
    for (const student of data.students) {
      const option = element('option', student.name || '未命名学生'); option.value = student.id; $('bookStudent').append(option);
    }
    if (!data.students.length) { $('studentCards').append(element('p', '该班级暂无学生', 'adm-card hw-empty')); return; }
    for (const student of data.students) {
      const card = element('details', undefined, 'adm-card hw-student');
      const rate = student.projection && student.projection.rate;
      const color = student.projection && student.projection.color || 'unknown';
      const colorNames = { red: '红色预警', yellow: '黄色预警', green: '进度正常', unknown: '预警数据不足' };
      card.dataset.color = color; card.dataset.studentId = student.id;
      card.append(element('summary', `${student.name || '未命名'} · ${student.grade || '年级未填写'}`));
      const metrics = element('div', undefined, 'hw-metrics');
      metrics.append(element('p', colorNames[color] || colorNames.unknown, 'hw-risk'));
      metrics.append(element('p', `优先级：${finite(student.priorityScore) ? student.priorityScore.toFixed(2) + '（分数越高越优先）' : '数据不足'}`));
      metrics.append(element('p', `预计完成率（学期）：${percent(rate)}`));
      metrics.append(element('p', `今日计划进度（小程序口径）：${percent(student.completionRate)}`));
      metrics.append(element('p', `实际完成率（按负载）：${finite(student.actualRate) ? percent(student.actualRate) : student.actualRateReason || '数据不足'}`));
      if (!finite(rate)) metrics.append(element('p', student.projection && student.projection.reason || '预测信息不足', 'hw-muted'));
      for (const alert of student.projection && student.projection.alerts || []) metrics.append(element('p', alert.message, 'hw-alert'));
      card.append(metrics);
      if (!student.hasPlan) {
        card.append(element('p', '尚未生成计划', 'hw-notice'));
        if (data.date === data.today) {
          const generate = element('button', '生成今日计划', 'adm-btn adm-btn-primary hw-generate'); generate.type = 'button';
          generate.addEventListener('click', () => runAction(generate, () => api.generateTodayPlan(student.id), result =>
            result.plansGenerated ? `已为 ${student.name || '该学生'} 生成 ${result.plansGenerated} 项今日计划` : '没有需要生成的剩余作业'));
          card.append(generate);
        }
      }
      const tasks = element('ul', undefined, 'hw-tasks');
      for (const task of student.tasks) {
        const row = element('li', undefined, 'hw-task'); row.dataset.bookId = task.homeworkBookId || '';
        const heading = element('div', undefined, 'hw-task-heading'); heading.append(element('h3', task.bookName || '作业本信息缺失'));
        if (task.hasPlan) heading.append(completionToggle(student, task, data.date, data.today)); row.append(heading);
        const values = element('div', undefined, 'hw-task-values');
        values.append(element('span', `计划：${finite(task.planned) ? task.planned + ' ' + task.unit : '尚未生成计划'}`));
        values.append(element('span', `实际：${finite(task.actual) ? task.actual + ' ' + task.unit : task.status === 'unrecorded' ? '未记录' : '数据需核对'}`));
        row.append(values, element('p', statuses[task.status] || '状态待核对'));
        if (task.warning) row.append(element('p', task.warning, 'hw-muted'));
        if (task.hasPlan) {
          const advanced = element('details', undefined, 'hw-advanced'); advanced.append(element('summary', '调整完成量'), recordEditor(student, task, data.date, data.today)); row.append(advanced);
        }
        tasks.append(row);
      }
      card.append(tasks); $('studentCards').append(card);
    }
  }
  async function loadWorkspace() {
    if (!active || !$('classSelect').value) return;
    const sequence = ++generation;
    $('studentCards').replaceChildren(); $('homeworkSummary').textContent = ''; message('正在加载任务与实际记录…');
    $('retryButton').hidden = true; $('studentCards').setAttribute('aria-busy', 'true');
    try {
      const data = await api.workspace($('classSelect').value, $('dateSelect').value);
      if (sequence !== generation) return; render(data); message('');
    } catch (error) { if (sequence === generation) failure(error); }
    finally { if (sequence === generation) $('studentCards').setAttribute('aria-busy', 'false'); }
  }
  async function start() {
    const sequence = ++generation; clearData(); message('正在验证作业访问权限…');
    $('retryButton').hidden = true; $('workspacePanel').hidden = true;
    try {
      const session = await api.session(); const classes = await api.classes();
      if (sequence !== generation) return;
      if (!session || !session.teacher || !Array.isArray(classes)) throw new Error('作业服务返回无效数据');
      active = true; $('loginPanel').hidden = true; $('topbarInfo').textContent = session.teacher.name || '已验证老师';
      $('classSelect').replaceChildren();
      for (const cls of classes) { const option = element('option', cls.name || '未命名班级'); option.value = cls.id; $('classSelect').append(option); }
      if (!classes.length) { message('暂无授权班级，请联系管理员分配班级或代班权限'); return; }
      if (requestedClassId && classes.some(cls => cls.id === requestedClassId)) $('classSelect').value = requestedClassId;
      $('workspacePanel').hidden = false; await loadWorkspace();
    } catch (error) { if (sequence === generation) failure(error); }
  }
  window.homeworkLogout = async () => {
    ++generation; active = false; clearData(); $('workspacePanel').hidden = true; $('topbarInfo').textContent = '';
    try { await api.logout(); $('loginPanel').hidden = false; $('retryButton').hidden = true; message('作业账号已退出'); }
    catch (error) { message(error.message, 'error'); }
  };
  $('homeworkLogin').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('loginButton'); button.disabled = true; message('正在验证账号…');
    try { await api.login($('homeworkUsername').value, $('homeworkPassword').value); await start(); }
    catch (error) { failure(error); $('loginPanel').hidden = false; }
    finally { $('homeworkPassword').value = ''; button.disabled = false; }
  });
  $('bookForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('createBookButton');
    const values = { name: $('bookName').value, subject: $('bookSubject').value, totalAmount: Number($('bookTotal').value),
      workloadPerUnit: Number($('bookWorkload').value), unit: $('bookUnit').value };
    const batch = $('bookTarget').value === 'class';
    if (batch && !window.confirm(`确认为当前班级全部启用学生分别新增作业本“${values.name.trim()}”？不会自动生成或重建计划。`)) return;
    if (batch && !pendingBatchId) pendingBatchId = requestId();
    await runAction(button, () => batch ? api.createClassBooks({ ...values, classId: $('classSelect').value, requestId: pendingBatchId }) :
      api.createBook({ ...values, studentId: $('bookStudent').value }), result => {
      $('bookName').value = ''; $('bookTotal').value = '';
      if (batch) pendingBatchId = null;
      return batch ? `${result.repeated ? '已确认' : '已为'} ${result.createdCount} 名启用学生${result.repeated ? '已有对应' : '分别新增'}作业本“${result.bookName}”；已有计划未被修改` :
        `已新增作业本“${result.book.name}”；已有计划未被修改`;
    });
  });
  $('retryButton').addEventListener('click', start); $('refreshButton').addEventListener('click', loadWorkspace);
  $('classSelect').addEventListener('change', () => { pendingBatchId = null; loadWorkspace(); }); $('dateSelect').addEventListener('change', loadWorkspace);
  $('bookTarget').addEventListener('change', () => { pendingBatchId = null; syncBookTarget(); });
  for (const id of ['bookName', 'bookSubject', 'bookTotal', 'bookWorkload', 'bookUnit']) $(id).addEventListener('input', () => { pendingBatchId = null; });
  syncBookTarget();
  $('sidebarToggle').addEventListener('click', () => setTimeout(() => $('sidebarToggle').setAttribute('aria-expanded', String($('sidebar').classList.contains('open'))), 0));
  $('dateSelect').value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  window.initSidebar('homework.html');
  try { api.onExpired(() => { ++generation; failure({ code: 'AUTH_REQUIRED', message: '作业会话已过期，请重新验证' }); }); }
  catch (error) { failure(error); }
  start();
})();
