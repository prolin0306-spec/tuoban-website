(() => {
  'use strict';

  // ========== CloudBase 初始化 ==========
  const ENV_ID = 'tuoban-booking-d6g862sk51b7dbb40';

  let db = null;
  let dbReady = false;

  const initCloudBase = () => {
    if (typeof cloudbase === 'undefined') {
      console.error('CloudBase SDK 未加载');
      return;
    }

    let app;
    try {
      app = cloudbase.init({ env: ENV_ID });
    } catch (err) {
      console.error('cloudbase.init() 异常:', err);
      return;
    }

    try {
      db = app.database();
    } catch (err) {
      console.error('app.database() 异常:', err);
      return;
    }

    const auth = app.auth({ persistence: 'local' });
    auth.signInAnonymously().then(() => {
      if (!auth.currentUser) {
        console.error('匿名登录失败');
        return;
      }
      dbReady = true;
      console.log('CloudBase 初始化完成 (daily-feedback)');
    }).catch((err) => {
      console.error('匿名登录异常:', err);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCloudBase);
  } else {
    initCloudBase();
  }

  // ========== 导航 UI 逻辑 ==========
  const header = document.getElementById('header');
  const nav = document.getElementById('nav');
  const menuToggle = document.getElementById('menuToggle');
  const backToTop = document.getElementById('backToTop');

  const handleScroll = () => {
    const scrollY = window.scrollY;
    if (header) header.classList.toggle('scrolled', scrollY > 10);
    if (backToTop) backToTop.classList.toggle('visible', scrollY > 500);
  };

  if (menuToggle && nav) {
    menuToggle.addEventListener('click', () => {
      menuToggle.classList.toggle('active');
      nav.classList.toggle('active');
      document.body.style.overflow = nav.classList.contains('active') ? 'hidden' : '';
    });
  }

  if (nav) {
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        if (menuToggle) menuToggle.classList.remove('active');
        nav.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  }

  document.addEventListener('click', (e) => {
    if (nav && menuToggle && !nav.contains(e.target) && !menuToggle.contains(e.target) && nav.classList.contains('active')) {
      menuToggle.classList.remove('active');
      nav.classList.remove('active');
      document.body.style.overflow = '';
    }
  });

  if (backToTop) {
    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  // ========== DOM 元素 ==========
  const phoneInput = document.getElementById('phoneInput');
  const queryBtn = document.getElementById('queryBtn');
  const reportSection = document.getElementById('reportSection');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');

  // ========== Toast 提示 ==========
  const showToast = (message, type) => {
    const existing = document.querySelector('.df-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'df-toast';
    if (type === 'error') toast.style.background = '#EF4444';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  };

  // ========== 数据映射：CloudBase 文档 → 渲染格式 ==========
  const mapReport = (doc) => ({
    childName: doc.childName || '',
    className: doc.className || doc.class || '',
    updatedAt: doc.updatedAt || doc.date || '',
    attendance: doc.attendance || { status: 'normal', label: '正常到园' },
    meals: Array.isArray(doc.meals) ? doc.meals : [],
    study: Array.isArray(doc.study) ? doc.study : [],
    performance: Array.isArray(doc.performance) ? doc.performance : [],
    comment: doc.comment || ''
  });

  const mapHistoryItem = (doc) => ({
    date: doc.date || '',
    summary: doc.summary || (doc.comment ? doc.comment.slice(0, 20) : ''),
    detail: {
      attendance: (doc.attendance && doc.attendance.label) || '正常到园',
      meals: Array.isArray(doc.meals) ? doc.meals.map((m) => (typeof m === 'string' ? m : (m.meal + ' ' + m.status))).join('，') : '',
      study: Array.isArray(doc.study) ? doc.study.join('、') : '',
      performance: Array.isArray(doc.performance) ? doc.performance.join('，') : '',
      comment: doc.comment || ''
    }
  });

  // ========== 查询处理（CloudBase） ==========
  const handleQuery = () => {
    const phone = phoneInput.value.trim();

    if (!phone) {
      showToast('请输入手机号', 'error');
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      showToast('请输入正确的手机号', 'error');
      return;
    }

    if (!dbReady) {
      showToast('系统正在连接，请稍后重试', 'error');
      return;
    }

    queryBtn.disabled = true;
    queryBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 查询中...';

    // parentPhone 在数据库中为 Number 类型，查询条件必须一致
    db.collection('children').where({ parentPhone: parseInt(phone, 10) }).get()
      .then((res) => {
        if (!res.data || res.data.length === 0) {
          showToast('未找到匹配的孩子信息', 'error');
          queryBtn.disabled = false;
          queryBtn.innerHTML = '<i class="fas fa-search"></i> 立即查询';
          return null;
        }

        const child = res.data[0];
        console.log('找到孩子:', child.name);
        return db.collection('daily_reports')
          .where({ childId: child._id })
          .orderBy('date', 'desc')
          .get()
          .then((reportsRes) => {
            const reports = reportsRes.data || [];
            // 临时诊断：打印 daily_reports 文档的真实字段名
            if (reports.length > 0) {
              console.log('daily_reports 第1条字段名:', Object.keys(reports[0]));
              console.log('daily_reports 第1条完整数据:', JSON.stringify(reports[0], null, 2));
            }
            return { child, reports };
          });
      })
      .then((result) => {
        queryBtn.disabled = false;
        queryBtn.innerHTML = '<i class="fas fa-search"></i> 立即查询';

        if (!result) return;
        const { child, reports } = result;

        if (reports.length === 0) {
          showToast('该孩子暂无反馈记录', 'error');
          reportSection.style.display = 'none';
          historySection.style.display = 'none';
          return;
        }

        const childInfo = {
          childName: child.name || '',
          className: child.class || ''
        };

        const latest = mapReport(Object.assign({}, reports[0], childInfo));
        const history = reports.map((r) => mapHistoryItem(Object.assign({}, r, childInfo)));

        renderReport(latest);
        renderHistory(history);

        reportSection.style.display = 'block';
        historySection.style.display = 'block';

        setTimeout(() => {
          reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      })
      .catch((err) => {
        console.error('查询失败:', err);
        showToast('查询失败，请重试', 'error');
        queryBtn.disabled = false;
        queryBtn.innerHTML = '<i class="fas fa-search"></i> 立即查询';
      });
  };

  // ========== 渲染成长报告 ==========
  const renderReport = (data) => {
    const mealsHTML = (data.meals || []).map((m) =>
      `<div class="df-meal-item">
        <span class="df-meal-name">${m.meal || ''}</span>
        <span class="df-meal-status">${m.status || ''}</span>
      </div>`
    ).join('');

    const studyHTML = (data.study || []).map((s) =>
      `<li class="df-study-item"><i class="fas fa-check-circle"></i> ${s}</li>`
    ).join('');

    const performanceHTML = (data.performance || []).map((p) =>
      `<li class="df-perf-item"><i class="fas fa-star"></i> ${p}</li>`
    ).join('');

    const attendanceLabel = (data.attendance && data.attendance.label) || '正常到园';

    reportSection.innerHTML = `
      <div class="container">
        <div class="df-child-header">
          <div class="df-child-avatar" style="background: linear-gradient(135deg, #2563EB, #3B82F6);">
            <i class="fas fa-child"></i>
          </div>
          <div class="df-child-info">
            <h2 class="df-child-name">${data.childName || ''}</h2>
            <p class="df-child-class"><i class="fas fa-graduation-cap"></i> ${data.className || ''}</p>
            <p class="df-child-updated"><i class="fas fa-clock"></i> 最近更新：${data.updatedAt || ''}</p>
          </div>
        </div>

        <div class="df-cards-grid">
          <div class="df-card">
            <div class="df-card-icon" style="background: var(--primary-light);">
              <i class="fas fa-calendar-check" style="color: var(--primary);"></i>
            </div>
            <h3 class="df-card-title">今日出勤</h3>
            <p class="df-card-value df-attendance-normal">${attendanceLabel}</p>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: var(--secondary-light);">
              <i class="fas fa-utensils" style="color: var(--secondary);"></i>
            </div>
            <h3 class="df-card-title">今日饮食</h3>
            <div class="df-meals-list">${mealsHTML || '<p style="font-size:14px;color:var(--text-light);">暂无数据</p>'}</div>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: var(--accent-light);">
              <i class="fas fa-book-open" style="color: var(--accent);"></i>
            </div>
            <h3 class="df-card-title">学习内容</h3>
            <p class="df-card-subtitle">今天完成：</p>
            <ul class="df-study-list">${studyHTML || '<li style="font-size:14px;color:var(--text-light);">暂无数据</li>'}</ul>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: #EDE9FE;">
              <i class="fas fa-smile" style="color: #7C3AED;"></i>
            </div>
            <h3 class="df-card-title">课堂表现</h3>
            <ul class="df-perf-list">${performanceHTML || '<li style="font-size:14px;color:var(--text-light);">暂无数据</li>'}</ul>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: #FCE7F3;">
              <i class="fas fa-comment-dots" style="color: #EC4899;"></i>
            </div>
            <h3 class="df-card-title">老师评语</h3>
            <p class="df-card-comment">${data.comment || '暂无评语'}</p>
          </div>
        </div>
      </div>
    `;

    reportSection.style.opacity = '0';
    reportSection.style.transform = 'translateY(20px)';
    requestAnimationFrame(() => {
      reportSection.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      reportSection.style.opacity = '1';
      reportSection.style.transform = 'translateY(0)';
    });
  };

  // ========== 渲染历史记录 ==========
  const renderHistory = (history) => {
    const historyHTML = history.map((item, index) => `
      <div class="df-timeline-item">
        <div class="df-timeline-dot"></div>
        <div class="df-timeline-content">
          <div class="df-timeline-header" data-index="${index}">
            <span class="df-timeline-date"><i class="fas fa-calendar-day"></i> ${item.date}</span>
            <span class="df-timeline-summary">${item.summary}</span>
            <span class="df-timeline-toggle"><i class="fas fa-chevron-down"></i></span>
          </div>
          <div class="df-timeline-detail" id="detail-${index}">
            <div class="df-detail-grid">
              <div class="df-detail-item">
                <span class="df-detail-label">出勤</span>
                <span>${item.detail.attendance}</span>
              </div>
              <div class="df-detail-item">
                <span class="df-detail-label">饮食</span>
                <span>${item.detail.meals || '暂无'}</span>
              </div>
              <div class="df-detail-item">
                <span class="df-detail-label">学习</span>
                <span>${item.detail.study || '暂无'}</span>
              </div>
              <div class="df-detail-item">
                <span class="df-detail-label">表现</span>
                <span>${item.detail.performance || '暂无'}</span>
              </div>
              <div class="df-detail-item df-detail-full">
                <span class="df-detail-label">评语</span>
                <span>${item.detail.comment || '暂无评语'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    historyList.innerHTML = historyHTML;

    historyList.querySelectorAll('.df-timeline-header').forEach((headerEl) => {
      headerEl.addEventListener('click', () => {
        const idx = headerEl.getAttribute('data-index');
        const detail = document.getElementById('detail-' + idx);
        const toggle = headerEl.querySelector('.df-timeline-toggle i');

        const isOpen = detail.classList.contains('open');
        detail.classList.toggle('open');
        if (isOpen) {
          toggle.classList.remove('fa-chevron-up');
          toggle.classList.add('fa-chevron-down');
        } else {
          toggle.classList.remove('fa-chevron-down');
          toggle.classList.add('fa-chevron-up');
        }
      });
    });
  };

  // ========== 绑定事件 ==========
  if (queryBtn) {
    queryBtn.addEventListener('click', handleQuery);
  }

  if (phoneInput) {
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleQuery();
    });
  }

})();
