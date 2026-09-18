(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  let generation = 0, active = false;
  const statuses = { unrecorded: '未记录', zero: '已记录：完成量为 0', partial: '部分完成', completed: '已完成', recorded: '已有实际记录', invalid: '记录数据不足', conflict: '数据需核对' };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const percent = value => finite(value) ? `${Math.round(value * 10000) / 100}%` : '数据不足';
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function message(text, type) {
    const area = $('homeworkStatus'); area.replaceChildren();
    if (text) { const el = element('p', text, 'hw-notice'); el.dataset.type = type || 'info'; area.append(el); }
  }
  function clearData() {
    $('studentCards').replaceChildren(); $('homeworkSummary').textContent = '';
  }
  function failure(error) {
    clearData(); message(error.message || '加载失败，请重试', 'error');
    const authError = error.code === 'AUTH_REQUIRED';
    $('loginPanel').hidden = !authError;
    $('retryButton').hidden = authError;
    if (authError || ['TEACHER_DISABLED', 'TEACHER_UNLINKED', 'FORBIDDEN'].includes(error.code)) {
      active = false; $('workspacePanel').hidden = true; $('topbarInfo').textContent = '';
      // A linked account may change only after an explicit platform sign-out.
    }
  }
  function render(data) {
    if (!data || !Array.isArray(data.students)) throw new Error('作业服务返回无效数据');
    clearData();
    $('homeworkSummary').textContent = `${data.className || '未命名班级'} · ${data.date} · ${data.students.length} 位学生 · ${data.summary.taskCount} 项任务 · ${data.summary.recordedTaskCount} 项有实际记录。按红、黄、绿及优先级降序排列，数据不足置后。实际完成率按负载计算；预计完成率用于学期预测。`;
    if (!data.students.length) { $('studentCards').append(element('p', '该班级暂无学生', 'adm-card hw-empty')); return; }
    for (const student of data.students) {
      const card = element('details', undefined, 'adm-card hw-student');
      const rate = student.projection && student.projection.rate;
      const color = student.projection && student.projection.color || 'unknown';
      const colorNames = { red: '红色预警', yellow: '黄色预警', green: '进度正常', unknown: '预警数据不足' };
      card.dataset.color = color;
      card.append(element('summary', `${student.name || '未命名'} · ${student.grade || '年级未填写'}`));
      const metrics = element('div', undefined, 'hw-metrics');
      metrics.append(element('p', colorNames[color] || colorNames.unknown, 'hw-risk'));
      metrics.append(element('p', `优先级：${finite(student.priorityScore) ? student.priorityScore.toFixed(2) + '（分数越高越优先）' : '数据不足'}`));
      if (!finite(student.priorityScore) && student.projection && student.projection.priorityReason) {
        metrics.append(element('p', student.projection.priorityReason, 'hw-muted'));
      }
      metrics.append(element('p', `预计完成率（学期）：${percent(rate)}`));
      metrics.append(element('p', `实际完成率（所选日计划，按负载）：${finite(student.actualRate) ? percent(student.actualRate) : student.actualRateReason || '数据不足'}`));
      if (!finite(rate)) metrics.append(element('p', student.projection && student.projection.reason || '预测信息不足', 'hw-muted'));
      for (const alert of student.projection && student.projection.alerts || []) {
        metrics.append(element('p', alert.message, 'hw-alert'));
      }
      card.append(metrics);
      if (!student.hasPlan) card.append(element('p', '尚未生成计划', 'hw-notice'));
      const tasks = element('ul', undefined, 'hw-tasks');
      for (const task of student.tasks) {
        const row = element('li', undefined, 'hw-task');
        row.append(element('h3', task.bookName || '作业本信息缺失'));
        const values = element('div', undefined, 'hw-task-values');
        values.append(element('span', `计划：${finite(task.planned) ? task.planned + ' ' + task.unit : '尚未生成计划'}`));
        const missingActual = task.status === 'unrecorded' ? '未记录' : '数据需核对';
        values.append(element('span', `实际：${finite(task.actual) ? task.actual + ' ' + task.unit : missingActual}`));
        row.append(values, element('p', statuses[task.status] || '状态待核对'));
        if (task.warning) row.append(element('p', task.warning, 'hw-muted'));
        tasks.append(row);
      }
      card.append(tasks); $('studentCards').append(card);
    }
  }
  async function loadWorkspace() {
    if (!active || !$('classSelect').value) return;
    const seq = ++generation;
    clearData(); message('正在加载任务与实际记录…'); $('retryButton').hidden = true;
    $('studentCards').setAttribute('aria-busy', 'true');
    try {
      const data = await api.workspace($('classSelect').value, $('dateSelect').value);
      if (seq !== generation) return;
      render(data); message('');
    } catch (e) { if (seq === generation) failure(e); }
    finally { if (seq === generation) $('studentCards').setAttribute('aria-busy', 'false'); }
  }
  async function start() {
    const seq = ++generation;
    clearData(); message('正在验证作业访问权限…'); $('retryButton').hidden = true;
    $('workspacePanel').hidden = true;
    try {
      const session = await api.session();
      const classes = await api.classes();
      if (seq !== generation) return;
      if (!session || !session.teacher || !Array.isArray(classes)) throw new Error('作业服务返回无效数据');
      active = true; $('loginPanel').hidden = true;
      $('topbarInfo').textContent = session.teacher.name || '已验证老师';
      $('classSelect').replaceChildren();
      for (const cls of classes) { const option = element('option', cls.name || '未命名班级'); option.value = cls.id; $('classSelect').append(option); }
      if (!classes.length) { message('暂无授权班级，请联系管理员分配班级或代班权限'); return; }
      $('workspacePanel').hidden = false; await loadWorkspace();
    } catch (e) { if (seq === generation) failure(e); }
  }
  window.homeworkLogout = async () => {
    ++generation; active = false; clearData(); $('workspacePanel').hidden = true; $('topbarInfo').textContent = '';
    try { await api.logout(); $('loginPanel').hidden = false; $('retryButton').hidden = true; message('作业账号已退出'); }
    catch (e) { message(e.message, 'error'); }
  };
  $('homeworkLogin').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('loginButton'); button.disabled = true;
    message('正在验证账号…');
    try { await api.login($('homeworkUsername').value, $('homeworkPassword').value); await start(); }
    catch (e) { failure(e); $('loginPanel').hidden = false; }
    finally { $('homeworkPassword').value = ''; button.disabled = false; }
  });
  $('retryButton').addEventListener('click', start);
  $('refreshButton').addEventListener('click', loadWorkspace);
  $('classSelect').addEventListener('change', loadWorkspace);
  $('dateSelect').addEventListener('change', loadWorkspace);
  $('sidebarToggle').addEventListener('click', () => {
    setTimeout(() => $('sidebarToggle').setAttribute('aria-expanded', String($('sidebar').classList.contains('open'))), 0);
  });
  $('dateSelect').value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  window.initSidebar('homework.html');
  try { api.onExpired(() => { ++generation; failure({ code: 'AUTH_REQUIRED', message: '作业会话已过期，请重新验证' }); }); }
  catch (e) { failure(e); }
  start();
})();
