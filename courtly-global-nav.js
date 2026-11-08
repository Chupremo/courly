import { supabase } from './supabase-client.js';
import './courtly-global-nav.css';

const LOGO = '/assets/courtly-logo.png';
const safeText = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function headerMarkup(role, displayName) {
  const guest = role === 'guest';
  let links = '<a href="/" data-ct-home>Home</a><a href="/players.html">Venues</a><a href="/coaches.html">Coaches</a><a href="/browse-clubs.html">Clubs</a>';
  if (guest) {
    links += `<details class="ct-dropdown"><summary>Login</summary><div class="ct-menu-panel"><a href="/player-login.html">Player login</a><a href="/coach-login.html">Coach login</a><a href="/club-login.html">Club login</a><a href="/login.html">Venue owner login</a></div></details>`;
    links += `<details class="ct-dropdown ct-register"><summary>Register</summary><div class="ct-menu-panel"><a href="/player-register.html">Register as a player</a><a href="/coach-register.html">Register as a coach</a><a href="/login.html?mode=signup">Register as a venue owner</a><a href="/club-register.html">Register a club</a></div></details>`;
  } else {
    if (role === 'player') {
      links += '<a href="/player-dashboard.html?view=home">Player dashboard</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/player-dashboard.html?view=profile">My profile</a><a href="/player-dashboard.html?view=bookings">My bookings</a><a href="/player-dashboard.html?view=invites">Club invitations</a><a href="/player-messages.html">Messages</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'coach') {
      links += '<a href="/coach-portal.html">Coach portal</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/coach-portal.html?view=profile">Coach profile</a><a href="/coach-portal.html?view=sessions">Coaching sessions</a><a href="/coach-portal.html?view=availability">Availability & rates</a><a href="/coach-portal.html?view=messages">Messages</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'owner') {
      links += '<a href="/owner-portal.html">Owner portal</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/owner-portal.html">Manage my venue</a><a href="/community.html">Community</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'club') {
      links += '<a href="/club-dashboard.html">Club dashboard</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/club-dashboard.html">Club dashboard</a><a href="/club-dashboard.html?view=members">Manage members</a><a href="/club-dashboard.html?view=activities">Activities &amp; posts</a><a href="/browse-clubs.html">Club directory</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'admin') {
      links += '<a href="/admin-billing.html">Admin billing</a><a href="/admin-coaches.html">Coach verification</a>';
      links += `<details class="ct-dropdown"><summary>Admin account</summary><div class="ct-menu-panel"><a href="/admin-billing.html">Billing administration</a><a href="/admin-coaches.html">Coach marketplace</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    }
  }
  return `<div class="ct-nav-wrap">
    <a class="ct-brand" href="/" aria-label="Courtly home"><img src="${LOGO}" alt="Courtly"></a>
    <button class="ct-mobile-toggle" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="ctGlobalNav"><span class="ct-mobile-toggle-icon" aria-hidden="true"><span></span></span></button>
    <nav class="ct-nav" id="ctGlobalNav" aria-label="Main navigation">${links}</nav>
    <span class="ct-community-user" id="communityUser">${safeText(displayName || (guest ? 'Guest' : ''))}</span>
  </div>`;
}

async function resolveRole() {
  if (!supabase) return { role: 'guest', displayName: 'Guest' };
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { role: 'guest', displayName: 'Guest' };
  const type = String(user.user_metadata?.account_type || '').toLowerCase();
  if (type === 'courtly_admin') return { role: 'admin', displayName: user.user_metadata?.full_name || user.email };
  if (type === 'coach') {
    const { data: coach } = await supabase.from('coach_profiles').select('coach_name').eq('id', user.id).maybeSingle();
    return { role: 'coach', displayName: coach?.coach_name || user.user_metadata?.coach_name || 'Coach' };
  }
  if (type === 'player') {
    const { data: profile } = await supabase.from('player_profiles').select('player_name,full_name').eq('id', user.id).maybeSingle();
    return { role: 'player', displayName: profile?.player_name || profile?.full_name || user.user_metadata?.player_name || user.email?.split('@')[0] || 'Player' };
  }
  if (type === 'club' || type === 'sports_club') {
    const { data: club } = await supabase.from('club_profiles').select('club_name').eq('id', user.id).maybeSingle();
    return { role: 'club', displayName: club?.club_name || user.user_metadata?.club_name || 'Club' };
  }
  if (type === 'venue_owner' || type === 'owner' || type === 'business_owner') {
    const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
    return { role: 'owner', displayName: venue?.owner_name || venue?.name || user.user_metadata?.owner_name || 'Venue owner' };
  }
  // Older player accounts may have a profile row but incomplete auth metadata.
  const { data: coach } = await supabase.from('coach_profiles').select('coach_name').eq('id', user.id).maybeSingle();
  if (coach) return { role: 'coach', displayName: coach.coach_name || user.email?.split('@')[0] || 'Coach' };
  const { data: profile } = await supabase.from('player_profiles').select('player_name,full_name').eq('id', user.id).maybeSingle();
  if (profile) return { role: 'player', displayName: profile.player_name || profile.full_name || user.email?.split('@')[0] || 'Player' };
  const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
  if (venue) return { role: 'owner', displayName: venue.owner_name || venue.name || 'Venue owner' };
  return { role: 'guest', displayName: 'Guest' };
}

const mobileNavigation = window.matchMedia('(max-width: 1024px)');
let headerRequest = 0;
let signingOut = false;

function closeMenus(header, restoreFocus = false) {
  const toggle = header.querySelector('.ct-mobile-toggle');
  const nav = header.querySelector('.ct-nav');
  nav?.classList.remove('is-open');
  toggle?.setAttribute('aria-expanded', 'false');
  toggle?.setAttribute('aria-label', 'Open navigation');
  if (toggle) toggle.innerHTML = '<span class="ct-mobile-toggle-icon" aria-hidden="true"><span></span></span>';
  header.querySelectorAll('.ct-dropdown[open]').forEach(details => { details.open = false; });
  if (restoreFocus) toggle?.focus();
}

function markCurrentPage(header) {
  const normalize = path => path.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const aliases = {
    '/index': '/', '/player/dashboard': '/player-dashboard',
    '/coach/dashboard': '/coach-portal', '/club/dashboard': '/club-dashboard'
  };
  const currentPath = normalize(location.pathname);
  const current = aliases[currentPath] || currentPath;
  header.querySelectorAll('.ct-nav > a').forEach(link => {
    if (normalize(new URL(link.href, location.href).pathname) === current) {
      link.setAttribute('aria-current', 'page');
    }
  });
}

function bindHeader(header) {
  // Delegate once so the guest navigation remains usable while account details load,
  // and a refreshed session does not leave a newly rendered menu without handlers.
  header.addEventListener('click', async event => {
    const toggle = event.target.closest('.ct-mobile-toggle');
    if (toggle) {
      const nav = header.querySelector('.ct-nav');
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      toggle.innerHTML = '<span class="ct-mobile-toggle-icon" aria-hidden="true"><span></span></span>';
      if (!open) closeMenus(header);
      else if (event.detail === 0) nav.querySelector('a')?.focus();
      return;
    }
    const logout = event.target.closest('[data-ct-logout]');
    if (logout) {
      if (signingOut || !supabase) return;
      signingOut = true;
      logout.disabled = true;
      logout.textContent = 'Logging out…';
      try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        location.assign('/players.html');
      } catch (error) {
        console.warn('Courtly could not log out:', error);
        window.alert('We could not log you out. Please try again.');
        logout.disabled = false;
        logout.textContent = 'Log out';
      } finally {
        signingOut = false;
      }
      return;
    }
    if (event.target.closest('.ct-nav a')) closeMenus(header);
  });
  header.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.matches?.('.ct-dropdown') || !details.open) return;
    header.querySelectorAll('.ct-dropdown').forEach(other => {
      if (other !== details) other.open = false;
    });
  }, true);
  header.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const dropdown = event.target.closest('.ct-dropdown[open]');
    if (dropdown) {
      event.preventDefault();
      dropdown.open = false;
      dropdown.querySelector('summary')?.focus();
    } else if (header.querySelector('.ct-mobile-toggle')?.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      closeMenus(header, true);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!header.contains(event.target)) closeMenus(header);
  });
  header.addEventListener('focusout', event => {
    if (event.relatedTarget && !header.contains(event.relatedTarget)) closeMenus(header);
  });
  mobileNavigation.addEventListener('change', () => closeMenus(header));
}

async function renderHeader() {
  const header = document.getElementById('courtlyGlobalHeader');
  if (!header) return;
  const request = ++headerRequest;
  header.setAttribute('aria-busy', 'true');
  let resolved;
  try {
    resolved = await resolveRole();
  } catch (error) {
    console.warn('Courtly navigation could not resolve the signed-in account:', error);
    resolved = { role: 'guest', displayName: 'Guest' };
  }
  if (request !== headerRequest || !header.isConnected) return;
  const markup = headerMarkup(resolved.role, resolved.displayName);
  if (header.dataset.accountKey !== `${resolved.role}:${resolved.displayName}`) {
    const focusWasInside = header.contains(document.activeElement);
    header.innerHTML = markup;
    header.dataset.accountKey = `${resolved.role}:${resolved.displayName}`;
    markCurrentPage(header);
    if (focusWasInside) {
      const focusTarget = mobileNavigation.matches
        ? header.querySelector('.ct-mobile-toggle')
        : header.querySelector('.ct-brand');
      focusTarget?.focus();
    }
  }
  header.removeAttribute('aria-busy');
}

function mount() {
  const existing = document.getElementById('courtlyGlobalHeader') || document.querySelector('body > header');
  const header = existing?.tagName === 'HEADER' ? existing : document.createElement('header');
  header.id = 'courtlyGlobalHeader';
  header.className = 'courtly-global-header';
  if (existing && existing !== header) existing.replaceWith(header);
  else if (!existing) document.body.insertBefore(header, document.body.firstChild);
  header.innerHTML = headerMarkup('guest', 'Guest');
  header.dataset.accountKey = 'guest:Guest';
  markCurrentPage(header);
  bindHeader(header);
  renderHeader();
}

mount();
window.addEventListener('courtly:auth-changed', renderHeader);
supabase?.auth.onAuthStateChange(event => {
  if (['SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
    // Auth callbacks must finish before another auth request is made.
    setTimeout(renderHeader, 0);
  }
});
