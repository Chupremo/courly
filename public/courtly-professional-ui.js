/* Courtly professional UI layer.
   Removes decorative Unicode pictograms from rendered UI while preserving labels,
   meaningful text, SVG artwork, and all underlying application behavior. */
(() => {
  'use strict';

  const decorativeSymbols = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0E\uFE0F\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF]/gu;
  const ignored = 'script,style,svg,code,pre,textarea,select,option,template,[contenteditable="true"],[data-preserve-symbols]';
  const iconWrappers = '.nav-ico,.ico,.stat-icon,.status-icon,.confirmation-check,.amenity-icon,.audience-icon,.venue-mark,.side-ico,.tab-icon,.quick-icon,.sport-icon,.feature-icon,.openplay-icon';

  function cleanTextNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(ignored)) return;

    const before = node.nodeValue || '';
    const after = before
      .replace(decorativeSymbols, '')
      .replace(/[\u200B\u2060\uFEFF]/g, '')
      .replace(/[ \t]{2,}/g, ' ');

    if (after === before) return;
    if (!after.trim()) {
      node.remove();
    } else {
      node.nodeValue = after;
    }
  }

  function cleanAttributes(element) {
    if (!element || element.nodeType !== 1 || element.matches(ignored)) return;
    for (const name of ['aria-label', 'title', 'alt', 'placeholder']) {
      if (!element.hasAttribute(name)) continue;
      const before = element.getAttribute(name) || '';
      const after = before.replace(decorativeSymbols, '').replace(/[ \t]{2,}/g, ' ').trim();
      if (after !== before) element.setAttribute(name, after);
    }
  }

  function cleanSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      cleanTextNode(root);
      return;
    }
    if (![1, 9, 11].includes(root.nodeType)) return;
    if (root.nodeType === 1 && root.matches(ignored)) return;

    const elements = [];
    if (root.nodeType === 1) elements.push(root);
    if (typeof root.querySelectorAll === 'function') {
      elements.push(...root.querySelectorAll('[aria-label],[title],[alt],[placeholder]'));
      elements.push(...root.querySelectorAll(iconWrappers));
    }
    elements.forEach(cleanAttributes);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(ignored)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) textNodes.push(current);
    textNodes.forEach(cleanTextNode);

    for (const element of elements) {
      if (!element.isConnected || !element.matches(iconWrappers)) continue;
      if (!element.childElementCount && !element.textContent.trim()) element.remove();
    }
  }

  function init() {
    cleanSubtree(document.documentElement);

    const observer = new MutationObserver(records => {
      const pending = new Set();
      for (const record of records) {
        if (record.type === 'characterData') pending.add(record.target);
        if (record.type === 'childList') {
          record.addedNodes.forEach(node => pending.add(node));
        }
      }
      pending.forEach(cleanSubtree);
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });

    document.querySelectorAll('.ct-mobile-toggle,.menu-toggle,#menu-toggle,.mobile-menu,.coach-mobile-toggle,#coachMenu,.mobile-menu-toggle').forEach(button => {
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Open navigation menu');
    });

    window.addEventListener('pageshow', () => cleanSubtree(document.documentElement));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();