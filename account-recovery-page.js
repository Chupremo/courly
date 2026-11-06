import { contextFromUrl, savedRecoveryContext, createRecoveryRequest, createPasswordReset, recoveryLoginUrl, recoveryRequestUrl } from './account-recovery.js';

// Capture the callback before the shared client consumes the URL fragment.
const initialUrl = new URL(location.href);
const $ = id => document.getElementById(id);
const mode = document.body.dataset.recoveryMode;
const form = $('recoveryForm');
const button = $('submitButton');
const message = $('recoveryMessage');
let storage = null;
let tabStorage = null;
try { storage = localStorage; } catch { /* Private browsing may disable storage. */ }
try { tabStorage = sessionStorage; } catch { /* A fresh valid email link still works. */ }
let context = mode === 'request' ? contextFromUrl(initialUrl) : savedRecoveryContext(storage, initialUrl.origin);
function updateLinks() {
  $('loginLink').href = recoveryLoginUrl(context, initialUrl.origin);
  if ($('newLink')) $('newLink').href = recoveryRequestUrl(context, initialUrl.origin);
  if ($('continueLink')) $('continueLink').href = recoveryLoginUrl(context, initialUrl.origin);
}
function show(text, type = 'error') {
  message.textContent = text;
  message.className = `recovery-message ${type}`;
  message.hidden = !text;
}
updateLinks();

async function boot() {
  const { supabase } = await import('./supabase-client.js');
  if (mode === 'request') {
    const request = createRecoveryRequest({ auth: supabase?.auth, context, origin: initialUrl.origin, storage });
    button.disabled = !supabase;
    if (!supabase) show('Password recovery is temporarily unavailable. Please try again later.');
    let pending = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || !form.reportValidity()) return;
      pending = true;
      button.disabled = true;
      button.textContent = 'Requesting reset link…';
      show('', 'info');
      try {
        const result = await request.send($('email').value);
        if (result.ignored) return;
        show(result.message, 'success');
        $('requestHelp').hidden = false;
      } catch (error) { show(error.message || 'Unable to request a reset link. Please try again later.'); }
      finally {
        pending = false;
        button.disabled = !supabase;
        button.textContent = 'Send reset link';
      }
    });
    return;
  }

  function render(state) {
    context = state.context;
    updateLinks();
    const ready = state.status === 'ready' || state.status === 'saving';
    form.hidden = !ready;
    button.disabled = state.status !== 'ready';
    button.textContent = state.status === 'saving' ? 'Updating password…' : 'Update password';
    $('recoveryFields').disabled = state.status !== 'ready';
    $('completePanel').hidden = state.status !== 'complete';
    $('invalidPanel').hidden = !['invalid', 'unavailable'].includes(state.status);
    $('checkingLink').hidden = state.status !== 'checking';
    if (state.status === 'complete') {
      $('pageTitle').textContent = 'Password updated';
      $('pageLead').textContent = 'Your Courtly account is ready to use.';
      form.reset();
    }
    show(state.message, state.status === 'complete' ? 'success' : state.status === 'saving' || (state.status === 'ready' && state.message.startsWith('Choose a new')) ? 'info' : 'error');
  }
  const reset = createPasswordReset({ auth: supabase?.auth, initialUrl: initialUrl.href, sessionStorage: tabStorage, returnStorage: storage, onState: render });
  window.addEventListener('pagehide', () => reset.dispose(), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    $('confirmPassword').setCustomValidity($('password').value === $('confirmPassword').value ? '' : 'Your passwords do not match.');
    if (!form.reportValidity()) return;
    await reset.submit($('password').value, $('confirmPassword').value);
  });
  for (const id of ['password', 'confirmPassword']) $(id).addEventListener('input', () => $('confirmPassword').setCustomValidity(''));
  $('showPassword').addEventListener('change', event => {
    $('password').type = $('confirmPassword').type = event.target.checked ? 'text' : 'password';
  });
  try { await reset.start(); }
  finally {
    // Credentials/error details should not remain in browser history or be
    // copied into support messages. Safe navigation context lives separately.
    history.replaceState(history.state, '', initialUrl.pathname);
  }
}

boot().catch(() => {
  button.disabled = true;
  if ($('checkingLink')) $('checkingLink').hidden = true;
  if ($('invalidPanel')) $('invalidPanel').hidden = false;
  show('Password recovery could not load. Check your connection and try again.');
});
