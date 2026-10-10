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
    if (['homework-students.html', 'homework-classes.html'].includes(current)) current = 'students.html';
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;
    const items = [
      { href: 'dashboard.html', icon: 'fa-th-large', label: '仪表盘' },
      { href: 'students.html', icon: 'fa-users', label: '学生管理' },
      { href: 'homework.html', icon: 'fa-book', label: '作业管理' }
    ];
    const classId = new URLSearchParams(window.location.search).get('classId');
    const link = (item, child = false) =>
      `<a href="${item.href}${child && classId ? `?classId=${encodeURIComponent(classId)}` : ''}" class="adm-nav-item${child ? ' adm-nav-child' : ''}${current === item.href ? ' active' : ''}">
        <i class="fas ${item.icon}"></i><span>${item.label}</span>
      </a>`;
    nav.innerHTML = items.map(item => item.children ?
      `<div class="adm-nav-group">${link(item)}<div class="adm-nav-children">${item.children.map(child => link(child, true)).join('')}</div></div>` : link(item)
    ).join('') +
    `<a href="#" class="adm-nav-item adm-nav-logout" id="btnLogout">
      <i class="fas fa-sign-out-alt"></i><span>退出登录</span>
    </a>`;

    document.getElementById('btnLogout').addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof window.homeworkLogout === 'function') { window.homeworkLogout(); return; }
      if (window.adminAuth) window.adminAuth.logout();
    });
  };

  // 渲染顶栏
  window.initHeader = () => {
    const el = document.getElementById('topbarInfo');
    if (!el) return;
    if (window.adminAuth) window.adminAuth.session().then(session => { el.textContent = session.teacher.name || '已登录'; }).catch(() => { el.textContent = ''; });
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
