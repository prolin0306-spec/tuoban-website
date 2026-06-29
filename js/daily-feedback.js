(() => {
  'use strict';

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

  // TODO: CloudBase — 后续接入数据库时，将以下模拟数据替换为 CloudBase 查询

  // ========== 模拟数据 ==========
  const mockReport = {
    childName: '曾小明',
    className: '二年级（1）班',
    avatar: 'toban_image/classroom.jpg',
    updatedAt: '2026-06-29 17:30',
    attendance: {
      status: 'normal',
      label: '正常到园',
      icon: 'fa-calendar-check'
    },
    meals: [
      { meal: '早餐', status: '全部吃完' },
      { meal: '午餐', status: '全部吃完' },
      { meal: '下午点心', status: '已食用' }
    ],
    study: [
      '拼音练习',
      '数学口算',
      '阅读训练'
    ],
    performance: [
      '积极参与课堂互动。',
      '认真完成老师布置的任务。'
    ],
    comment: '今天表现很好，课堂专注，积极举手回答问题，与同学相处融洽。'
  };

  const mockHistory = [
    {
      date: '2026-06-29',
      summary: '课堂表现优秀，饮食正常',
      detail: {
        attendance: '正常到园',
        meals: '早餐全部吃完，午餐全部吃完，下午点心已食用',
        study: '拼音练习、数学口算、阅读训练',
        performance: '积极参与课堂互动，认真完成老师布置的任务',
        comment: '今天表现很好，课堂专注，积极举手回答问题，与同学相处融洽。'
      }
    },
    {
      date: '2026-06-28',
      summary: '积极参与活动',
      detail: {
        attendance: '正常到园',
        meals: '早餐全部吃完，午餐全部吃完，下午点心已食用',
        study: '语文阅读、英语单词、手工课',
        performance: '参与课外活动积极，与同学合作愉快',
        comment: '今天在手工课上表现突出，作品很有创意。'
      }
    },
    {
      date: '2026-06-27',
      summary: '午睡良好',
      detail: {
        attendance: '正常到园',
        meals: '早餐全部吃完，午餐剩少许蔬菜，下午点心已食用',
        study: '数学应用题、语文写作、英语听力',
        performance: '午睡质量好，下午精神饱满',
        comment: '数学应用题有进步，继续保持。'
      }
    },
    {
      date: '2026-06-26',
      summary: '课堂专注力提升',
      detail: {
        attendance: '正常到园',
        meals: '早餐全部吃完，午餐全部吃完，下午点心已食用',
        study: '拼音复习、数学口算、阅读训练',
        performance: '专注力明显提升，作业完成速度快',
        comment: '今天在课堂上注意力很集中，值得表扬。'
      }
    },
    {
      date: '2026-06-25',
      summary: '与同学相处融洽',
      detail: {
        attendance: '正常到园',
        meals: '早餐全部吃完，午餐全部吃完，下午点心已食用',
        study: '语文生字、数学练习、英语朗读',
        performance: '主动帮助同学，课间活动文明',
        comment: '与同学相处越来越好了，是个乐于助人的孩子。'
      }
    }
  ];

  // ========== DOM 元素 ==========
  const querySection = document.getElementById('querySection');
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

  // ========== 查询处理 ==========
  const handleQuery = () => {
    const phone = phoneInput.value.trim();

    if (!phone) {
      showToast('请输入手机号。', 'error');
      return;
    }

    // TODO: CloudBase — 替换为数据库查询：db.collection('reports').where({ phone }).get()
    renderReport(mockReport);
    renderHistory(mockHistory);

    reportSection.style.display = 'block';
    historySection.style.display = 'block';

    // 滚动到结果区域
    setTimeout(() => {
      reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  // ========== 渲染成长报告 ==========
  const renderReport = (data) => {
    const mealsHTML = data.meals.map((m) =>
      `<div class="df-meal-item">
        <span class="df-meal-name">${m.meal}</span>
        <span class="df-meal-status">${m.status}</span>
      </div>`
    ).join('');

    const studyHTML = data.study.map((s) =>
      `<li class="df-study-item"><i class="fas fa-check-circle"></i> ${s}</li>`
    ).join('');

    const performanceHTML = data.performance.map((p) =>
      `<li class="df-perf-item"><i class="fas fa-star"></i> ${p}</li>`
    ).join('');

    reportSection.innerHTML = `
      <div class="container">
        <div class="df-child-header">
          <div class="df-child-avatar" style="background: linear-gradient(135deg, #2563EB, #3B82F6);">
            <i class="fas fa-child"></i>
          </div>
          <div class="df-child-info">
            <h2 class="df-child-name">${data.childName}</h2>
            <p class="df-child-class"><i class="fas fa-graduation-cap"></i> ${data.className}</p>
            <p class="df-child-updated"><i class="fas fa-clock"></i> 最近更新：${data.updatedAt}</p>
          </div>
        </div>

        <div class="df-cards-grid">
          <div class="df-card">
            <div class="df-card-icon" style="background: var(--primary-light);">
              <i class="fas fa-calendar-check" style="color: var(--primary);"></i>
            </div>
            <h3 class="df-card-title">今日出勤</h3>
            <p class="df-card-value df-attendance-normal">✅ ${data.attendance.label}</p>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: var(--secondary-light);">
              <i class="fas fa-utensils" style="color: var(--secondary);"></i>
            </div>
            <h3 class="df-card-title">今日饮食</h3>
            <div class="df-meals-list">${mealsHTML}</div>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: var(--accent-light);">
              <i class="fas fa-book-open" style="color: var(--accent);"></i>
            </div>
            <h3 class="df-card-title">学习内容</h3>
            <p class="df-card-subtitle">今天完成：</p>
            <ul class="df-study-list">${studyHTML}</ul>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: #EDE9FE;">
              <i class="fas fa-smile" style="color: #7C3AED;"></i>
            </div>
            <h3 class="df-card-title">课堂表现</h3>
            <ul class="df-perf-list">${performanceHTML}</ul>
          </div>

          <div class="df-card">
            <div class="df-card-icon" style="background: #FCE7F3;">
              <i class="fas fa-comment-dots" style="color: #EC4899;"></i>
            </div>
            <h3 class="df-card-title">老师评语</h3>
            <p class="df-card-comment">${data.comment}</p>
          </div>
        </div>
      </div>
    `;

    // 淡入动画
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
                <span>${item.detail.meals}</span>
              </div>
              <div class="df-detail-item">
                <span class="df-detail-label">学习</span>
                <span>${item.detail.study}</span>
              </div>
              <div class="df-detail-item">
                <span class="df-detail-label">表现</span>
                <span>${item.detail.performance}</span>
              </div>
              <div class="df-detail-item df-detail-full">
                <span class="df-detail-label">评语</span>
                <span>${item.detail.comment}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    historyList.innerHTML = historyHTML;

    // 绑定手风琴事件
    historyList.querySelectorAll('.df-timeline-header').forEach((header) => {
      header.addEventListener('click', () => {
        const index = header.getAttribute('data-index');
        const detail = document.getElementById('detail-' + index);
        const toggle = header.querySelector('.df-timeline-toggle i');

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
