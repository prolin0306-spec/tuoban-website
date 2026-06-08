(() => {
  'use strict';

  const header = document.getElementById('header');
  const nav = document.getElementById('nav');
  const menuToggle = document.getElementById('menuToggle');
  const backToTop = document.getElementById('backToTop');
  const contactForm = document.getElementById('contactForm');
  const navLinks = document.querySelectorAll('.nav-link');

  // ========== Sticky header shadow ==========
  const handleScroll = () => {
    const scrollY = window.scrollY;
    header.classList.toggle('scrolled', scrollY > 10);
    backToTop.classList.toggle('visible', scrollY > 500);
    updateActiveNav();
  };

  // ========== Active nav link ==========
  const updateActiveNav = () => {
    const sections = document.querySelectorAll('section[id]');
    let current = '';

    sections.forEach((sec) => {
      const top = sec.offsetTop - 120;
      if (window.scrollY >= top) {
        current = sec.getAttribute('id');
      }
    });

    navLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
    });
  };

  // ========== Mobile menu ==========
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

  // ========== Back to top ==========
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ========== Contact form ==========
  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();

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

    showToast('预约提交成功！我们会尽快与您联系，安排免费试托');
    contactForm.reset();
  });

  // ========== Toast ==========
  const showToast = (message, type = 'success') => {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'error') {
      toast.style.background = '#EF4444';
    }
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  };

  // ========== Scroll reveal ==========
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  const animateTargets = [
    '.feature-card',
    '.service-card',
    '.subject-card',
    '.teacher-card',
    '.classroom-card',
    '.enrollment-card',
    '.contact-form',
    '.contact-info-item',
    '.pickup-card'
  ];

  document.querySelectorAll(animateTargets.join(',')).forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });

  // ========== Init ==========
  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  // ========== Classroom lightbox ==========
  const createLightbox = () => {
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = `
      <button class="lightbox-close" aria-label="关闭">&times;</button>
      <img class="lightbox-img" src="" alt="">
    `;
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
      if (e.target === lightbox || e.target.classList.contains('lightbox-close')) {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) {
        close();
      }
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
})();
