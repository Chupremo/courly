import { supabase } from './supabase-client.js';

const LOGO = '/assets/courtly-logo.png';
const safeText = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function headerMarkup(role, displayName) {
  const guest = role === 'guest';
  let links = '<a href="/">Home</a><a href="/coaches.html">Coaches</a><a href="/players.html">Venues</a><a href="/browse-clubs.html">Clubs</a>'; 
  if (guest) {
    links += `<details class="ct-dropdown"><summary>Login</summary><div class="ct-menu-panel"><a href="/player-login.html">Player login</a><a href="/coach-login.html">Coach login</a><a href="/login.html">Business owner login</a></div></details>`;
    links += `<details class="ct-dropdown ct-register"><summary>Register</summary><div class="ct-menu-panel"><a href="/player-register.html">Register as a player</a><a href="/coach-register.html">Register as a coach</a><a href="/login.html?mode=signup">Register as a venue owner</a><a href="/club-register.html">Register a club</a></div></details>`;
  } else {
    if (role === 'player') {
      links += '<a href="/player-dashboard.html">Player dashboard</a><a href="/community.html">Community</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/player-dashboard.html?view=profile">My profile</a><a href="/player-dashboard.html?view=bookings">My bookings</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'coach') {
      links += '<a href="/coach-portal.html">Coach portal</a><a href="/community.html">Community</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/coach-portal.html?view=profile">Coach profile</a><a href="/coach-portal.html?view=sessions">Coaching sessions</a><a href="/coach-portal.html?view=availability">Availability & rates</a><a href="/coach-portal.html?view=messages">Messages</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'owner') {
      links += '<a href="/owner-portal.html">Owner portal</a><a href="/community.html">Community</a>';
      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/owner-portal.html">Manage my venue</a><a href="/community.html">Community</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    } else if (role === 'club') {\n      links += '<a href="/browse-clubs.html">Browse clubs</a><a href="/community.html">Community</a>';\n      links += `<details class="ct-dropdown"><summary>My account</summary><div class="ct-menu-panel"><a href="/browse-clubs.html">Club directory</a><button type="button" data-ct-logout>Log out</button></div></details>`;\n    } else if (role === 'admin') {
      links += '<a href="/admin-billing.html">Admin billing</a><a href="/admin-coaches.html">Coach verification</a><a href="/community.html">Community</a>';
      links += `<details class="ct-dropdown"><summary>Admin account</summary><div class="ct-menu-panel"><a href="/admin-billing.html">Billing administration</a><a href="/admin-coaches.html">Coach marketplace</a><button type="button" data-ct-logout>Log out</button></div></details>`;
    }
  }
  return `<div class="ct-nav-wrap">
    <a class="ct-brand" href="/" aria-label="Courtly home"><img src="${LOGO}" alt="Courtly"></a>
    <button class="ct-mobile-toggle" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="ctGlobalNav">☰</button>
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
  if (type === 'club' || type === 'sports_club') {\n    const { data: club } = await supabase.from('club_profiles').select('club_name').eq('id', user.id).maybeSingle();\n    return { role: 'club', displayName: club?.club_name || user.user_metadata?.club_name || 'Club' };\n  }\n  if (type === 'venue_owner' || type === 'owner' || type === 'business_owner') {
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

async function renderHeader() {
  const header = document.getElementById('courtlyGlobalHeader');
  if (!header) return;
  const resolved = await resolveRole();
  header.innerHTML = headerMarkup(resolved.role, resolved.displayName);
  const toggle = header.querySelector('.ct-mobile-toggle');
  const nav = header.querySelector('.ct-nav');
  toggle?.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '×' : '☰';
  });
  header.querySelectorAll('.ct-dropdown').forEach(details => details.addEventListener('toggle', () => {
    if (details.open) header.querySelectorAll('.ct-dropdown').forEach(other => { if (other !== details) other.open = false; });
  }));
  header.querySelector('[data-ct-logout]')?.addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) { alert(error.message); return; }
    location.assign('/players.html');
  });
}

function mount() {
  const existing = document.querySelector('body > header');
  const header = document.createElement('header');
  header.id = 'courtlyGlobalHeader';
  header.className = 'courtly-global-header';
  if (existing) existing.replaceWith(header);
  else document.body.insertBefore(header, document.body.firstChild);
  renderHeader().catch(error => { console.warn('Courtly navigation could not resolve the signed-in account:', error); header.innerHTML = headerMarkup('guest','Guest'); });
}

mount();
window.addEventListener('courtly:auth-changed', () => { renderHeader().catch(console.warn); });
