/* Shared accessibility enhancements. Preserve application text, symbols, prices,
   user content, and existing action handlers exactly as the page renders them. */
(() => {
  'use strict';

  const modalSelector = '[role="dialog"][aria-modal="true"]';
  const focusableSelector = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]';
  const scrollRegionSelector = '.table-wrap,.tablewrap,.table-scroll,.table-container,.table-responsive,.overflow-x-auto';
  const menuSelector = '.ct-mobile-toggle,.menu-toggle,#menu-toggle,.mobile-menu,.coach-mobile-toggle,#coachMenu,.mobile-menu-toggle';
  const pendingRoots = new Set();
  const managedRegions = new WeakMap();
  let fieldId = 0;
  let scheduledFrame = 0;
  let activeDialog = null;
  let returnFocus = null;

  const visible = element => {
    if (!element?.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };

  const elementsWithin = (root, selector) => {
    const result = root.matches?.(selector) ? [root] : [];
    if (root.querySelectorAll) result.push(...root.querySelectorAll(selector));
    return result;
  };

  function enhanceControls(root) {
    for (const button of elementsWithin(root, 'button')) {
      if (button.hasAttribute('aria-label') || button.hasAttribute('aria-labelledby')) continue;
      const text = button.textContent.trim();
      if (button.matches(menuSelector)) {
        button.setAttribute('aria-label', 'Open navigation menu');
      } else if (/^[×✕✖]$/.test(text)) {
        button.setAttribute('aria-label', 'Close');
      } else if (!text && button.title) {
        button.setAttribute('aria-label', button.title);
      }
    }

    // Older forms have visible labels without a for/id association. Associate
    // only an unambiguous, single control in the same field; never infer a label.
    for (const label of elementsWithin(root, 'label')) {
      if (label.control || label.hasAttribute('for') || !label.textContent.trim()) continue;
      const field = label.closest('.field,.coach-field,.payment-field,.time-field,.form-field,.input-group');
      if (!field) continue;
      const controls = field.querySelectorAll('input:not([type="hidden"]),select,textarea');
      if (controls.length !== 1) continue;
      const control = controls[0];
      if (control.labels?.length) continue;
      if (!control.id) {
        let id;
        do { id = `courtly-field-${++fieldId}`; } while (document.getElementById(id));
        control.id = id;
      }
      label.htmlFor = control.id;
    }
  }

  function ensureSkipLink() {
    const main = document.querySelector('main,[role="main"]');
    if (!main) return;
    if (!main.id) {
      let id = 'courtly-main-content';
      while (document.getElementById(id)) id += '-main';
      main.id = id;
    }
    if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
    let link = document.querySelector('.ct-skip-link');
    if (!link) {
      link = document.createElement('a');
      link.className = 'ct-skip-link';
      link.textContent = 'Skip to main content';
      link.addEventListener('click', () => {
        document.getElementById(link.hash.slice(1))?.focus({ preventScroll: true });
      });
      document.body.prepend(link);
    }
    link.href = `#${main.id}`;
  }

  function enhanceTableScrolling() {
    document.querySelectorAll(scrollRegionSelector).forEach(region => {
      if (!region.querySelector('table')) return;
      const overflows = region.clientWidth > 0 && region.scrollWidth > region.clientWidth + 1;
      let added = managedRegions.get(region);
      if (overflows) {
        if (!added) {
          added = {};
          managedRegions.set(region, added);
        }
        if (!region.hasAttribute('tabindex')) {
          region.tabIndex = 0;
          added.tabindex = '0';
        }
        if (!region.hasAttribute('role')) {
          region.setAttribute('role', 'region');
          added.role = 'region';
        }
        if (!region.hasAttribute('aria-label') && !region.hasAttribute('aria-labelledby')) {
          const label = 'Table — scroll horizontally to see all columns';
          region.setAttribute('aria-label', label);
          added['aria-label'] = label;
        }
      } else if (added) {
        for (const [name, value] of Object.entries(added)) {
          if (region.getAttribute(name) === value) region.removeAttribute(name);
        }
        managedRegions.delete(region);
      }
    });
  }

  function focusableElements(dialog) {
    return [...dialog.querySelectorAll(focusableSelector)].filter(element =>
      element.tabIndex >= 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && visible(element)
    );
  }

  function focusDialog(dialog) {
    const heading = dialog.querySelector('h1,h2,h3');
    const target = heading || focusableElements(dialog)[0] || dialog;
    if (!target.hasAttribute('tabindex') && (target === heading || target === dialog)) target.tabIndex = -1;
    target.focus();
  }

  function syncDialogFocus() {
    // Native dialogs already provide their own focus management and top layer.
    if (document.querySelector('dialog[open]')) return;
    const open = [...document.querySelectorAll(modalSelector)].filter(visible).at(-1) || null;
    if (open === activeDialog) return;
    const previous = activeDialog;
    activeDialog = open;
    if (open) {
      if (!previous) returnFocus = document.activeElement;
      if (!open.contains(document.activeElement)) focusDialog(open);
    } else if (previous) {
      const focused = document.activeElement;
      if (visible(returnFocus) && (focused === document.body || previous.contains(focused) || !visible(focused))) {
        returnFocus.focus({ preventScroll: true });
      }
      returnFocus = null;
    }
  }

  function activeModal() {
    return activeDialog && visible(activeDialog) && !document.querySelector('dialog[open]') ? activeDialog : null;
  }

  function onModalKeydown(event) {
    syncDialogFocus();
    const dialog = activeModal();
    if (!dialog || event.defaultPrevented) return;
    if (event.key === 'Tab') {
      const elements = focusableElements(dialog);
      const first = elements[0];
      const last = elements.at(-1);
      const current = document.activeElement;
      if (!first) {
        event.preventDefault();
        focusDialog(dialog);
      } else if (event.shiftKey && (current === first || !elements.includes(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Escape') {
      const close = [...dialog.querySelectorAll('button')].find(button => {
        const label = button.getAttribute('aria-label') || button.textContent.trim();
        return !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button)
          && (/^close(?:\s|$)/i.test(label) || /^(done|cancel|×|✕|✖)$/i.test(label));
      });
      // Call the page's own close action so pending-upload and other guards still apply.
      event.preventDefault();
      event.stopPropagation();
      close?.click();
    }
  }

  function schedule(root) {
    if (root?.nodeType === 1) pendingRoots.add(root);
    if (scheduledFrame) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = 0;
      pendingRoots.forEach(element => {
        if (element.isConnected) enhanceControls(element);
      });
      pendingRoots.clear();
      ensureSkipLink();
      enhanceTableScrolling();
      syncDialogFocus();
    });
  }

  function init() {
    enhanceControls(document.body);
    ensureSkipLink();
    enhanceTableScrolling();
    syncDialogFocus();
    document.addEventListener('keydown', onModalKeydown, true);
    document.addEventListener('focusin', event => {
      const dialog = activeModal();
      if (dialog && !dialog.contains(event.target)) focusDialog(dialog);
    });

    // Observe structural/visibility changes, not every text character. Do not
    // rewrite page content or accessibility labels during a render/update.
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') {
          schedule(record.target);
          record.addedNodes.forEach(node => schedule(node));
        } else {
          schedule();
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open']
    });
    window.addEventListener('resize', () => schedule(), { passive: true });
    window.addEventListener('pageshow', () => schedule(document.body));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
