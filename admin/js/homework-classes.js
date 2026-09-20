(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  let active = false, generation = 0, state = { role: '', canCreate: false, canDeactivate: false, classes: [] }, editing = null;
  let openRequested = new URLSearchParams(window.location.search).get('new') === '1';
  function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
  function message(text, type) { const area = $('classStatus'); area.replaceChildren(); if (text) { const node = element('p', text, 'hw-notice'); node.dataset.type = type || 'info'; area.append(node); } }
  function failure(error) {
    $('classList').replaceChildren(); message(error.message || '加载失败，请重试', 'error');
    const authError = error.code === 'AUTH_REQUIRED'; $('loginPanel').hidden = !authError; $('retryButton').hidden = authError;
    if (authError || ['TEACHER_DISABLED', 'TEACHER_UNLINKED', 'FORBIDDEN'].includes(error.code)) { active = false; $('classPanel').hidden = true; $('topbarInfo').textContent = ''; }
  }
  async function run(button, operation, success) {
    if (button.disabled) return; button.disabled = true; message('正在保存…');
    try { const result = await operation(); await loadClasses(); message(typeof success === 'function' ? success(result) : success); return true; }
    catch (error) { message(error.message || '操作失败，请重试', 'error'); return false; }
    finally { button.disabled = false; }
  }
  function render() {
    $('classList').replaceChildren(); $('addClassButton').hidden = !state.canCreate;
    $('classSummary').textContent = `${state.classes.length} 个可管理班级；负责人可停用空班级，历史数据不会删除。`;
    if (!state.classes.length) { $('classList').append(element('p', '暂无可管理班级', 'adm-card cm-empty')); return; }
    for (const cls of state.classes) {
      const card = element('article', undefined, 'adm-card cm-class'); card.dataset.classId = cls.id; card.dataset.active = String(cls.isActive);
      const heading = element('div', undefined, 'cm-class-heading'); heading.append(element('h2', cls.name || '未命名班级'), element('span', cls.isActive ? '已启用' : '已停用', 'cm-state'));
      const metrics = element('div', undefined, 'cm-metrics');
      metrics.append(element('span', `年级：${cls.grade || '未填写'}`), element('span', `学生：${cls.activeStudentCount}/${cls.studentCount}`),
        element('span', `作业本：${cls.bookCount}`), element('span', `计划：${cls.planCount}`));
      const actions = element('div', undefined, 'cm-actions');
      const edit = element('button', '编辑', 'adm-btn adm-btn-secondary'); edit.type = 'button'; edit.addEventListener('click', () => openDialog(cls)); actions.append(edit);
      if (state.canDeactivate) {
        const toggle = element('button', cls.isActive ? '停用班级' : '重新启用', cls.isActive ? 'adm-btn adm-btn-danger' : 'adm-btn adm-btn-primary'); toggle.type = 'button';
        toggle.addEventListener('click', () => {
          const detail = cls.isActive ? `确认停用“${cls.name}”？仅空班级可以停用，且不会删除历史数据。` : `确认重新启用“${cls.name}”？`;
          if (!window.confirm(detail)) return;
          run(toggle, () => api.setClassActive(cls.id, !cls.isActive), cls.isActive ? '班级已停用，历史数据保持不变' : '班级已重新启用');
        }); actions.append(toggle);
      }
      card.append(heading, metrics, actions); $('classList').append(card);
    }
  }
  async function loadClasses() {
    if (!active) return; const sequence = ++generation; message('正在加载班级…'); $('classList').setAttribute('aria-busy', 'true');
    try {
      const data = await api.managedClasses(); if (sequence !== generation) return; if (!data || !Array.isArray(data.classes)) throw new Error('班级服务返回无效数据');
      state = data; render();
      if (openRequested) { openRequested = false; if (state.canCreate) openDialog(); else message('当前角色不能新增班级', 'error'); }
      else message('');
    }
    catch (error) { if (sequence === generation) failure(error); }
    finally { if (sequence === generation) $('classList').setAttribute('aria-busy', 'false'); }
  }
  function openDialog(cls) {
    editing = cls || null; $('classDialogTitle').textContent = cls ? '编辑班级' : '新增班级'; $('classId').value = cls ? cls.id : '';
    $('className').value = cls ? cls.name : ''; $('classGrade').value = cls ? cls.grade : ''; $('classDialog').showModal(); $('className').focus();
  }
  function closeDialog() { editing = null; $('classDialog').close(); $('classForm').reset(); }
  async function start() {
    const sequence = ++generation; $('classList').replaceChildren(); message('正在验证作业访问权限…'); $('classPanel').hidden = true; $('retryButton').hidden = true;
    try { const session = await api.session(); if (sequence !== generation) return; active = true; $('loginPanel').hidden = true; $('classPanel').hidden = false; $('topbarInfo').textContent = session.teacher.name || '已验证老师'; await loadClasses(); }
    catch (error) { if (sequence === generation) failure(error); }
  }
  window.homeworkLogout = async () => { ++generation; active = false; $('classList').replaceChildren(); $('classPanel').hidden = true; $('topbarInfo').textContent = ''; try { await api.logout(); $('loginPanel').hidden = false; message('作业账号已退出'); } catch (error) { message(error.message, 'error'); } };
  $('homeworkLogin').addEventListener('submit', async event => { event.preventDefault(); const button = $('loginButton'); button.disabled = true; try { await api.login($('homeworkUsername').value, $('homeworkPassword').value); await start(); } catch (error) { failure(error); $('loginPanel').hidden = false; } finally { $('homeworkPassword').value = ''; button.disabled = false; } });
  $('addClassButton').addEventListener('click', () => openDialog()); $('closeDialogButton').addEventListener('click', closeDialog); $('cancelButton').addEventListener('click', closeDialog);
  $('classForm').addEventListener('submit', event => {
    event.preventDefault(); const name = $('className').value.trim(), grade = $('classGrade').value.trim(); if (!name || !grade) { message('班级名称和年级均为必填项', 'error'); return; }
    const wasEditing = !!editing; if (!window.confirm(wasEditing ? `确认保存班级“${name}”的修改？` : `确认新增班级“${name}”？`)) return;
    const button = $('saveClassButton'); run(button, () => wasEditing ? api.updateClass({ classId: editing.id, name, grade }) : api.createClass({ name, grade }), wasEditing ? '班级信息已更新' : '班级已新增').then(saved => { if (saved && $('classDialog').open) closeDialog(); });
  });
  $('retryButton').addEventListener('click', start); $('refreshClassButton').addEventListener('click', loadClasses); $('sidebarToggle').addEventListener('click', () => setTimeout(() => $('sidebarToggle').setAttribute('aria-expanded', String($('sidebar').classList.contains('open'))), 0));
  window.initSidebar('homework-classes.html'); try { api.onExpired(() => { ++generation; failure({ code: 'AUTH_REQUIRED', message: '作业会话已过期，请重新验证' }); }); } catch (error) { failure(error); } start();
})();
