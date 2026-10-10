(() => {
  'use strict';
  const api = window.createHomeworkAPI(window.HOMEWORK_CONFIG, window.cloudbase);
  const allowed = new Set(['dashboard.html','homework.html','students.html','homework-students.html','homework-classes.html']);
  function destination(value) {
    try {
      const url = new URL(value || 'homework.html', location.href);
      const name = url.pathname.split('/').pop();
      if (url.origin !== location.origin || !allowed.has(name) || url.pathname !== new URL(name, location.href).pathname) return 'homework.html';
      const params = new URLSearchParams();
      for (const key of ['classId','studentId','childId','panel']) if (url.searchParams.has(key)) params.set(key,url.searchParams.get(key));
      return name + (params.size ? '?' + params : '');
    } catch (_) { return 'homework.html'; }
  }
  window.adminAuth = Object.freeze({
    login: (username,password) => api.login(username,password),
    session: () => api.session(),
    destination,
    async logout() {
      await api.logout();
      sessionStorage.removeItem('admin_teacher');
      try { localStorage.setItem('admin-auth-logout',String(Date.now())); } catch (_) {}
      location.replace('login.html');
    }
  });
  // The legacy display cache is never accepted as identity.
  sessionStorage.removeItem('admin_teacher');
  window.addEventListener('storage', event => {
    if (event.key === 'admin-auth-logout' && location.pathname.endsWith('/login.html') === false) location.replace('login.html');
  });
})();
