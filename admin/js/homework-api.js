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
          BAD_REQUEST: '班级或日期无效', DATA_CHANGED: '数据发生变化，请重试',
          DATA_LIMIT: '数据量超出单次读取范围，请联系管理员'
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
      workspace: (classId, date) => invoke('workspace', { classId, date }),
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
