(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  const speedNames = { slow: '偏慢', normal: '正常', fast: '偏快' };
  let active = false, generation = 0, classes = [], students = [], editing = null;

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
      active = false; $('studentPanel').hidden = true; $('topbarInfo').textContent = '';
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
      const state = element('span', student.isActive ? '已启用' : '已停用', 'sm-state'); state.dataset.active = String(student.isActive); card.append(state);
      const actions = element('div', undefined, 'sm-actions');
      const edit = element('button', '编辑', 'adm-btn adm-btn-secondary adm-btn-sm'); edit.type = 'button';
      edit.addEventListener('click', () => openForm(student)); actions.append(edit);
      const toggle = element('button', student.isActive ? '停用' : '重新启用', `adm-btn adm-btn-secondary adm-btn-sm${student.isActive ? ' sm-danger' : ''}`);
      toggle.type = 'button'; toggle.addEventListener('click', () => toggleActive(student, toggle)); actions.append(toggle); card.append(actions);
      $('studentList').append(card);
    }
  }
  async function loadStudents() {
    if (!active) return;
    const sequence = ++generation; clearStudents(); message('正在加载学生…'); $('retryButton').hidden = true;
    try {
      const data = await api.students({ classId: $('classFilter').value, query: $('nameSearch').value.trim() });
      if (sequence !== generation) return;
      if (!data || !Array.isArray(data.classes) || !Array.isArray(data.students)) throw new Error('学生服务返回无效数据');
      classes = data.classes; students = data.students; renderClassOptions($('classFilter'), true); render(); message('');
    } catch (error) { if (sequence === generation) failure(error); }
  }
  async function start() {
    const sequence = ++generation; clearStudents(); message('正在验证作业访问权限…');
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
    $('studentClass').value = student ? student.classId : (classes[0] ? classes[0].id : '');
    $('studentSpeed').value = student && Object.hasOwn(speedNames, student.speedLevel) ? student.speedLevel : 'normal';
    $('studentFormTitle').textContent = student ? '编辑学生' : '新增学生';
    $('classChangeWarning').hidden = !(student && student.hasCurrentOrFuturePlan);
    $('studentClass').disabled = !!(student && student.hasCurrentOrFuturePlan);
    $('studentDialog').showModal();
  }
  function closeForm() { editing = null; $('studentDialog').close(); }
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
    ++generation; active = false; clearStudents(); $('studentPanel').hidden = true; $('topbarInfo').textContent = '';
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
