(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  const speedNames = { slow: '偏慢', normal: '正常', fast: '偏快' };
  let active = false, generation = 0, lookupSequence = 0, classes = [], students = [], editing = null, feedbackChildren = [];
  let requestedClassId = new URLSearchParams(window.location.search).get('classId') || '';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function message(text, type) {
    const area = $('studentStatus'); area.replaceChildren();
    if (text) { const node = element('p', text, 'hw-notice'); node.dataset.type = type || 'info'; area.append(node); }
  }
  function clearStudents() {
    students = []; $('studentList').replaceChildren(); $('studentSummary').textContent = '';
  }
  function failure(error) {
    clearStudents(); message(error.message || '加载失败，请重试', 'error');
    const authError = error.code === 'AUTH_REQUIRED';
    $('loginPanel').hidden = !authError; $('retryButton').hidden = authError;
    if (authError || ['TEACHER_DISABLED', 'TEACHER_UNLINKED', 'FORBIDDEN'].includes(error.code)) {
      active = false; feedbackChildren = []; $('studentPanel').hidden = true; $('topbarInfo').textContent = '';
    }
  }
  function renderClassOptions(select, includeAll) {
    const current = select.value; select.replaceChildren();
    if (includeAll) { const option = element('option', '全部获授权班级'); option.value = ''; select.append(option); }
    for (const cls of classes) { const option = element('option', cls.name || '未命名班级'); option.value = cls.id; select.append(option); }
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }
  function metadata(label, value) {
    const item = element('dl', undefined, 'sm-meta'); item.append(element('dt', label), element('dd', value)); return item;
  }
  function render() {
    $('studentList').replaceChildren();
    const activeCount = students.filter(student => student.isActive).length;
    $('studentSummary').textContent = `${students.length} 位学生 · ${activeCount} 位启用 · ${students.length - activeCount} 位停用`;
    if (!students.length) { $('studentList').append(element('p', '没有符合条件的学生', 'adm-card sm-empty')); return; }
    for (const student of students) {
      const card = element('article', undefined, 'adm-card sm-student'); card.dataset.studentId = student.id;
      card.append(element('div', student.name || '未命名学生', 'sm-name'));
      card.append(metadata('年级', student.grade || '未填写'));
      card.append(metadata('班级', student.className || '未命名班级'));
      card.append(metadata('速度', `${speedNames[student.speedLevel] || '正常'}（${student.speedCoefficient}）`));
      card.append(metadata('作业本', `${student.bookCount} 本`));
      const linkedChild = feedbackChildren.find(child => child.id === student.feedbackChildId);
      card.append(metadata('家长反馈', student.feedbackChildId ? (linkedChild ? `已关联：${linkedChild.name}` : '已关联') : '未关联'));
      const state = element('span', student.isActive ? '已启用' : '已停用', 'sm-state'); state.dataset.active = String(student.isActive); card.append(state);
      const actions = element('div', undefined, 'sm-actions');
      const edit = element('button', '编辑', 'adm-btn adm-btn-secondary adm-btn-sm'); edit.type = 'button';
      edit.addEventListener('click', () => openForm(student)); actions.append(edit);
      const toggle = element('button', student.isActive ? '停用' : '重新启用', `adm-btn adm-btn-secondary adm-btn-sm${student.isActive ? ' sm-danger' : ''}`);
      toggle.type = 'button'; toggle.addEventListener('click', () => toggleActive(student, toggle)); actions.append(toggle); card.append(actions);
      const link = element('button', student.feedbackChildId ? '解除反馈关联' : '关联家长反馈', 'adm-btn adm-btn-secondary adm-btn-sm');
      link.type = 'button';
      link.addEventListener('click', () => student.feedbackChildId ? unlinkFeedbackChild(student, link) : openFeedbackLink(student));
      actions.append(link);
      $('studentList').append(card);
    }
  }
  async function loadStudents() {
    if (!active) return;
    const sequence = ++generation; clearStudents(); message('正在加载学生…'); $('retryButton').hidden = true;
    try {
      const selectedClassId = $('classFilter').value || (!classes.length ? requestedClassId : '');
      const data = await api.students({ classId: selectedClassId, query: $('nameSearch').value.trim() });
      if (sequence !== generation) return;
      if (!data || !Array.isArray(data.classes) || !Array.isArray(data.students)) throw new Error('学生服务返回无效数据');
      classes = data.classes; students = data.students; renderClassOptions($('classFilter'), true);
      if (requestedClassId && classes.some(cls => cls.id === requestedClassId)) $('classFilter').value = requestedClassId;
      $('classHomeworkLink').hidden = !$('classFilter').value;
      if ($('classFilter').value) $('classHomeworkLink').href = `homework.html?classId=${encodeURIComponent($('classFilter').value)}`;
      requestedClassId = ''; render(); message('');
    } catch (error) { if (sequence === generation) failure(error); }
  }
  async function start() {
    const sequence = ++generation; clearStudents(); feedbackChildren = []; message('正在验证作业访问权限…');
    $('retryButton').hidden = true; $('studentPanel').hidden = true;
    try {
      const session = await api.session();
      if (sequence !== generation) return;
      if (!session || !session.teacher) throw new Error('学生服务返回无效数据');
      active = true; $('loginPanel').hidden = true; $('studentPanel').hidden = false;
      $('topbarInfo').textContent = session.teacher.name || '已验证老师'; await loadStudents();
      if (!classes.length) { $('addButton').disabled = true; message('暂无可管理班级，请联系管理员分配班级或代班权限'); }
      else $('addButton').disabled = false;
    } catch (error) { if (sequence === generation) failure(error); }
  }
  function openForm(student) {
    editing = student || null; renderClassOptions($('studentClass'), false);
    $('studentId').value = student ? student.id : '';
    $('studentName').value = student ? student.name : '';
    $('studentGrade').value = student ? student.grade : '';
    $('studentClass').value = student ? student.classId : ($('classFilter').value || (classes[0] ? classes[0].id : ''));
    $('studentSpeed').value = student && Object.hasOwn(speedNames, student.speedLevel) ? student.speedLevel : 'normal';
    $('studentFormTitle').textContent = student ? '编辑学生' : '新增学生';
    $('classChangeWarning').hidden = !(student && student.hasCurrentOrFuturePlan);
    $('studentClass').disabled = !!(student && student.hasCurrentOrFuturePlan);
    $('studentDialog').showModal();
  }
  function closeForm() { editing = null; $('studentDialog').close(); }
  function openFeedbackLink(student) {
    ++lookupSequence; feedbackChildren = []; $('feedbackPhone').value = '';
    $('feedbackLookupStatus').textContent = '输入家长手机号后查找，并核对要关联的孩子。';
    $('feedbackChildSelect').replaceChildren(); $('saveFeedbackLinkButton').disabled = true;
    $('linkStudentId').value = student.id;
    $('linkStudentName').textContent = `作业学生：${student.name} · ${student.className}`;
    $('feedbackLinkDialog').showModal();
  }
  async function findFeedbackChild() {
    const phone = $('feedbackPhone').value.trim();
    if (!/^1\d{10}$/.test(phone)) { $('feedbackLookupStatus').textContent = '请输入正确的 11 位家长手机号'; return; }
    const sequence = ++lookupSequence, button = $('findFeedbackChildButton');
    button.disabled = true; $('feedbackChildSelect').replaceChildren(); $('saveFeedbackLinkButton').disabled = true;
    $('feedbackLookupStatus').textContent = '正在查找…';
    try {
      const rows = await api.feedbackChildren(phone);
      if (sequence !== lookupSequence || !$('feedbackLinkDialog').open) return;
      feedbackChildren = Array.isArray(rows) ? rows : [];
      const used = new Set(students.map(row => row.feedbackChildId).filter(Boolean));
      const available = feedbackChildren.filter(row => !used.has(row.id));
      if (!available.length) { $('feedbackLookupStatus').textContent = '未找到可关联的每日反馈学生，请核对手机号或现有关联'; return; }
      const select = $('feedbackChildSelect');
      const blank = element('option', '请选择并核对每日反馈学生'); blank.value = ''; select.append(blank);
      for (const child of available) {
        const option = element('option', `${child.name} · ${child.className || '班级未填写'} · 手机尾号 ${child.phoneSuffix || '未知'}`);
        option.value = child.id; select.append(option);
      }
      $('feedbackLookupStatus').textContent = `找到 ${available.length} 位孩子，请核对姓名后选择。`;
      $('saveFeedbackLinkButton').disabled = false;
    } catch (error) { if (sequence === lookupSequence) $('feedbackLookupStatus').textContent = error.message || '查找失败，请重试'; }
    finally { if (sequence === lookupSequence) button.disabled = false; }
  }
  async function saveFeedbackLink(event) {
    event.preventDefault();
    const student = students.find(row => row.id === $('linkStudentId').value);
    const child = feedbackChildren.find(row => row.id === $('feedbackChildSelect').value);
    const phone = $('feedbackPhone').value.trim();
    if (!student || !child || !/^1\d{10}$/.test(phone) || child.phoneSuffix !== phone.slice(-4)) {
      $('feedbackLookupStatus').textContent = '请重新查找并选择有效的学生关联'; return;
    }
    if (!window.confirm(`请再次核对：将作业学生“${student.name} · ${student.className}”关联到家长反馈“${child.name} · ${child.className} · 手机尾号 ${child.phoneSuffix}”？`)) return;
    const button = $('saveFeedbackLinkButton'); button.disabled = true;
    try {
      await api.linkFeedbackChild({ studentId: student.id, childId: child.id, phone });
      $('feedbackLinkDialog').close(); await loadStudents(); message('家长反馈学生关联已保存');
    } catch (error) { message(error.message || '关联失败，请重试', 'error'); }
    finally { button.disabled = false; }
  }
  async function unlinkFeedbackChild(student, button) {
    if (!window.confirm(`确认解除“${student.name}”与家长每日反馈的关联？家长将暂时无法查看该学生的作业情况，历史作业不会删除。`)) return;
    button.disabled = true;
    try { await api.unlinkFeedbackChild({ studentId: student.id, childId: student.feedbackChildId }); await loadStudents(); message('家长反馈关联已解除，历史作业保持不变'); }
    catch (error) { message(error.message || '解除关联失败，请重试', 'error'); }
    finally { button.disabled = false; }
  }
  async function saveStudent(event) {
    event.preventDefault();
    const name = $('studentName').value.trim(), grade = $('studentGrade').value.trim();
    const classId = $('studentClass').value, speedLevel = $('studentSpeed').value;
    if (!name || !grade || !classId) { message('姓名、年级和班级均为必填项', 'error'); return; }
    const wasEditing = !!editing, target = classes.find(cls => cls.id === classId);
    const detail = wasEditing ? `确认保存学生“${name}”的修改？` : `确认新增学生“${name}”到“${target ? target.name : '所选班级'}”？`;
    if (!window.confirm(detail)) return;
    const button = $('saveStudentButton'); button.disabled = true;
    try {
      if (wasEditing) await api.updateStudent({ studentId: editing.id, name, grade, classId, speedLevel });
      else await api.createStudent({ name, grade, classId, speedLevel });
      closeForm(); await loadStudents(); message(wasEditing ? '学生信息已更新' : '学生已新增');
    } catch (error) { message(error.message || '保存失败，请重试', 'error'); }
    finally { button.disabled = false; }
  }
  async function toggleActive(student, button) {
    const action = student.isActive ? '停用' : '重新启用';
    const warning = student.isActive ? '停用不会删除历史作业记录；停用后不能新增作业本、生成计划或录入完成量。' : '重新启用后会保留全部历史作业记录。';
    if (!window.confirm(`${warning}\n\n确认${action}“${student.name}”？`)) return;
    button.disabled = true;
    try { await api.setStudentActive(student.id, !student.isActive); await loadStudents(); message(`已${action}“${student.name}”；历史作业记录保持不变`); }
    catch (error) { message(error.message || `${action}失败，请重试`, 'error'); }
    finally { button.disabled = false; }
  }

  window.homeworkLogout = async () => {
    ++generation; active = false; clearStudents(); feedbackChildren = []; $('studentPanel').hidden = true; $('topbarInfo').textContent = '';
    try { await api.logout(); $('loginPanel').hidden = false; $('retryButton').hidden = true; message('作业账号已退出'); }
    catch (error) { message(error.message, 'error'); }
  };
  $('homeworkLogin').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('loginButton'); button.disabled = true; message('正在验证账号…');
    try { await api.login($('homeworkUsername').value, $('homeworkPassword').value); await start(); }
    catch (error) { failure(error); $('loginPanel').hidden = false; }
    finally { $('homeworkPassword').value = ''; button.disabled = false; }
  });
  $('studentForm').addEventListener('submit', saveStudent);
  $('feedbackLinkForm').addEventListener('submit', saveFeedbackLink);
  $('findFeedbackChildButton').addEventListener('click', findFeedbackChild);
  $('feedbackPhone').addEventListener('input', () => { ++lookupSequence; feedbackChildren = []; $('feedbackChildSelect').replaceChildren(); $('saveFeedbackLinkButton').disabled = true; $('feedbackLookupStatus').textContent = '手机号已更改，请重新查找'; });
  $('cancelFeedbackLinkButton').addEventListener('click', () => $('feedbackLinkDialog').close());
  $('closeFeedbackLinkButton').addEventListener('click', () => $('feedbackLinkDialog').close());
  $('addButton').addEventListener('click', () => openForm(null));
  $('cancelButton').addEventListener('click', closeForm); $('closeDialogButton').addEventListener('click', closeForm);
  $('searchButton').addEventListener('click', loadStudents); $('refreshButton').addEventListener('click', loadStudents);
  $('classFilter').addEventListener('change', loadStudents);
  $('nameSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadStudents(); } });
  $('sidebarToggle').addEventListener('click', () => setTimeout(() => $('sidebarToggle').setAttribute('aria-expanded', String($('sidebar').classList.contains('open'))), 0));
  $('retryButton').addEventListener('click', start); window.initSidebar('homework-students.html');
  try { api.onExpired(() => { ++generation; failure({ code: 'AUTH_REQUIRED', message: '作业会话已过期，请重新验证' }); }); }
  catch (error) { failure(error); }
  start();
})();
