/* Safety net: any button that renders with a dark blue background gets white text,
   whatever class it uses. Re-checked when content changes and on hover. */
(() => {
  'use strict';
  const SEL = 'button,a.btn,a[class*="btn"],input[type="submit"],input[type="button"],[role="button"],.primary,.book,.submit';
  const parse = c => (c.match(/[\d.]+/g) || []).map(Number);
  const isBlue = el => {
    const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor);
    if (a < .9 || r == null) return false;
    const lum = (.2126 * r + .7152 * g + .0722 * b) / 255;
    return lum < .32 && b > r + 15 && b >= g;
  };
  const fix = el => {
    if (el.dataset.cxLock) return;
    if (el.dataset.cxw) { el.style.removeProperty('color'); el.style.removeProperty('-webkit-text-fill-color'); delete el.dataset.cxw; }
    if (!isBlue(el)) return;
    el.style.setProperty('color', '#fff', 'important');
    el.style.setProperty('-webkit-text-fill-color', '#fff', 'important');
    el.dataset.cxw = '1';
  };
  const all = root => (root.querySelectorAll ? [...(root.matches?.(SEL) ? [root] : []), ...root.querySelectorAll(SEL)] : []).forEach(fix);
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; all(document); }); };
  const recheck = e => { const el = e.target.closest?.(SEL); if (el) setTimeout(() => fix(el), 260); };
  const start = () => {
    all(document);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-pressed'] });
    ['pointerover', 'pointerout', 'focusin', 'focusout'].forEach(t => document.addEventListener(t, recheck, true));
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
