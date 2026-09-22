(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.createHomeworkAPI = api.createHomeworkAPI;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  class HomeworkError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function createHomeworkAPI(config, sdk) {
    let app, auth, modern = false;
    const expired = () => new HomeworkError('AUTH_REQUIRED', '作业会话已过期或尚未登录，请重新验证');
    function init() {
      if (!config || !config.envId || config.functionName !== 'webHomework' || config.enabled !== true) {
        throw new HomeworkError('NOT_CONFIGURED', '作业后端尚未配置，请联系管理员');
      }
      if (!sdk || typeof sdk.init !== 'function') throw new HomeworkError('UNAVAILABLE', '登录组件未加载，请刷新重试');
      if (!app) {
        app = sdk.init({ env: config.envId, region: 'ap-shanghai' });
        modern = !!(app.auth && typeof app.auth.signInWithPassword === 'function');
        auth = modern ? app.auth : app.auth({ persistence: 'local' });
        if (!modern && typeof auth.signInWithUsernameAndPassword !== 'function') throw new HomeworkError('UNAVAILABLE', '登录组件版本不兼容');
      }
    }
    async function invoke(action, params = {}) {
      init();
      let state;
      try { state = modern ? await auth.getSession() : await auth.getLoginState(); } catch (_) { throw expired(); }
      if (modern) {
        if (!state || state.error || !state.data || !state.data.session) throw expired();
      } else if (!state || state.isAnonymousAuth || state.loginType === 'ANONYMOUS') throw expired();
      let response;
      try { response = await app.callFunction({ name: 'webHomework', data: { action, ...params } }); }
      catch (e) {
        if (/AUTH|TOKEN|CREDENTIAL|LOGIN/i.test(String(e && e.code || ''))) throw expired();
        throw new HomeworkError('UNAVAILABLE', '作业服务连接失败，请重试或联系管理员');
      }
      const result = response && response.result;
      if (!result || typeof result.code !== 'string') throw new HomeworkError('UNAVAILABLE', '作业服务返回无效数据');
      if (result.code !== 'OK') {
        const messages = {
          AUTH_REQUIRED: '作业会话已过期，请重新验证',
          TEACHER_UNLINKED: '账号尚未关联作业老师或关联已停用，请联系管理员',
          TEACHER_DISABLED: '作业老师未启用，请联系管理员',
          FORBIDDEN: '无权查看该班级或作业数据',
          NOT_CONFIGURED: '作业后端尚未正确配置，请联系管理员',
          BAD_REQUEST: '提交字段无效，请检查后重试', DATA_CHANGED: '数据发生变化，请重试',
          DATA_LIMIT: '数据量超出单次读取范围，请联系管理员',
          NOT_FOUND: '学生或作业本不存在或已停用',
          PLAN_EXISTS: '当天已有计划，不能重复生成',
          PLAN_REQUIRED: '当天没有该作业计划，不能录入',
          NO_WORKDAYS: '已无剩余工作日，无法生成计划',
          NO_TASKS: '没有可生成的剩余作业',
          FUTURE_DATE: '不能录入未来日期',
          DATA_INVALID: '作业本总量或已完成量异常，请先核对数据',
          AMOUNT_OUT_OF_RANGE: '保存后总完成量会超出作业本总量范围',
          CLASS_CHANGE_BLOCKED: '学生已有今天或未来计划，V1 禁止调整班级',
          CLASS_EXISTS: '同名同年级班级已存在',
          CLASS_HAS_ACTIVE_STUDENTS: '班级仍有启用学生，请先停用这些学生',
          NO_ACTIVE_STUDENTS: '当前班级没有可批量录入的启用学生',
          BOOK_HAS_PLAN: '该作业已有计划或完成记录，请在对应日期按计划录入'
        };
        throw new HomeworkError(result.code, messages[result.code] || '作业服务暂不可用，请重试');
      }
      return result.data;
    }
    return Object.freeze({
      async login(username, password) {
        init();
        if (!username.trim() || !password) throw new HomeworkError('LOGIN_FAILED', '请输入账号和密码');
        try {
          const result = modern ? await auth.signInWithPassword({ username: username.trim(), password }) :
            await auth.signInWithUsernameAndPassword(username.trim(), password);
          if (modern && result && result.error) throw result.error;
        }
        catch (_) { throw new HomeworkError('LOGIN_FAILED', '验证失败，请检查账号、密码或联系管理员确认登录服务'); }
        return invoke('session');
      },
      session: () => invoke('session'),
      classes: () => invoke('classes'),
      managedClasses: () => invoke('managedClasses'),
      createClass: value => invoke('createClass', value),
      updateClass: value => invoke('updateClass', value),
      setClassActive: (classId, isActive) => invoke('setClassActive', { classId, isActive }),
      workspace: (classId, date) => invoke('workspace', { classId, date }),
      students: filters => invoke('students', filters || {}),
      createStudent: student => invoke('createStudent', student),
      updateStudent: student => invoke('updateStudent', student),
      setStudentActive: (studentId, isActive) => invoke('setStudentActive', { studentId, isActive }),
      feedbackChildren: phone => invoke('feedbackChildren', { phone }),
      linkFeedbackChild: value => invoke('linkFeedbackChild', value),
      unlinkFeedbackChild: value => invoke('unlinkFeedbackChild', value),
      createBook: book => invoke('createBook', book),
      createClassBooks: value => invoke('createClassBooks', value),
      createBookList: value => invoke('createBookList', value),
      setBookComplete: value => invoke('setBookComplete', value),
      generateTodayPlan: studentId => invoke('generateTodayPlan', { studentId }),
      saveDailyRecord: record => invoke('saveDailyRecord', record),
      async logout() {
        init();
        try { const result = await auth.signOut(); if (modern && result && result.error) throw result.error; }
        catch (_) { throw new HomeworkError('LOGOUT_FAILED', '注销未完成，请重试；如需立即停用账号请联系管理员'); }
      },
      onExpired(callback) { init(); if (!modern && typeof auth.onLoginStateExpired === 'function') auth.onLoginStateExpired(callback); }
    });
  }
  return { createHomeworkAPI, HomeworkError };
});
