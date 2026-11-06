import { supabase } from './supabase-client.js';
import { safeReturnTo, setupRecoveryLink } from './account-recovery.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const safeNext = safeReturnTo(params.get('returnTo') || params.get('next'), '/coach-portal.html', location.origin);
setupRecoveryLink($('forgotPasswordLink'), 'coach');

async function route() {
  if (!supabase) {
    $('message').textContent = 'Coach sign-in is temporarily unavailable. Please try again shortly.';
    return;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data: coach } = await supabase.from('coach_profiles').select('id').eq('id', user.id).maybeSingle();
  if (coach || user.user_metadata?.account_type === 'coach') location.replace(safeNext);
}
route().catch(console.warn);

$('coachLogin').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('loginButton');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Signing in…';
  $('message').textContent = '';
  try {
    if (!supabase) throw new Error('Coach sign-in is temporarily unavailable. Please try again shortly.');
    const { data, error } = await supabase.auth.signInWithPassword({ email: $('email').value.trim().toLowerCase(), password: $('password').value });
    if (error) throw error;
    const user = data.user;
    const { data: coach, error: checkError } = await supabase.from('coach_profiles').select('id').eq('id', user.id).maybeSingle();
    if (checkError) throw checkError;
    if (!coach && user.user_metadata?.account_type !== 'coach') {
      await supabase.auth.signOut();
      throw new Error('This is not a Courtly coach account. Please use Player Login or Business Owner Login.');
    }
    location.replace(safeNext);
  } catch (error) {
    $('message').textContent = error.message || 'Unable to sign in.';
  } finally {
    button.disabled = false;
    button.textContent = 'Log in to Coach Portal';
  }
});
