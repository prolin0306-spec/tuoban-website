(() => {
  'use strict';

  const STORAGE_KEY = 'admin_teacher';

  window.adminAuth = {
    login(username, password) {
      return window.adminDb.collection('teachers')
        .where({ username, password })
        .get()
        .then((res) => {
          if (!res.data || res.data.length === 0) return null;
          const t = res.data[0];
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
            id: t._id,
            name: t.name || t.username,
            time: Date.now()
          }));
          return t;
        });
    },

    logout() {
      sessionStorage.removeItem(STORAGE_KEY);
      window.location.href = 'login.html';
    },

    check() {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },

    guard() {
      const s = this.check();
      if (!s) {
        window.location.href = 'login.html';
        return null;
      }
      return s;
    }
  };

})();
