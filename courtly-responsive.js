/* Courtly responsive navigation enhancements.
   Existing homepage, owner portal, venue page and player dashboard menus
   are left intact; this adds compact menus to the directory and marketing pages. */
(() => {
  const makeButton = (label, controls) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'courtly-mobile-nav-toggle';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-controls', controls);
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span></span><span></span><span></span>';
    return button;
  };

  const setupSingleNav = nav => {
    if (!nav || nav.dataset.courtlyMobileReady === '1') return;
    const parent = nav.parentElement;
    if (!parent || parent.querySelector('.mobile-menu-toggle, .menu-toggle, .mobile-menu, .courtly-mobile-nav-toggle')) return;

    parent.classList.add('courtly-has-mobile-menu', 'courtly-mobile-nav-shell');
    nav.classList.add('courtly-collapsible-nav');
    nav.dataset.courtlyMobileReady = '1';
    if (!nav.id) nav.id = `courtly-nav-${Math.random().toString(36).slice(2, 8)}`;

    const button = makeButton('Open navigation menu', nav.id);
    parent.insertBefore(button, nav);

    const close = () => {
      nav.classList.remove('courtly-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Open navigation menu');
    };
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      nav.classList.toggle('courtly-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    });
    nav.querySelectorAll('a').forEach(link => link.addEventListener('click', close));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) close();
    }, { passive: true });
  };

  const setupMarketingHeader = header => {
    if (!header || header.dataset.courtlyMobileReady === '1') return;
    const brand = header.querySelector(':scope > .brand');
    const navs = [...header.querySelectorAll(':scope > nav.nav')];
    if (!brand || navs.length < 1 || header.querySelector('.mobile-menu-toggle, .menu-toggle, .courtly-mobile-nav-toggle')) return;

    header.dataset.courtlyMobileReady = '1';
    header.classList.add('courtly-mobile-header-shell');
    const menu = document.createElement('div');
    menu.className = 'courtly-mobile-header-menu';
    menu.id = 'courtly-marketing-menu';

    navs.forEach(nav => {
      [...nav.children].forEach(item => {
        menu.appendChild(item.cloneNode(true));
      });
    });

    const button = makeButton('Open navigation menu', menu.id);
    header.insertBefore(button, brand.nextSibling);
    header.appendChild(menu);

    const close = () => {
      menu.classList.remove('courtly-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Open navigation menu');
    };
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      menu.classList.toggle('courtly-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    });
    menu.querySelectorAll('a,button').forEach(item => item.addEventListener('click', close));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) close();
    }, { passive: true });
  };

  const setupPwa = () => {
    if (window.Capacitor?.isNativePlatform?.() || window.COURTLY_NATIVE_APP) return;
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement('link');
      manifest.rel = 'manifest';
      manifest.href = '/manifest.webmanifest';
      document.head.appendChild(manifest);
    }
    const ensureMeta = (name, content) => {
      if (document.querySelector(`meta[name="${name}"]`)) return;
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
    };
    ensureMeta('theme-color', '#001A47');
    ensureMeta('apple-mobile-web-app-capable', 'yes');
    ensureMeta('apple-mobile-web-app-status-bar-style', 'default');
    ensureMeta('apple-mobile-web-app-title', 'Courtly');
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      const icon = document.createElement('link');
      icon.rel = 'apple-touch-icon';
      icon.href = '/assets/courtly-logo.png';
      document.head.appendChild(icon);
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/service-worker.js').catch(error => console.warn('Courtly service worker unavailable:', error.message));
    }

    // Installation is offered from Settings/Profile only.
    // Capture the browser install event without injecting a floating button.
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    let installEvent = null;
    window.COURTLY_INSTALL_AVAILABLE = !standalone;
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      installEvent = event;
      window.COURTLY_INSTALL_AVAILABLE = true;
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      window.COURTLY_INSTALL_AVAILABLE = false;
      window.dispatchEvent(new CustomEvent('courtly:installed'));
    });
    window.requestCourtlyInstall = async () => {
      if (standalone || window.navigator.standalone === true) return { installed: true };
      if (installEvent) {
        installEvent.prompt();
        const choice = await installEvent.userChoice;
        if (choice?.outcome === 'accepted') installEvent = null;
        return { installed: choice?.outcome === 'accepted', outcome: choice?.outcome || 'dismissed' };
      }
      const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIos) return { installed: false, ios: true };
      return { installed: false, unavailable: true };
    };
  };

  const init = () => {
    setupPwa();
    document.querySelectorAll('header.topbar').forEach(setupMarketingHeader);

    // Directory pages with a single navigation row.
    setupSingleNav(document.querySelector('header .nav > nav'));
    setupSingleNav(document.querySelector('header > .wrap > nav'));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
