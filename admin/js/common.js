(() => {
  'use strict';

  // Toast
  window.showToast = (msg, type) => {
    const old = document.querySelector('.adm-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'adm-toast';
    if (type === 'error') t.style.background = '#EF4444';
    if (type === 'warn') t.style.background = '#F59E0B';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  };

  // 等待 CloudBase 就绪
  window.waitReady = () => new Promise((resolve) => {
    if (window.adminReady) { resolve(true); return; }
    let n = 0;
    const iv = setInterval(() => {
      n++;
      if (window.adminReady) { clearInterval(iv); resolve(true); return; }
      if (n > 100) { clearInterval(iv); resolve(false); }
    }, 100);
  });

  // 渲染侧边栏
  window.initSidebar = (current) => {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;
    const items = [
      { href: 'dashboard.html', icon: 'fa-th-large', label: '仪表盘' },
      { href: 'students.html', icon: 'fa-users', label: '学生管理' },
      { href: 'report-editor.html', icon: 'fa-edit', label: '每日反馈' },
      { href: 'mistakes.html', icon: 'fa-exclamation-triangle', label: '错题管理' }
    ];
    nav.innerHTML = items.map((item) =>
      `<a href="${item.href}" class="adm-nav-item${current === item.href ? ' active' : ''}">
        <i class="fas ${item.icon}"></i><span>${item.label}</span>
      </a>`
    ).join('') +
    `<a href="#" class="adm-nav-item adm-nav-logout" id="btnLogout">
      <i class="fas fa-sign-out-alt"></i><span>退出登录</span>
    </a>`;

    document.getElementById('btnLogout').addEventListener('click', (e) => {
      e.preventDefault();
      if (window.adminAuth) window.adminAuth.logout();
    });
  };

  // 渲染顶栏
  window.initHeader = () => {
    const el = document.getElementById('topbarInfo');
    if (!el) return;
    const s = window.adminAuth ? window.adminAuth.check() : null;
    el.innerHTML = `<i class="fas fa-user-circle"></i> ${s ? s.name : ''} &nbsp;|&nbsp;
      <i class="fas fa-calendar"></i> ${adminAPI.today()}`;
  };

  // 移动端菜单
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }
  });

})();
