(() => {
  'use strict';
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  const legacy = window.adminAPI;
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function roster() {
    const classId = new URLSearchParams(location.search).get('classId');
    const data = await api.feedbackStudents(classId ? { classId } : {});
    if (!data || !Array.isArray(data.students)) throw new Error('学生名单返回无效，请刷新重试');
    const errorBox = document.getElementById('feedbackRosterError'); if (errorBox) errorBox.remove();
    return data.students;
  }
  async function student(childId) {
    const rows = await roster();
    return rows.find(row => row.feedbackLinked && row._id === childId) || null;
  }
  async function requireStudent(childId) {
    if (!childId || !await student(childId)) throw new Error('学生已停用、未关联或不在当前授权班级，请刷新名单');
  }
  legacy.getStudents = roster;
  legacy.getStudent = student;
  // Recheck the roster before each existing feedback read/write; retain original child IDs.
  for (const name of ['getReport', 'getMistakes']) {
    const original = legacy[name].bind(legacy);
    legacy[name] = async childId => { await requireStudent(childId); return original(childId); };
  }
  for (const name of ['saveReport', 'saveMistake']) {
    const original = legacy[name].bind(legacy);
    legacy[name] = async value => { await requireStudent(value.childId); return original(value); };
  }
  function showError(error) {
    window.showToast(error.message || '名单加载失败，请重试', 'error');
    let box = document.getElementById('feedbackRosterError');
    if (!box) {
      box = document.createElement('div'); box.id = 'feedbackRosterError'; box.className = 'adm-card'; box.setAttribute('role', 'alert');
      document.querySelector('.adm-content').prepend(box);
    }
    box.replaceChildren(); const text = document.createElement('p'); text.textContent = error.message || '名单加载失败，请重试';
    const link = document.createElement('a'); link.href = 'homework.html'; link.textContent = '前往作业管理验证账号';
    box.append(text, link);
  }
  const refresh = () => document.dispatchEvent(new Event('feedback-roster-refresh'));
  document.getElementById('refreshFeedbackStudents').addEventListener('click', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('storage', event => { if (event.key === 'homework-students-revision') refresh(); });
  window.feedbackRoster = { escape, showError };
})();
