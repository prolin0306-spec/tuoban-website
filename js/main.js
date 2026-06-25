(() => {
  'use strict';

  const ENV_ID = 'tuoban-booking-d6g862sk51b7dbb40';

  // ========== Toast ==========
  const showToast = (message, type = 'success') => {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') toast.style.background = '#EF4444';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  };

  // ========== 通用 UI 逻辑 ==========
  const header = document.getElementById('header');
  const nav = document.getElementById('nav');
  const menuToggle = document.getElementById('menuToggle');
  const backToTop = document.getElementById('backToTop');
  const navLinks = document.querySelectorAll('.nav-link');

  const handleScroll = () => {
    const scrollY = window.scrollY;
    header.classList.toggle('scrolled', scrollY > 10);
    backToTop.classList.toggle('visible', scrollY > 500);
    updateActiveNav();
  };

  const updateActiveNav = () => {
    const sections = document.querySelectorAll('section[id]');
    let current = '';
    sections.forEach((sec) => {
      const top = sec.offsetTop - 120;
      if (window.scrollY >= top) current = sec.getAttribute('id');
    });
    navLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
    });
  };

  menuToggle.addEventListener('click', () => {
    menuToggle.classList.toggle('active');
    nav.classList.toggle('active');
    document.body.style.overflow = nav.classList.contains('active') ? 'hidden' : '';
  });

  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      menuToggle.classList.remove('active');
      nav.classList.remove('active');
      document.body.style.overflow = '';
    });
  });

  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && !menuToggle.contains(e.target) && nav.classList.contains('active')) {
      menuToggle.classList.remove('active');
      nav.classList.remove('active');
      document.body.style.overflow = '';
    }
  });

  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  const animateTargets = [
    '.feature-card', '.service-card', '.subject-card',
    '.teacher-card', '.classroom-card', '.enrollment-card',
    '.contact-form', '.contact-info-item', '.pickup-card'
  ];

  document.querySelectorAll(animateTargets.join(',')).forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  const createLightbox = () => {
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = '<button class="lightbox-close" aria-label="关闭">&times;</button><img class="lightbox-img" src="" alt="">';
    document.body.appendChild(lightbox);
    const img = lightbox.querySelector('.lightbox-img');
    const open = (src, alt) => {
      img.src = src;
      img.alt = alt;
      lightbox.classList.add('open');
      document.body.style.overflow = 'hidden';
    };
    const close = () => {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
      setTimeout(() => { img.src = ''; }, 300);
    };
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox || e.target.classList.contains('lightbox-close')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) close();
    });
    return { open, close };
  };

  const lightbox = createLightbox();

  document.querySelectorAll('.classroom-card').forEach((card) => {
    card.addEventListener('click', () => {
      const img = card.querySelector('.classroom-img');
      lightbox.open(img.src, img.alt);
    });
  });

  // ===================================================================
  //  CloudBase 初始化（线性链，逐级检查，全部成功才绑定 submit）
  // ===================================================================

  const form = document.getElementById('contactForm');
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  function disableButton(text) {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = text;
    }
  }

  function enableButton(text) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = text;
    }
  }

  disableButton('正在连接...');

  // 防止表单原生提交（在 CloudBase 就绪前）
  let cloudbaseReady = false;

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!cloudbaseReady) {
        showToast('系统正在初始化，请稍后', 'error');
        return;
      }
      handleSubmit(e);
    });
  }

  // 整个 CloudBase 链路放在 DOMContentLoaded 之后执行
  function initCloudBase() {
    // --- Step 1: 检查 CloudBase SDK ---
    console.log('━━━━━━━━━━━━━━');
    console.log('CloudBase SDK:');
    console.log('window.cloudbase =', window.cloudbase);

    if (typeof cloudbase === 'undefined') {
      console.error('SDK 未加载');
      disableButton('系统加载失败');
      return;
    }

    console.log('cloudbase.version =', cloudbase.version);
    console.log('cloudbase.cloudbaseConfig =', cloudbase.cloudbaseConfig);

    // --- Step 2: cloudbase.init() ---
    let app;
    try {
      app = cloudbase.init({ env: ENV_ID });
    } catch (err) {
      console.error('cloudbase.init() 异常:', err);
      disableButton('系统初始化失败');
      return;
    }

    console.log('━━━━━━━━━━━━━━');
    console.log('App:');
    console.log('window.app =', app);

    if (!app || !app.config) {
      console.error('app 或 app.config 不存在，停止初始化');
      disableButton('系统初始化失败');
      return;
    }

    console.log('app.config.env =', app.config.env);

    // --- Step 3: database() ---
    let db;
    try {
      db = app.database();
    } catch (err) {
      console.error('app.database() 异常:', err);
      disableButton('系统初始化失败');
      return;
    }

    console.log('━━━━━━━━━━━━━━');
    console.log('Database:');
    console.log('window.db =', db);
    console.log('db.collection =', typeof db.collection);

    if (!db || typeof db.collection !== 'function') {
      console.error('db 或 db.collection 不存在，停止初始化');
      disableButton('系统初始化失败');
      return;
    }

    // --- Step 4: auth() ---
    let auth;
    try {
      auth = app.auth({ persistence: 'local' });
    } catch (err) {
      console.error('app.auth() 异常:', err);
      disableButton('系统初始化失败');
      return;
    }

    console.log('━━━━━━━━━━━━━━');
    console.log('Auth:');
    console.log('window.auth =', auth);

    if (!auth) {
      console.error('auth 为 undefined/null，停止初始化');
      disableButton('系统初始化失败');
      return;
    }

    // --- Step 5: 匿名登录 ---
    console.log('开始匿名登录...');
    auth.signInAnonymously().then((loginResult) => {
      console.log('loginResult =', loginResult);

      console.log('━━━━━━━━━━━━━━');
      console.log('CurrentUser:');
      console.log('window.auth.currentUser =', auth.currentUser);

      // v2 SDK 可能在网络失败时仍 resolve，必须检验 currentUser
      if (!auth.currentUser) {
        console.error('匿名登录失败：auth.currentUser 为 null');
        if (loginResult && loginResult.error) {
          console.error('loginResult.error:', loginResult.error);
        }
        disableButton('连接失败，请刷新');
        showToast('连接失败，请刷新页面后重试', 'error');
        return;
      }

      // --- 全部成功：挂载到 window，绑定真实的 submit ---
      window.app = app;
      window.db = db;
      window.auth = auth;
      window.dbReady = true;

      console.log('━━━━━━━━━━━━━━');
      console.log('dbReady:');
      console.log('window.dbReady =', window.dbReady);
      console.log('━━━━━━━━━━━━━━');
      console.log('ENV:');
      console.log('app.config.env =', app.config.env);
      console.log('━━━━━━━━━━━━━━');

      enableButton('免费预约试托');

      cloudbaseReady = true;

      console.log('CloudBase 初始化完成，表单已就绪');
    }).catch((err) => {
      console.error('匿名登录异常:', err);
      console.error('err.code:', err && err.code);
      console.error('err.message:', err && err.message);
      disableButton('连接失败，请刷新');
      showToast('连接失败，请刷新页面后重试', 'error');
    });
  }

  // --- 真实 submit 逻辑（cloudbaseReady 后才执行） ---
  function handleSubmit(e) {

      // 打印全部状态
      console.log('━━━━ submit 触发 ━━━━');
      console.log('window.app =', window.app);
      console.log('window.db =', window.db);
      console.log('window.auth =', window.auth);
      console.log('window.auth.currentUser =', window.auth && window.auth.currentUser);
      console.log('window.dbReady =', window.dbReady);

      // 逐一校验
      if (!window.app) { showToast('系统错误', 'error'); return; }
      if (!window.db) { showToast('系统错误', 'error'); return; }
      if (!window.auth || !window.auth.currentUser) { showToast('请先登录', 'error'); return; }

      const name = document.getElementById('name').value.trim();
      const phone = document.getElementById('phone').value.trim();

      if (!name || !phone) {
        showToast('请填写家长姓名和联系电话', 'error');
        return;
      }

      if (!/^1\d{10}$/.test(phone)) {
        showToast('请输入正确的手机号码', 'error');
        return;
      }

      const data = {
        name,
        phone,
        grade: document.getElementById('childGrade').value,
        serviceType: document.getElementById('serviceType').value,
        message: document.getElementById('message').value.trim(),
        time: new Date()
      };

      console.log('提交数据:', JSON.stringify(data, null, 2));

      window.db.collection('bookings').add(data).then((result) => {
        console.log('━━━━━━━━━━━━━━');
        console.log('bookings.add() 返回:');
        console.log('result =', result);
        console.log('result.id =', result && result.id);
        console.log('result._id =', result && result._id);
        console.log('━━━━━━━━━━━━━━');

        // v2 SDK add() 返回 { id }，数据库文档中为 _id
        const docId = result && (result.id || result._id);

        if (docId) {
          console.log('写入成功, docId:', docId);
          showToast('提交成功');
          form.reset();
        } else {
          console.error('写入失败: result 中无 id 也无 _id, result:', JSON.stringify(result));
          showToast('提交失败', 'error');
        }
      }).catch((err) => {
        console.error('写入异常:', err);
        console.error('err.code:', err && err.code);
        console.error('err.message:', err && err.message);
        showToast('提交失败', 'error');
      });
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCloudBase);
  } else {
    initCloudBase();
  }
})();
