(() => {
  'use strict';

  const ENV_ID = 'tuoban-booking-d6g862sk51b7dbb40';

  let _db = null;
  let _ready = false;

  const init = () => {
    if (typeof cloudbase === 'undefined') {
      console.error('CloudBase SDK 未加载');
      return;
    }

    let app;
    try { app = cloudbase.init({ env: ENV_ID }); }
    catch (e) { console.error('init 失败:', e); return; }

    try { _db = app.database(); }
    catch (e) { console.error('database 失败:', e); return; }

    const auth = app.auth({ persistence: 'local' });
    auth.signInAnonymously().then(() => {
      if (!auth.currentUser) { console.error('匿名登录失败'); return; }
      _ready = true;
      window.adminApp = app;
      window.adminDb = _db;
      window.adminReady = true;
      console.log('CloudBase 后台就绪');
    }).catch((e) => { console.error('匿名登录异常:', e); });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
