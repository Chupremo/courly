import { supabase, supabaseConfigError } from './supabase-client.js';
import { syncPlayerProfile, playerDisplayName } from './player-profile-sync.js';

const $ = (id) => document.getElementById(id);
const root = $('viewRoot');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const sports = [
  ['Pickleball','PKL'],['Basketball','BKB'],['Padel','PDL'],['Archery','ARC'],['Badminton','BDM'],['Lawn Tennis','TNS'],['Billiards','BIL'],['Dart','DRT'],['Golf','GLF'],['Boxing','BOX'],['Swimming','SWM'],['Muay Thai','MT'],['Volleyball','VBL'],['Gym','GYM'],['Gymnastics','GYM'],['Table Tennis','TT'],['Yoga','YGA'],['Dance Studio','DNC'],['Football','FTB'],['Futsal','FTS'],['Bowling','BWL'],['Other','OTH']
];
let user = null, profile = null, profileAvatarUrl = '', venues = [], openPlayEvents = [], bookings = [], registrations = [], paymentReceipts = [], playerDirectory = [], clubInviteTargets = [], playerClubInvites = [], playerHomePosts = [];
let inviteTargetPlayerId = null;
let directorySearch = '';
let discoverPlayersLoaded = false;
let playerFriendRequests = [];
let view = new URLSearchParams(location.search).get('view') || 'home';
let discoverCoaches = [], discoverCoachesLoaded = false, discoverCoachesError = ''; 
let selectedSport = '', discoverSearch = '', discoverCity = '', discoverSport = '', discoverMode = new URLSearchParams(location.search).get('mode') === 'openplay' ? 'openplay' : 'list';
let bookingPeriod = 'upcoming';
let bookingFilter = 'all', tournamentTab = 'active', bookingFrom = '', bookingTo = '';
let toastTimer;

function notify(text) { const node=$('toast'); node.textContent=text; node.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('show'),3400); }
function initials(name='Player') { return String(name).trim().split(/\s+/).map(part=>part[0]||'').join('').slice(0,2).toUpperCase() || 'P'; }
function avatarMarkup(url,name='Player',klass='avatar') { return `<span class="${klass}">${url?`<img src="${esc(url)}" alt="${esc(name)} profile photo">`:esc(initials(name))}</span>`; }
function formatDate(value) { if(!value)return 'Date to be confirmed'; return new Intl.DateTimeFormat('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'}).format(new Date(value)); }
function formatTime(value) { if(!value)return ''; return new Intl.DateTimeFormat('en-PH',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Manila'}).format(new Date(value)); }
function statusInfo(row) {
  if(row.status==='cancelled' || row.registration_status==='cancelled') return {label:'Cancelled',cls:'cancelled'};
  if(row.payment_status==='confirmed' || row.status==='confirmed') return {label:'Confirmed',cls:'confirmed'};
  if(row.payment_status==='rejected' || row.status==='rejected') return {label:'Payment rejected',cls:'rejected'};
  if(row.payment_status==='awaiting_verification') return {label:'Awaiting verification',cls:'awaiting'};
  return {label:'Pending',cls:'awaiting'};
}
function normalizeBookings() {
  const courtRows=(bookings||[]).map(row=>({
    id:row.id,type:'court',title:row.venues?.name||'Court reservation',venue:row.venues?.name||'Courtly venue',venueSlug:row.venues?.slug,
    court:row.courts?.name||'Court',sport:row.courts?.sport||'',starts_at:row.starts_at,ends_at:row.ends_at,
    total:row.total,status:row.status,payment_status:row.payment_status,reference:row.reference,created_at:row.created_at,payment_method:row.payment_method
  }));
  const openRows=(registrations||[]).map(row=>({
    id:row.id,type:'openplay',title:row.event_title||'Open Play session',venue:row.venue_name||'Courtly venue',court:'Open Play',sport:'Open Play',
    starts_at:row.event_date ? `${row.event_date}T${convertTime(row.event_time)}:00+08:00` : row.created_at,
    total:Number(row.player_total ?? (Number(row.fee||0) + (row.transaction_fee_payer==='player' ? Number(row.transaction_fee||0) : 0))),registrationFee:Number(row.fee||0),transactionFee:Number(row.transaction_fee||0),transactionFeePayer:row.transaction_fee_payer||'venue_owner',status:row.registration_status,payment_status:row.payment_status,reference:row.registration_reference,created_at:row.created_at,payment_method:'GCash'
  }));
  return [...courtRows,...openRows].sort((a,b)=>new Date(b.starts_at||b.created_at)-new Date(a.starts_at||a.created_at));
}
function convertTime(value='00:00 AM') {
  const m=String(value).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i); if(!m)return '00:00'; let h=Number(m[1])%12; if(m[3].toUpperCase()==='PM')h+=12; return `${String(h).padStart(2,'0')}:${m[2]}`;
}
function allVenueSports() { return [...new Set(venues.flatMap(v=>(v.courts||[]).map(c=>c.sport).filter(Boolean)))].sort(); }
function venueCard(v) {
  const cs=(v.courts||[]).filter(c=>c.is_active!==false); const names=[...new Set(cs.map(c=>c.sport).filter(Boolean))];
  const rates=cs.map(c=>Number(c.off_peak_rate??c.hourly_rate)).filter(Number.isFinite); const min=rates.length?Math.min(...rates):null;
  const image=v.cover_url||v.logo_url||cs.find(c=>c.image_url)?.image_url||'';
  return `<article class="venue-card"><div class="venue-cover">${image?`<img loading="lazy" src="${esc(image)}" alt="${esc(v.name)}">`:esc(initials(v.name))}<span class="sport-label">${esc(names[0]||v.sport||'Sports venue')}</span></div><div class="venue-body"><h3>${esc(v.name)}</h3><div class="venue-loc"> ${esc([v.city,v.address].filter(Boolean).join(' · ')||'Location not provided')}</div><div class="venue-tags">${names.slice(0,3).map(s=>`<span class="tag">${esc(s)}</span>`).join('')}<span class="tag">${cs.length} ${cs.length===1?'court':'courts'}</span></div><div class="venue-foot"><div class="price">${min===null?'Rates not listed':'From'}<b>${min===null?'—':`${money(min)}/hr`}</b></div><a class="btn" href="/venue.html?slug=${encodeURIComponent(v.slug||'')}">View venue →</a></div></div></article>`;
}
function eventCard(event) {
  const venue=event.venues||{}; const image=event.banner_url||''; const date=formatDate(event.starts_at); const time=formatTime(event.starts_at);
  const spots=event.registration_limit ? `${Number(event.registered_count||0)} / ${event.registration_limit} spots` : 'Open registration';
  return `<article class="venue-card"><div class="venue-cover">${image?`<img loading="lazy" src="${esc(image)}" alt="${esc(event.title)}">`:''}<span class="sport-label">OPEN PLAY</span></div><div class="venue-body"><h3>${esc(event.title)}</h3><div class="venue-loc">${esc(venue.name||'Courtly venue')} · ${esc(venue.city||event.location_text||'Location to be confirmed')}<br>${esc(date)} · ${esc(time)}</div><div class="venue-tags"><span class="tag">${esc(venue.sport||'Social play')}</span><span class="tag">${esc(spots)}</span></div><div class="venue-foot"><div class="price">${Number(event.fee||0)>0?'Total at checkout':'Free registration'}<b>${money(Number(event.fee||0)+(Number(event.fee||0)>0?10:0))}</b><small>${Number(event.fee||0)>0?`${money(event.fee)} registration + ₱10 transaction fee`:'No transaction fee'}</small></div><a class="btn" href="/venue.html?slug=${encodeURIComponent(venue.slug||'')}">View session →</a></div></div></article>`;
}
function heading(kicker,title,desc,action='') { return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(desc)}</p></div>${action}</div>`; }
function setHeader() {
  root.dataset.view=view;
  const active=view==='discover'&&discoverMode==='openplay'?'openplay':view;
  document.querySelectorAll('[data-mobile-tab]').forEach(link=>{
    if(link.dataset.mobileTab===active)link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  const name=playerDisplayName(profile,user);
  $('sideName').textContent=name; $('topName').textContent=name; $('sideSkill').textContent=profile?.skill_level||'Player';
  const img=profileAvatarUrl; $('sideAvatar').innerHTML=img?`<img src="${esc(img)}" alt="">`:esc(initials(name)); $('topAvatar').innerHTML=img?`<img src="${esc(img)}" alt="">`:esc(initials(name));
  document.querySelectorAll('.nav-link').forEach(link=>link.classList.toggle('active',link.dataset.view===view));
  $('crumbText').textContent=({home:'Home',discover:'Discover',players:'Players',tournaments:'My Tournaments',bookings:'My Bookings',memberships:'Memberships',invites:'Club Invitations',profile:'Profile'})[view]||'Home';
}
function playerHomePostCard(post) {
  const mine=String(post.player_id)===String(user?.id);
  return `<article class="panel" style="padding:16px 17px;margin-bottom:10px"><div style="display:flex;align-items:flex-start;gap:11px"><span class="avatar" style="width:40px;height:40px">${post.avatar_url?`<img src="${esc(post.avatar_url)}" alt="">`:esc(initials(post.author_name))}</span><div style="min-width:0;flex:1"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><div><strong style="display:block;color:var(--navy);font-size:12px">${esc(post.author_name||'Courtly Player')}</strong><small style="color:var(--muted);font-size:9px">${esc(formatDate(post.created_at))} · ${esc(formatTime(post.created_at))}</small></div>${mine?`<button type="button" data-delete-home-post="${esc(post.id)}" style="border:0;background:transparent;color:#9b4350;font-size:10px;padding:6px">Delete</button>`:''}</div><p style="margin:10px 0 0;white-space:pre-wrap;word-break:break-word;line-height:1.65;font-size:12px;color:#3d4b65">${esc(post.body)}</p></div></div></article>`;
}
async function loadPlayerHomePosts() {
  const {data,error}=await supabase.from('player_home_posts').select('id,player_id,author_name,avatar_path,body,created_at').order('created_at',{ascending:false}).limit(50);
  if(error){console.warn('Could not load player home posts:',error.message);playerHomePosts=[];return;}
  playerHomePosts=await Promise.all((data||[]).map(async post=>({...post,avatar_url:await signPlayerAvatar(post.avatar_path)})));
}
async function submitPlayerHomePost(event) {
  event.preventDefault();
  const field=$('playerHomePostBody'), button=$('playerHomePostSubmit');
  const body=field?.value.trim()||'';
  if(!body)return;
  button.disabled=true;button.textContent='Posting…';
  try{
    const {error}=await supabase.from('player_home_posts').insert({player_id:user.id,author_name:playerDisplayName(profile,user),body});
    if(error)throw error;
    field.value='';
    await loadPlayerHomePosts();
    renderHome();
    notify('Your post is now visible to registered Courtly players.');
  }catch(error){notify(error.message||'Could not publish your post.');}
  finally{if(button){button.disabled=false;button.textContent='Post';}}
}
async function deletePlayerHomePost(id) {
  const {error}=await supabase.from('player_home_posts').delete().eq('id',id).eq('player_id',user.id);
  if(error){notify(error.message||'Could not delete your post.');return;}
  await loadPlayerHomePosts();renderHome();notify('Post deleted.');
}

let sportsNews = [], sportsNewsState = 'loading';
function sportsNewsBanner(item) {
  let imageUrl='';
  try { const url=new URL(item.image_url);if(url.protocol==='https:')imageUrl=url.href; }catch{}
  return `<div style="aspect-ratio:16/9;position:relative;display:grid;place-items:center;background:#f0f3f8;overflow:hidden;border-radius:12px 12px 0 0"><span aria-hidden="true" style="font-size:12px;font-weight:800;letter-spacing:.15em;color:var(--navy)">PHILIPPINE SPORTS</span>${imageUrl?`<img src="${esc(imageUrl)}" alt="${esc(item.image_alt||item.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;background:#f0f3f8" onerror="this.hidden=true;this.style.display='none'">`:''}</div>${imageUrl&&item.image_credit?`<small style="display:block;padding:6px 16px 0;color:var(--muted);font-size:10px">Photo: ${esc(item.image_credit)}</small>`:''}`;
}

function sportsNewsSection() {
  const cards=sportsNews.map(item=>`<article class="panel" style="padding:0;min-width:0;overflow:hidden">${sportsNewsBanner(item)}<div style="padding:16px"><small style="color:var(--muted)">${esc(item.source)} · ${esc(formatDate(item.published_at))}</small><h3 style="font-size:16px;line-height:1.4;margin:10px 0">${esc(item.title)}</h3><p style="font-size:12px;line-height:1.6;color:var(--muted)">${esc(item.summary)}</p><a class="btn light" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Read article</a></div></article>`).join('');
  return `<section id="sportsNewsSection" class="section-block" aria-labelledby="sportsNewsTitle"><div class="section-title"><div><span class="player-home-kicker">PHILIPPINE SPORTS</span><h2 id="sportsNewsTitle">Philippine Sports News</h2><p>Hourly news checks. New stories include the publisher and original article link.</p></div></div><div class="venue-grid">${cards||`<div class="empty-state"><strong>${sportsNewsState==='loading'?'Loading sports news…':sportsNewsState==='error'?'Sports news is temporarily unavailable':'Sports news is coming soon'}</strong><span>${sportsNewsState==='error'?'Please refresh to try again.':'Fresh stories will appear here when available.'}</span></div>`}</div></section>`;
}
async function loadSportsNews() {
  try {
    const response=await fetch(`https://raw.githubusercontent.com/Chupremo/courly/main/public/sports-news.json?t=${Date.now()}`,{cache:'no-store'});
    if(!response.ok)throw new Error('News unavailable');
    const payload=await response.json();
    if(!Array.isArray(payload.items))throw new Error('Invalid news feed');
    const seen=new Set();
    sportsNews=payload.items.filter(item=>{
      if(!item||!item.title||!item.summary||!item.source||!Number.isFinite(Date.parse(item.published_at)))return false;
      try {
        const url=new URL(item.url);
        if(url.protocol!=='https:'||seen.has(url.href))return false;
        seen.add(url.href);return true;
      }catch{return false;}
    }).sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at)).slice(0,6);
    sportsNewsState='ready';
  }catch{
    sportsNewsState='error';
  }
}

function playerUiIcon(name) {
  const paths={court:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 12h18M12 3v18M7 3v18m10-18v18"/>',play:'<path d="m9 5 11 7-11 7V5Z"/>',people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'};
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.court}</svg>`;
}
function isUpcomingBooking(row,now=Date.now()) {
  return !['cancelled','rejected'].includes(row.status)&&row.payment_status!=='rejected'&&Date.parse(row.ends_at||row.starts_at)>now;
}
function homeCourtsSection() {
  const sport=selectedSport||profile?.preferred_sport||'';
  const matching=venues.filter(v=>!sport||(v.courts||[]).some(c=>c.is_active!==false&&c.sport===sport));
  const locals=nearbyCourts.filter(v=>!sport||v.sport===sport||v.sport==='Multi-sport');
  const cards=matching.slice(0,4).map(venueCard).join('');
  const references=locals.slice(0,3).map(v=>`<article class="venue-card"><div class="venue-cover"><img src="${esc(v.image)}" alt="${esc(v.name)}" loading="lazy" style="object-fit:contain"><span class="sport-label">LOCAL COURT</span></div><div class="venue-body"><h3>${esc(v.name)}</h3><div class="venue-loc">${esc(v.city)}</div><p class="v2-note">${esc(v.courtCount)} · Contact venue for availability</p><a class="btn light" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">View court ${playerUiIcon('arrow')}</a></div></article>`).join('');
  return `<section class="v2-section"><div class="v2-section-head"><div><span class="eyebrow">FIND YOUR COURT</span><h2>Courts to explore</h2></div><a href="/player-dashboard.html?view=discover">View all</a></div>${cards?`<div class="v2-court-rail">${cards}</div>`:references?`<p class="v2-note">Local references near Batangas. Book directly with these venues.</p><div class="v2-court-rail">${references}</div>`:'<div class="v2-empty">No courts listed for this sport yet. <a href="/player-dashboard.html?view=discover">Browse all venues</a></div>'}</section>`;
}
function renderHome() {
  const name=playerDisplayName(profile,user).split(' ')[0];
  const current=selectedSport||profile?.preferred_sport||'';
  const homeSports=[...new Set(['Pickleball','Badminton','Basketball','Volleyball','Padel','Lawn Tennis',...(current?[current]:[])])];
  const next=normalizeBookings().filter(row=>isUpcomingBooking(row)).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at))[0];
  const chips=homeSports.map(s=>`<button type="button" class="sport-chip ${s===current?'active':''}" data-home-sport="${esc(s)}" aria-pressed="${s===current}">${esc(s)}</button>`).join('');
  const actions=[['court','Book a court','Find your next venue','/player-dashboard.html?view=discover'],['play','Join Open Play','Find a game to join','/player-dashboard.html?view=discover&mode=openplay'],['people','Find players','Meet your next teammate','/player-dashboard.html?view=players'],['calendar','Activities','Explore community games','/community.html']];
  root.innerHTML=`
    <div class="v2-welcome"><div><span class="eyebrow">YOUR COURTLY</span><h1>Hi, ${esc(name)}.</h1><p>Make room for your next game.</p></div><a class="v2-message" href="/player-messages.html" aria-label="Open messages">${playerUiIcon('chat')}</a></div>
    <section class="v2-game-plan"><span class="v2-hero-kicker">LESS PLANNING. MORE PLAYING.</span><h2>Where will you<br>play next?</h2><form id="homeVenueSearch" role="search"><label class="v2-search">${playerUiIcon('search')}<input id="homeVenueQuery" type="search" placeholder="Search courts or a city" aria-label="Search courts or a city"><button type="submit" aria-label="Find courts">${playerUiIcon('arrow')}</button></label></form><div class="v2-hero-links"><button type="button" data-open-sports>${esc(current||'Choose your sport')}</button><a href="/browse-clubs.html">Find a club</a></div></section>
    <nav class="v2-quick-actions" aria-label="Find your next game">${actions.map(([icon,title,desc,href])=>`<a href="${esc(href)}"><span class="v2-action-icon">${playerUiIcon(icon)}</span><span><strong>${title}</strong><small>${desc}</small></span>${playerUiIcon('arrow')}</a>`).join('')}</nav>
    <section class="v2-next-game"><div class="v2-section-head"><h2>Your next game</h2><a href="/player-dashboard.html?view=bookings">My bookings</a></div>${next?bookingCard(next):'<div class="v2-empty">Your schedule is open. Pick a court or join a game to get started.</div>'}</section>
    <section class="v2-section v2-sports"><div class="v2-section-head"><h2>What do you play?</h2><button type="button" data-open-sports>All sports</button></div><div class="sport-chips">${chips}</div></section>
    ${homeCourtsSection()}
    <div class="v2-coaching-link"><div><strong>Make your next game better</strong><p>Find a coach and build your skills.</p></div><a class="btn light" href="/coaches.html">Coaches ${playerUiIcon('arrow')}</a></div>
    <section class="section-block" aria-label="Player community feed"><div class="section-title"><div><span class="player-home-kicker">PLAYER FEED</span><h2>Share with Courtly players</h2><p>Posts here are visible to registered player accounts.</p></div></div>
      <form id="playerHomePostForm" class="panel" style="padding:15px;margin-bottom:14px"><div style="display:flex;gap:11px;align-items:flex-start">${avatarMarkup(profileAvatarUrl,playerDisplayName(profile,user),'avatar')}<div style="flex:1;min-width:0"><textarea id="playerHomePostBody" maxlength="500" rows="3" placeholder="What do you want to share? Looking for a game, a partner, or just saying hello?" style="width:100%;resize:vertical;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:12px Inter;line-height:1.55;outline:none"></textarea><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px"><small style="color:var(--muted)">Up to 500 characters</small><button class="btn" id="playerHomePostSubmit" type="submit">Post</button></div></div></div></form>
      <div id="playerHomeFeed">${playerHomePosts.length?playerHomePosts.map(playerHomePostCard).join(''):'<div class="empty-state"><strong>No player posts yet</strong><span>Be the first registered player to post an update.</span></div>'}</div>
    </section>
    ${sportsNewsSection()}`;
  $('homeVenueSearch')?.addEventListener('submit',event=>{event.preventDefault();discoverSearch=$('homeVenueQuery').value.trim();discoverSport=current;discoverMode='list';view='discover';history.pushState({},'', '/player-dashboard.html?view=discover');render();window.scrollTo({top:0,behavior:'smooth'});});
  root.querySelectorAll('[data-home-sport]').forEach(btn=>btn.addEventListener('click',()=>selectSport(btn.dataset.homeSport)));
  root.querySelectorAll('[data-open-sports]').forEach(btn=>btn.addEventListener('click',openSportModal));
  $('playerHomePostForm')?.addEventListener('submit',submitPlayerHomePost);
  root.querySelectorAll('[data-delete-home-post]').forEach(button=>button.addEventListener('click',()=>deletePlayerHomePost(button.dataset.deleteHomePost)));
}
function playerCardMarkup(player) {
  const name=player.player_name||'Courtly Player';
  const playerId=String(player.player_id||'');
  const svg=(paths)=>'<svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>';
  const friendRequest=playerFriendRequests.find(r=>(r.sender_id===user.id&&r.receiver_id===playerId)||(r.receiver_id===user.id&&r.sender_id===playerId));
  const friendLabel=friendRequest?.status==='accepted'?'Friends':friendRequest?.status==='pending'?(friendRequest.sender_id===user.id?'Request Sent':'Respond to Request'):'Add as Friend';
  const friendIcon=svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6m-3-3h6"/>');
  const followIcon=svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>');
  const chatIcon=svg('<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z"/>');
  const inviteIcon=svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/><path d="M17 2v6m-3-3h6"/>');
  return `<article class="player-social-card player-people-card"><button type="button" class="player-profile-trigger" data-open-player-profile="${esc(playerId)}" aria-haspopup="dialog" aria-label="View ${esc(name)}'s public profile">${avatarMarkup(player.avatar_url,name,'player-social-avatar')}<span class="player-social-copy"><strong>${esc(name)}</strong><span>${esc(player.public_location||'Location not shared')}</span><span>${esc([player.preferred_sport,player.skill_level].filter(Boolean).join(' · ')||'Courtly player')}</span><small>${Number(player.follower_count||0).toLocaleString('en-PH')} followers</small></span></button><div class="player-social-actions player-discover-actions"><button type="button" class="btn people-icon-btn" data-friend-player="${esc(playerId)}" title="${esc(friendLabel)}" aria-label="${esc(friendLabel)}" ${friendRequest?.status==='pending'&&friendRequest.sender_id===user.id||friendRequest?.status==='accepted'?'disabled':''}>${friendIcon}<span>${esc(friendLabel)}</span></button><button type="button" class="btn people-icon-btn ${player.is_following?'light':'social-follow'}" title="${player.is_following?'Following':'Follow'}" aria-label="${player.is_following?'Following':'Follow'}" data-follow-player="${esc(playerId)}" data-following="${player.is_following?'1':'0'}">${followIcon}<span>${player.is_following?'Following':'Follow'}</span></button><a class="btn people-icon-btn light" href="/player-messages.html?player=${encodeURIComponent(playerId)}" title="Chat" aria-label="Chat">${chatIcon}<span>Chat</span></a><button type="button" class="btn people-icon-btn light" data-invite-player="${esc(playerId)}" data-player-name="${esc(name)}" title="Invite to the Club" aria-label="Invite to the Club">${inviteIcon}<span>Invite to Club</span></button></div></article>`;
}
function ensurePlayerDetailsDialog() {
  let dialog=$('playerDetailsDialog');
  if(dialog)return dialog;
  dialog=document.createElement('dialog');
  dialog.id='playerDetailsDialog';
  dialog.className='player-detail-dialog';
  dialog.innerHTML='<section class="player-detail-panel"><button type="button" class="player-detail-close" id="closePlayerDetails" aria-label="Close player details">×</button><div id="playerDetailsContent"></div></section>';
  document.body.appendChild(dialog);
  $('closePlayerDetails').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  return dialog;
}
async function openPlayerDetails(playerId) {
  const player=playerDirectory.find(item=>String(item.player_id)===String(playerId));
  if(!player)return;
  const name=player.player_name||'Courtly Player';
  const location=String(player.public_location||'').trim();
  const dialog=ensurePlayerDetailsDialog();
  const followText=player.is_following?'Following':'Follow';
  $('playerDetailsContent').innerHTML=`<div class="player-detail-profile">${avatarMarkup(player.avatar_url,name,'player-detail-avatar')}<div><span class="player-detail-eyebrow">PUBLIC PLAYER PROFILE</span><h2>${esc(name)}</h2><p>${esc([player.preferred_sport,player.skill_level].filter(Boolean).join(' · ')||'Courtly player')}</p></div></div><div class="player-detail-facts"><div><span>Name</span><strong>${esc(name)}</strong></div><div><span>Location</span><strong>${location?esc(location):'Not shared by this player'}</strong></div></div><div class="player-detail-social-actions"><button type="button" class="btn light" id="detailFollow">${followText}</button><a class="btn light" href="/player-messages.html?player=${encodeURIComponent(playerId)}">Message</a><button type="button" class="btn light" id="detailInvite">Invite to Club</button><button type="button" class="btn light" id="detailBlock">Block player</button></div><section class="player-detail-clubs"><h3>My Clubs</h3><div id="detailClubList" aria-live="polite">Loading clubs…</div></section><p class="player-detail-note">Only information this player has chosen to share on their public profile is shown here.</p>`;
  $('detailFollow').addEventListener('click',async()=>{
    const button=$('detailFollow');button.disabled=true;
    const query=supabase.from('player_follows');
    const {error}=player.is_following
      ?await query.delete().eq('follower_id',user.id).eq('following_id',playerId)
      :await query.insert({follower_id:user.id,following_id:playerId});
    if(error && error.code!=='23505'){notify(error.message||'Could not update follow.');button.disabled=false;return;}
    player.is_following=!player.is_following;button.textContent=player.is_following?'Following':'Follow';button.disabled=false;
  });
  $('detailInvite').addEventListener('click',()=>{dialog.close();openClubInvite(playerId,name);});
  $('detailBlock').addEventListener('click',async()=>{
    if(!confirm('Block '+name+'? You will no longer see each other in player discovery, community posts, friend requests or messages.'))return;
    const button=$('detailBlock');button.disabled=true;button.textContent='Blocking…';
    try{
      const {error}=await supabase.rpc('block_player',{p_blocked_id:playerId});
      if(error)throw error;
      dialog.close();
      await Promise.all([loadPlayerDirectory(directorySearch),loadPlayerFriendRequests()]);
      if(view==='players')renderPlayers();else if(view==='discover')renderDiscover();else renderHome();
      notify(name+' has been blocked.');
    }catch(error){button.disabled=false;button.textContent='Block player';notify(error.message||'Could not block this player.');}
  });
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  try{
    const {data:members,error}=await supabase.from('club_members').select('club_id').eq('player_id',playerId).eq('status','approved');
    if(error)throw error;
    if(!members?.length){$('detailClubList').textContent='No clubs to display yet.';return;}
    const ids=members.map(m=>m.club_id);
    const {data:clubs,error:clubError}=await supabase.from('club_profiles').select('id,club_name,slug,logo_url').in('id',ids).eq('is_published',true);
    if(clubError)throw clubError;
    $('detailClubList').innerHTML=clubs?.length?clubs.map(club=>`<a class="player-detail-club" href="/club.html?slug=${encodeURIComponent(club.slug||'')}">${club.logo_url?`<img src="${esc(club.logo_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`:`<span class="player-club-fallback">${esc((club.club_name||'C').slice(0,2).toUpperCase())}</span>`}<span>${esc(club.club_name)}</span></a>`).join(''):'No clubs to display yet.';
  }catch(error){console.warn('Club memberships unavailable:',error.message);if($('detailClubList'))$('detailClubList').textContent='Clubs unavailable right now.';}
}
async function signPlayerAvatar(path) {
  if(!path)return '';
  if(/^https?:\/\//i.test(path))return path;
  const {data,error}=await supabase.storage.from('courtly-player-avatars').createSignedUrl(path,3600);
  if(error){console.warn('Could not load a public player avatar:',error.message);return '';}
  return data?.signedUrl||'';
}
async function loadPlayerDirectory(search='') {
  const {data,error}=await supabase.rpc('get_player_directory',{p_search:search||null,p_limit:30,p_offset:0});
  if(error){playerDirectory=[];console.warn('Player directory unavailable:',error.message);return;}
  playerDirectory=await Promise.all((data||[]).map(async row=>({...row,avatar_url:await signPlayerAvatar(row.avatar_path)})));
}
async function loadClubInviteTargets() {
  const {data,error}=await supabase.from('club_profiles').select('id,club_name,sport,city').eq('is_published',true).order('club_name');
  if(error)throw error;
  clubInviteTargets=data||[];
}
function ensureClubInviteDialog() {
  let dialog=$('inviteClubDialog');
  if(dialog)return dialog;
  dialog=document.createElement('dialog');dialog.id='inviteClubDialog';dialog.className='player-invite-dialog';
  dialog.innerHTML='<form id="inviteClubForm" method="dialog"><div class="invite-dialog-head"><div><div class="eyebrow">COURTLY PLAYER NETWORK</div><h2>Invite to a club</h2><p id="invitePlayerLabel">Invite this player to join a sports community.</p></div><button class="invite-close" type="button" id="closeInviteDialog" aria-label="Close">×</button></div><label for="inviteClubSelect">Choose a published club</label><select id="inviteClubSelect" required></select><p class="invite-dialog-note">The player receives an invitation and must accept it. The club manager then reviews the membership request.</p><div class="invite-dialog-actions"><button class="btn light" type="button" id="cancelInvite">Cancel</button><button class="btn social-follow" id="sendClubInvite" type="submit">Send invitation</button></div></form>';
  document.body.appendChild(dialog);
  $('closeInviteDialog').addEventListener('click',()=>dialog.close());
  $('cancelInvite').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  $('inviteClubForm').addEventListener('submit',async e=>{
    e.preventDefault();const button=$('sendClubInvite');const clubId=$('inviteClubSelect').value;
    if(!inviteTargetPlayerId||!clubId)return;
    button.disabled=true;button.textContent='Sending…';
    try{const{error}=await supabase.rpc('invite_player_to_club',{p_club_id:clubId,p_invitee_id:inviteTargetPlayerId});if(error)throw error;dialog.close();notify('Club invitation sent. The player can accept it from Club Invitations.');}
    catch(error){notify(error.message||'Could not send the club invitation.');}
    finally{button.disabled=false;button.textContent='Send invitation';}
  });
  return dialog;
}
async function openClubInvite(playerId,playerName) {
  inviteTargetPlayerId=playerId;
  const dialog=ensureClubInviteDialog();
  $('invitePlayerLabel').textContent='Invite '+playerName+' to join a sports community.';
  $('inviteClubSelect').innerHTML='<option value="">Loading published clubs…</option>';
  try{
    await loadClubInviteTargets();
    if(!clubInviteTargets.length){$('inviteClubSelect').innerHTML='<option value="">No published clubs available</option>';notify('There are no published clubs to invite this player to yet.');return;}
    $('inviteClubSelect').innerHTML=clubInviteTargets.map(club=>'<option value="'+esc(club.id)+'">'+esc(club.club_name)+' · '+esc([club.sport,club.city].filter(Boolean).join(' / '))+'</option>').join('');
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  }catch(error){notify(error.message||'Could not load clubs to invite.');}
}
async function loadPlayerClubInvites(){
  const{data,error}=await supabase.rpc('get_my_player_club_invites');
  if(error)throw error;playerClubInvites=data||[];
}
function renderClubInvites(){
  const pending=playerClubInvites.filter(invite=>invite.invite_status==='pending');
  const history=playerClubInvites.filter(invite=>invite.invite_status!=='pending');
  const card=invite=>'<article class="club-invite-card"><div class="club-invite-mark"></div><div class="club-invite-copy"><strong>'+esc(invite.club_name)+'</strong><span>'+esc([invite.club_sport,invite.inviter_name].filter(Boolean).join(' · '))+'</span><small>Invited '+esc(formatDate(invite.created_at))+'</small></div><div class="club-invite-actions">'+(invite.invite_status==='pending'?'<button type="button" class="btn social-follow" data-respond-club-invite="'+esc(invite.invite_id)+'" data-accept="true">Accept</button><button type="button" class="btn light" data-respond-club-invite="'+esc(invite.invite_id)+'" data-accept="false">Decline</button>':'<span class="status-pill '+(invite.invite_status==='accepted'?'accepted':'')+'">'+esc(invite.invite_status)+'</span>')+'</div></article>';
  root.innerHTML=`${heading('YOUR SPORTS COMMUNITY','Club invitations','Accept an invitation from a friend, then the club manager can review your membership request.')}<section class="section-block"><div class="section-title"><div><h2>Waiting for your response</h2><p>${pending.length} pending invitation${pending.length===1?'':'s'}</p></div></div>${pending.length?'<div class="club-invite-list">'+pending.map(card).join('')+'</div>':'<div class="empty-state"><strong>No pending club invitations</strong><span>When another player invites you to a published club, it will appear here.</span><div style="margin-top:14px"><a class="btn" href="/browse-clubs.html">Browse clubs</a></div></div>'}</section>${history.length?'<section class="section-block"><div class="section-title"><div><h2>Invitation history</h2></div></div><div class="club-invite-list">'+history.map(card).join('')+'</div></section>':''}`;
  root.querySelectorAll('[data-respond-club-invite]').forEach(button=>button.addEventListener('click',async()=>{
    const inviteId=button.dataset.respondClubInvite,accept=button.dataset.accept==='true';button.disabled=true;
    try{const{error}=await supabase.rpc('respond_to_player_club_invite',{p_invite_id:inviteId,p_accept:accept});if(error)throw error;await loadPlayerClubInvites();renderClubInvites();notify(accept?'Invitation accepted. Your request is now waiting for the club manager.':'Invitation declined.');}
    catch(error){button.disabled=false;notify(error.message||'Could not update this invitation.');}
  }));
}
async function loadPlayerFriendRequests(){
  const {data,error}=await supabase.from('player_friend_requests').select('id,sender_id,receiver_id,status').in('status',['pending','accepted']);
  if(error){console.warn('Friend requests unavailable:',error.message);return;}
  playerFriendRequests=data||[];
}
function bindFollowButtons() {
  root.querySelectorAll('[data-friend-player]').forEach(button=>button.addEventListener('click',async()=>{
    const receiverId=button.dataset.friendPlayer;
    if(receiverId===user.id){notify('You cannot add yourself as a friend.');return;}
    const existing=playerFriendRequests.find(r=>(r.sender_id===user.id&&r.receiver_id===receiverId)||(r.receiver_id===user.id&&r.sender_id===receiverId));
    if(existing?.status==='pending'&&existing.receiver_id===user.id){notify('This player already sent you a request. Accept it from your friend requests.');return;}
    button.disabled=true;
    try{
      const {error}=await supabase.from('player_friend_requests').insert({sender_id:user.id,receiver_id:receiverId,status:'pending'});
      if(error)throw error;
      await loadPlayerFriendRequests();
      if(view==='discover'&&discoverMode==='players')renderDiscover();else if(view==='players')renderPlayers();
      notify('Friend request sent!');
    }catch(error){button.disabled=false;notify(error.code==='23505'?'Friend request already exists.':error.message||'Could not send friend request.');}
  }));
  root.querySelectorAll('[data-open-player-profile]').forEach(button=>button.addEventListener('click',()=>openPlayerDetails(button.dataset.openPlayerProfile)));
  root.querySelectorAll('[data-invite-player]').forEach(button=>button.addEventListener('click',()=>openClubInvite(button.dataset.invitePlayer,button.dataset.playerName||'this player')));
  root.querySelectorAll('[data-follow-player]').forEach(button=>button.addEventListener('click',async()=>{
    const playerId=button.dataset.followPlayer; const following=button.dataset.following==='1';
    button.disabled=true;
    try{
      if(following){
        const {error}=await supabase.from('player_follows').delete().eq('follower_id',user.id).eq('following_id',playerId);
        if(error)throw error;
      }else{
        const {error}=await supabase.from('player_follows').insert({follower_id:user.id,following_id:playerId});
        if(error && error.code!=='23505')throw error;
      }
      await loadPlayerDirectory(directorySearch);
      if(view==='players')renderPlayers();else if(view==='discover'&&discoverMode==='players')renderDiscover();else renderHome();
      notify(following?'You unfollowed this player.':'You are now following this player.');
    }catch(error){button.disabled=false;notify(error.message||'Could not update your follow list.');}
  }));
}
function renderPlayers() {
  const visible=playerDirectory.filter(p=>[p.player_name,p.preferred_sport,p.skill_level,p.public_location].join(' ').toLowerCase().includes(directorySearch.toLowerCase()));
  root.innerHTML=`${heading('COURTLY NETWORK','Find players','Open a public profile to view the player name and shared location, or follow players with similar interests.')}<section class="toolbar player-directory-toolbar"><div class="search"><input id="playerDirectorySearch" type="search" placeholder="Search player nickname, sport or skill level…" value="${esc(directorySearch)}"></div><span class="subtle">${visible.length} public ${visible.length===1?'player':'players'}</span></section><div class="player-directory-grid">${visible.length?visible.map(playerCardMarkup).join(''):'<div class="empty-state"><strong>No public players found</strong><span>Try another search. Players who choose a private profile are not shown in the public directory.</span></div>'}</div>`;
  $('playerDirectorySearch')?.addEventListener('input',e=>{directorySearch=e.target.value;renderPlayers();const field=$('playerDirectorySearch');field?.focus();field?.setSelectionRange(directorySearch.length,directorySearch.length);});
  bindFollowButtons();
}

const nearbyCourts = [
  {
    name:'Lipa Elite Pickleball',
    city:'Lipa City, Batangas',
    address:'Mercado De Lipa, Purok 6 MK Lina St, Brgy. San Sebastian',
    sport:'Pickleball',
    courtCount:'5 indoor courts',
    image:'https://lipaelitepickleball.com/logo.png',
    imageFit:'contain',
    url:'https://lipaelitepickleball.com/'
  },
  {
    name:'The Pickle Yard Lipa South',
    city:'Lipa City, Batangas',
    address:'Purok 5, Lipa City, Batangas',
    sport:'Pickleball',
    courtCount:'4 indoor courts',
    image:'https://baseline-prod.sgp1.digitaloceanspaces.com/6d030b319415d5d3275a0fabcbe58164.png',
    imageFit:'contain',
    url:'https://www.facebook.com/PYLipaSouth'
  },
  {
    name:'Lipa City Community Park Sports Area',
    city:'Lipa City, Batangas',
    address:'Lipa City, Batangas',
    sport:'Multi-sport',
    courtCount:'Public sports facilities',
    image:'https://www.dpwh.gov.ph/dpwh/sites/default/files/lipa_city_park_upgraded_facilities.jpg',
    imageFit:'contain',
    url:'https://www.google.com/maps/search/?api=1&query=Lipa+City+Community+Park+Batangas'
  }
];

function nearbyCourtsSection() {
  const matching=nearbyCourts.filter(venue=>{
    const hay=[venue.name,venue.city,venue.address,venue.sport].join(' ').toLowerCase();
    return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))
      &&(!discoverCity||venue.city===discoverCity)
      &&(!discoverSport||venue.sport.toLowerCase().includes(discoverSport.toLowerCase()));
  });
  return `<section class="section-block" aria-labelledby="discoverNearbyTitle"><div class="section-title"><div><h2 id="discoverNearbyTitle">Nearby courts</h2><p>Local court references near Batangas. Contact these venues directly for bookings and availability.</p></div></div>${matching.length?`<div class="venue-grid">${matching.map(venue=>`<article class="venue-card"><div class="venue-cover">${venue.image?`<img loading="lazy" src="${esc(venue.image)}" alt="${esc(venue.name)}" style="object-fit:contain;background:#fff;padding:14px">`:esc(initials(venue.name))}<span class="sport-label">NEARBY COURT</span></div><div class="venue-body"><h3>${esc(venue.name)}</h3><div class="venue-loc">${esc([venue.city,venue.address].filter(Boolean).join(' · '))}</div><div class="venue-tags"><span class="tag">${esc(venue.sport)}</span><span class="tag">${esc(venue.courtCount)}</span></div><div class="venue-foot"><span>External venue</span><a class="btn light" href="${esc(venue.url)}" target="_blank" rel="noopener noreferrer">View court</a></div></div></article>`).join('')}</div>`:'<div class="empty-state"><strong>No nearby courts match your filters</strong><span>Try another sport, location or search term.</span></div>'}</section>`;
}

function renderDiscover() {
  const cities=[...new Set([...venues.map(v=>v.city),...nearbyCourts.map(v=>v.city),...discoverCoaches.map(v=>v.city)].filter(Boolean))].sort();
  const sportOptions=[...new Set([...sports.map(s=>s[0]),...allVenueSports(),...discoverCoaches.map(v=>v.sport).filter(Boolean)])].sort();
  const filtered=venues.filter(v=>{
    const cs=v.courts||[]; const hay=[v.name,v.city,v.address,...cs.map(c=>c.name),...cs.map(c=>c.sport)].join(' ').toLowerCase();
    return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))&&(!discoverCity||v.city===discoverCity)&&(!discoverSport||cs.some(c=>String(c.sport||'').toLowerCase().includes(discoverSport.toLowerCase())));
  });
  const filteredEvents=openPlayEvents.filter(event=>{
    const v=event.venues||{}; const hay=[event.title,event.location_text,v.name,v.city,v.sport].join(' ').toLowerCase();
    return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))&&(!discoverCity||v.city===discoverCity)&&(!discoverSport||String(v.sport||'').toLowerCase().includes(discoverSport.toLowerCase()));
  });
  let content=''; let count=filtered.length;
  if(discoverMode==='players'){
    const matching=playerDirectory.filter(p=>[p.player_name,p.preferred_sport,p.skill_level,p.public_location].join(' ').toLowerCase().includes(discoverSearch.toLowerCase())&&(!discoverSport||String(p.preferred_sport||'').toLowerCase().includes(discoverSport.toLowerCase()))&&(!discoverCity||String(p.public_location||'').toLowerCase().includes(discoverCity.toLowerCase())));
    count=matching.length;
    content=!discoverPlayersLoaded?'<div class="empty-state">Finding players...</div>':matching.length?'<div class="player-directory-grid">'+matching.map(playerCardMarkup).join('')+'</div>':'<div class="empty-state"><strong>No players found</strong><span>Only players with public profiles appear here.</span></div>';
  }else if(discoverMode==='coaches'){
    const matching=discoverCoaches.filter(coach=>{
      const hay=[coach.coach_name,coach.sport,coach.city,coach.location_text].join(' ').toLowerCase();
      return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))&&(!discoverCity||coach.city===discoverCity)&&(!discoverSport||String(coach.sport||'').toLowerCase().includes(discoverSport.toLowerCase()));
    });
    count=matching.length;
    content=discoverCoachesError?'<div class="empty-state"><strong>Could not load coaches</strong><span>Please try again later.</span></div>':!discoverCoachesLoaded?'<div class="empty-state">Loading coaches...</div>':matching.length?'<div class="venue-grid">'+matching.map(coach=>{
      const photo=coach.profile_image_path?(coach.profile_image_path.startsWith('http')?coach.profile_image_path:supabase.storage.from('courtly-coach-media').getPublicUrl(coach.profile_image_path).data.publicUrl):'';
      const banner=coach.cover_image_path?(coach.cover_image_path.startsWith('http')?coach.cover_image_path:supabase.storage.from('courtly-coach-media').getPublicUrl(coach.cover_image_path).data.publicUrl):'';
      return '<article class="venue-card"><div class="venue-cover" style="position:relative;background:linear-gradient(135deg,#132e54,#49749b)">'+(banner?'<img loading="lazy" src="'+esc(banner)+'" alt="'+esc(coach.coach_name)+' coaching banner" style="width:100%;height:100%;object-fit:cover">':'')+'<span class="sport-label">'+esc(coach.sport||'Coach')+'</span></div><div class="venue-body"><div style="display:flex;align-items:flex-end;gap:12px;margin-top:-44px;position:relative;margin-bottom:12px"><div style="width:78px;height:78px;flex-shrink:0;border-radius:50%;border:4px solid white;box-shadow:0 3px 12px #0002;background:#dce8f5;display:grid;place-items:center;overflow:hidden;color:#10244c;font-size:24px;font-weight:800">'+(photo?'<img loading="lazy" src="'+esc(photo)+'" alt="'+esc(coach.coach_name)+' profile picture" style="width:100%;height:100%;object-fit:cover">':esc(initials(coach.coach_name)))+'</div></div><h3>'+esc(coach.coach_name)+'</h3><div class="coach-marketplace-stats" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:9px 0 13px;padding:10px 0;border-top:1px solid #e8edf4;border-bottom:1px solid #e8edf4;text-align:center;font-size:11px;color:#68758e"><span><strong style="display:block;font-size:16px;color:#11254a">'+Number(coach.follower_count||0).toLocaleString('en-PH')+'</strong>Followers</span><span><strong style="display:block;font-size:16px;color:#11254a">—</strong>Friends</span><span><strong style="display:block;font-size:16px;color:#11254a">—</strong>Sessions booked</span></div><div class="venue-loc">'+esc(coach.city||coach.location_text||'Location not provided')+(coach.is_verified?' · Verified':'')+'</div><div class="venue-tags"><span class="tag">₱'+Number(coach.hourly_rate||0).toLocaleString('en-PH')+'/hr</span></div><div class="venue-foot coach-marketplace-actions" style="display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important;width:100%;flex-wrap:nowrap!important"><button class="btn" disabled title="Coach friend requests coming soon" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box">Add as Friend</button><a class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" href="/coach/'+encodeURIComponent(coach.slug)+'">Follow</a><a class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" href="/coach/'+encodeURIComponent(coach.slug)+'">Chat</a><a class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" href="/coach-booking.html?coach='+encodeURIComponent(coach.slug)+'">Book a Session</a></div></div></article>';
    }).join('')+'</div>':'<div class="venue-grid"><article class="venue-card"><div class="venue-cover" style="background:linear-gradient(135deg,#16345f,#4c7199);position:relative"><img loading="lazy" src="https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&w=1200&q=80" alt="Sample pickleball coaching banner" style="width:100%;height:100%;object-fit:cover"><span class="sport-label">DEMO · Pickleball</span></div><div class="venue-body"><div style="display:flex;align-items:flex-end;margin-top:-44px;position:relative;margin-bottom:12px"><div role="img" aria-label="Sample coach profile picture" style="width:78px;height:78px;border-radius:50%;border:4px solid white;box-shadow:0 3px 12px #0002;background:#e2ecfa;overflow:hidden"><img loading="lazy" src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=240&h=240&q=80" alt="Illustrative demo coach portrait" style="width:100%;height:100%;object-fit:cover"></div></div><h3>Coach Mika Cruz <span class="tag">Sample profile</span></h3><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:9px 0 13px;padding:10px 0;border-top:1px solid #e8edf4;border-bottom:1px solid #e8edf4;text-align:center;font-size:11px;color:#68758e"><span><strong style="display:block;font-size:16px;color:#11254a">128</strong>Followers</span><span><strong style="display:block;font-size:16px;color:#11254a">36</strong>Friends</span><span><strong style="display:block;font-size:16px;color:#11254a">24</strong>Sessions booked</span></div><div class="venue-loc">Batangas City · Pickleball Coach</div><p style="font-size:12px;color:#64748b;line-height:1.5">Beginner and intermediate training, fundamentals, footwork and match strategy.</p><div class="venue-tags"><span class="tag">5 years experience</span><span class="tag">₱800/hr (sample)</span></div><div class="venue-foot coach-marketplace-actions" style="display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important;width:100%;flex-wrap:nowrap!important"><button class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" disabled title="Demo coach: friend requests unavailable">Add as Friend</button><button class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" disabled title="Demo coach: follow unavailable">Follow</button><button class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" disabled title="Demo coach: chat unavailable">Chat</button><button class="btn" style="width:100%!important;min-width:0!important;min-height:44px!important;padding:10px 5px!important;font-size:12px!important;display:flex!important;align-items:center;justify-content:center;text-align:center;box-sizing:border-box" disabled title="Demo coach: booking unavailable">Book a Session</button></div><p style="font-size:11px;color:#64748b">Demo preview only — actions become available for real coach accounts.</p></div></article></div>';
  }else if(discoverMode==='openplay'){
    count=filteredEvents.length;
    content=filteredEvents.length?`<div class="venue-grid">${filteredEvents.map(eventCard).join('')}</div>`:`<div class="empty-state"><strong>No upcoming Open Play sessions</strong><span>Published sessions appear here automatically. Check back as more venues add games.</span></div>`;
  }else if(discoverMode==='map'){
    content=filtered.length?`<div class="map-list">${filtered.map(v=>{const image=v.cover_url||v.logo_url||(v.courts||[]).find(c=>c.image_url)?.image_url||'';const query=encodeURIComponent([v.name,v.address,v.city].filter(Boolean).join(', '));return `<article class="map-card"><div class="map-thumb">${image?`<img loading="lazy" src="${esc(image)}" alt="">`:''}</div><div><h3>${esc(v.name)}</h3><p>${esc([v.address,v.city].filter(Boolean).join(', ')||'Location not provided')}<br>${(v.courts||[]).filter(c=>c.is_active!==false).length} active courts</p><a class="map-open" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${query}">Open in Google Maps </a><br><a class="map-open" href="/venue.html?slug=${encodeURIComponent(v.slug||'')}">View booking page →</a></div></article>`}).join('')}</div>`:`<div class="empty-state"><strong>No mapped venues found</strong><span>Try changing your filters. Venue locations open in Google Maps based on the address stored by each venue.</span></div>`;
  }else{
    content=filtered.length?`<div class="venue-grid">${filtered.map(venueCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">⌕</div><strong>No venues found</strong><span>Try another sport, location or search term. Published venues will appear here automatically.</span></div>`;
  }
  if(discoverMode==='list')content+=nearbyCourtsSection();
  root.innerHTML=`${heading('EXPLORE COURTLY',discoverMode==='openplay'?'Find your next game':'Find your place to play',discoverMode==='openplay'?'Join a published Open Play session.':'Courts, players and coaches. One place to find your next game.')}
    <section class="toolbar"><div class="search"><input id="discoverSearch" type="search" aria-label="Search Discover" placeholder="${discoverMode==='players'?'Search players or a city':discoverMode==='coaches'?'Search coaches or a sport':'Search courts or a city'}" value="${esc(discoverSearch)}"></div><select id="discoverSport" aria-label="Filter by sport"><option value="">All sports</option>${sportOptions.map(s=>`<option value="${esc(s)}" ${discoverSport===s?'selected':''}>${esc(s)}</option>`).join('')}</select><select id="discoverCity" aria-label="Filter by location"><option value="">All locations</option>${cities.map(c=>`<option value="${esc(c)}" ${discoverCity===c?'selected':''}>${esc(c)}</option>`).join('')}</select><div class="segmented"><button data-discover-mode="list" class="${discoverMode==='list'?'active':''}">Venues</button><button data-discover-mode="players" class="${discoverMode==='players'?'active':''}">Players</button><button data-discover-mode="coaches" class="${discoverMode==='coaches'?'active':''}">Coaches</button></div></section>
    <div class="section-title"><div><h2>${count} ${discoverMode==='players'?(count===1?'player':'players'):discoverMode==='coaches'?(count===1?'coach':'coaches'):discoverMode==='openplay'?(count===1?'session':'sessions'):(count===1?'venue':'venues')} found</h2><p>${discoverMode==='players'?'People you may know — discover players with shared sports interests.':discoverMode==='coaches'?'Browse coaches and book training sessions.':discoverMode==='openplay'?'Upcoming published Open Play sessions.':'Published Courtly venues with active courts.'}</p></div></div>${content}`;
  $('discoverSearch')?.addEventListener('input',e=>{const value=e.target.value;const caret=e.target.selectionStart;discoverSearch=value;renderDiscover();const next=$('discoverSearch');if(next){next.focus();next.setSelectionRange(caret,caret);}});
  $('discoverSport')?.addEventListener('change',e=>{discoverSport=e.target.value;renderDiscover()});
  $('discoverCity')?.addEventListener('change',e=>{discoverCity=e.target.value;renderDiscover()});
  if(discoverMode==='players')bindFollowButtons();
  root.querySelectorAll('[data-discover-mode]').forEach(btn=>btn.addEventListener('click',async()=>{discoverMode=btn.dataset.discoverMode;renderDiscover();if(discoverMode==='coaches'&&!discoverCoachesLoaded)await loadDiscoverCoaches();if(discoverMode==='players'&&!discoverPlayersLoaded){await Promise.all([loadPlayerDirectory(),loadPlayerFriendRequests()]);discoverPlayersLoaded=true;renderDiscover();}}));
}
function bookingCard(row) {
  const status=statusInfo(row); const date=formatDate(row.starts_at); const time=row.ends_at?`${formatTime(row.starts_at)} – ${formatTime(row.ends_at)}`:'';
  const openPlayBreakdown = row.type === 'openplay'
    ? `<br><span class="booking-fee-note">Registration ${money(row.registrationFee||0)}${row.transactionFeePayer==='player'&&row.transactionFee>0?` + ${money(row.transactionFee)} transaction fee`:''}</span>`
    : '';
  return `<article class="booking-card"><div><h3>${esc(row.venue||row.title)}</h3><div class="booking-meta">${esc(row.type==='openplay'?'Open Play session':row.court)}${row.sport&&row.type==='court'?' · '+esc(row.sport):''}<br>${esc(date)}${time?' · '+esc(time):''}<br>${row.reference?'Reference: '+esc(row.reference):''}${openPlayBreakdown}</div></div><div class="booking-right"><strong class="booking-amount">${money(row.total)}</strong><span class="status ${status.cls}">${status.label}</span>${row.venueSlug?`<a class="link" href="/venue.html?slug=${encodeURIComponent(row.venueSlug)}">View venue →</a>`:''}</div></article>`;
}
function renderBookings() {
  const all=normalizeBookings(); const countAll=all.length, open=all.filter(r=>r.type==='openplay').length, courts=all.filter(r=>r.type==='court').length, sessions=0;
  const filters=[['all','All',countAll],['openplay','Open Play',open],['court','Court Rental',courts]];
  const rows=all.filter(r=>{
    const itemDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.starts_at||r.created_at));
    const matchesType=bookingFilter==='all'||(bookingFilter==='sessions'?false:r.type===bookingFilter);
    const matchesPeriod=bookingPeriod==='upcoming'?isUpcomingBooking(r):!isUpcomingBooking(r);
    return matchesType&&matchesPeriod&&(!bookingFrom||itemDate>=bookingFrom)&&(!bookingTo||itemDate<=bookingTo);
  });
  root.innerHTML=`${heading('PLAYER ACTIVITY','My Bookings','Manage your court reservations and Open Play registrations.')}
    <div class="stat-grid"><div class="stat-card"><small>All</small><strong>${countAll}</strong></div><div class="stat-card"><small>Open Play</small><strong>${open}</strong></div><div class="stat-card"><small>Court Rental</small><strong>${courts}</strong></div><div class="stat-card"><small>Sessions</small><strong>${sessions}</strong></div></div>
    <div class="v2-period-tabs" role="group" aria-label="Booking period">${[['upcoming','Upcoming'],['past','Past & cancelled']].map(([key,label])=>`<button type="button" data-booking-period="${key}" aria-pressed="${bookingPeriod===key}">${label}</button>`).join('')}</div>
    <div class="toolbar"><div class="subtle">Filter your activity</div><div class="tabs" style="margin:0;flex:1">${filters.map(([key,label,n])=>`<button data-booking-filter="${key}" class="${bookingFilter===key?'active':''}">${label} <span style="opacity:.65">${n}</span></button>`).join('')}</div><label class="date-filter">From <input id="bookingFrom" type="date" value="${esc(bookingFrom)}"></label><label class="date-filter">To <input id="bookingTo" type="date" value="${esc(bookingTo)}"></label><button class="btn light" id="clearBookingDates">Clear dates</button><button class="btn light" id="refreshBookings">↻ Refresh</button></div>
    <div class="section-title"><div><h2>${bookingFilter==='all'?'All activity':filters.find(f=>f[0]===bookingFilter)?.[1]||'Bookings'}</h2><p>${rows.length} ${rows.length===1?'record':'records'}</p></div></div>
    ${rows.length?`<div class="booking-list">${rows.map(bookingCard).join('')}</div>`:`<div class="empty-state"><strong>No ${bookingPeriod==='upcoming'?'upcoming ':''}${bookingFilter==='all'?'bookings or registrations':filters.find(f=>f[0]===bookingFilter)?.[1]?.toLowerCase()||'activity'} yet</strong><span>Bookings and Open Play registrations you create while signed in will be stored in your Courtly account and appear here.</span><div style="margin-top:14px"><a class="btn" href="/player-dashboard.html?view=discover">Find a court</a></div></div>`}`;
  root.insertAdjacentHTML('beforeend', '<section class="section-block"><div class="section-title"><div><h2>Payment receipts</h2><p>Official receipts appear after the venue owner or coach confirms payment.</p></div></div>' + (paymentReceipts.length ? '<div class="booking-list">' + paymentReceipts.map(r => '<article class="booking-card"><div><strong>' + esc(r.receipt_number) + '</strong><p>' + esc(r.description) + ' · Ref: ' + esc(r.reference) + '</p><small>' + new Date(r.paid_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}) + ' · Email: ' + esc(r.email_status) + '</small></div><div><strong>' + money(r.amount) + '</strong><a class="btn light" href="#" data-download-receipt="' + esc(r.id) + '">Download PDF</a></div></article>').join('') + '</div>' : '<div class="empty-state"><strong>No receipts yet</strong><span>Your receipt will appear here once payment is confirmed. Refresh if your payment was just approved.</span></div>') + '</section>');
  root.querySelectorAll('[data-download-receipt]').forEach(btn=>btn.addEventListener('click',async e=>{e.preventDefault();btn.textContent='Preparing…';btn.setAttribute('aria-busy','true');try{const {data}=await supabase.auth.getSession();const response=await fetch('/api/receipts/download?id='+encodeURIComponent(btn.dataset.downloadReceipt),{headers:{Authorization:'Bearer '+data.session.access_token}});if(!response.ok)throw new Error('Could not download receipt.');const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Courtly-Receipt.pdf';a.click();URL.revokeObjectURL(url);}catch(error){notify(error.message||'Could not download receipt.');}finally{btn.textContent='Download PDF';btn.removeAttribute('aria-busy');}}));
  root.querySelectorAll('[data-booking-period]').forEach(btn=>btn.addEventListener('click',()=>{bookingPeriod=btn.dataset.bookingPeriod;renderBookings();}));
  root.querySelectorAll('[data-booking-filter]').forEach(btn=>btn.addEventListener('click',()=>{bookingFilter=btn.dataset.bookingFilter;renderBookings()}));
  $('bookingFrom')?.addEventListener('change',e=>{bookingFrom=e.target.value;renderBookings()});
  $('bookingTo')?.addEventListener('change',e=>{bookingTo=e.target.value;renderBookings()});
  $('clearBookingDates')?.addEventListener('click',()=>{bookingFrom='';bookingTo='';renderBookings()});
  $('refreshBookings')?.addEventListener('click',async()=>{await loadPlayerActivity();renderBookings();notify('Your bookings have been refreshed.');});
}
function renderTournaments() {
  const tabs=[['active','Active Tournaments'],['stats','Player Stats'],['history','History']];
  let body='';
  if(tournamentTab==='stats') body=`<div class="stat-grid"><div class="stat-card"><small>Court bookings</small><strong>${bookings.length}</strong></div><div class="stat-card"><small>Open Play registrations</small><strong>${registrations.length}</strong></div><div class="stat-card"><small>Self-rated skill</small><strong style="font-size:16px">${esc(profile?.skill_level||'—')}</strong></div><div class="stat-card"><small>Tournament results</small><strong>—</strong></div></div><div class="empty-state"><strong>Tournament ratings are not connected yet</strong><span>Courtly currently stores your self-rated playing level. Official tournament rankings and match results will be shown when tournament features are released.</span></div>`;
  else if(tournamentTab==='history') body=`<div class="empty-state"><div class="empty-icon">◷</div><strong>No tournament history</strong><span>Your completed Courtly tournament entries and results will appear here once tournament registration is available.</span></div>`;
  else body=`<div class="empty-state"><strong>Tournaments are coming to Courtly</strong><span>There are no tournament listings connected to Courtly yet. You can already discover venues, book courts and join venue-hosted Open Play sessions.</span><div style="margin-top:14px"><a class="btn" href="/player-dashboard.html?view=discover">Discover venues</a></div></div>`;
  root.innerHTML=`${heading('COMPETE & CONNECT','My Tournaments','Track competition activity, player stats and your tournament history.')}<div class="tabs">${tabs.map(([key,label])=>`<button data-tournament-tab="${key}" class="${tournamentTab===key?'active':''}">${label}</button>`).join('')}</div>${body}`;
  root.querySelectorAll('[data-tournament-tab]').forEach(btn=>btn.addEventListener('click',()=>{tournamentTab=btn.dataset.tournamentTab;renderTournaments()}));
}
function renderMemberships() {
  root.innerHTML=`${heading('PLAYER BENEFITS','Memberships','Explore membership plans offered by participating sports venues.')}<div class="empty-state"><strong>No venue memberships available yet</strong><span>Courtly's current database does not yet have published membership plans. When venue memberships are introduced, you will be able to compare benefits and manage your subscriptions here.</span><div style="margin-top:14px"><a class="btn light" href="/player-dashboard.html?view=discover">Discover sports venues</a></div></div><div class="membership-note"><b>Coming next:</b> club-specific memberships, included court hours, Open Play credits, renewal dates and membership status. No sample plans or prices are being displayed as real offers.</div>`;
}
async function resolvePlayerAvatar() {
  profileAvatarUrl='';
  const path=profile?.avatar_url;
  if(!path)return;
  if(/^https?:\/\//i.test(path)){profileAvatarUrl=path;return;}
  const {data,error}=await supabase.storage.from('courtly-player-avatars').createSignedUrl(path,3600);
  if(error){console.warn('Could not resolve private player avatar:',error.message);return;}
  profileAvatarUrl=data?.signedUrl||'';
}
function renderProfile() {
  const p=profile||{}; const name=playerDisplayName(p,user);
  root.innerHTML=`${heading('ACCOUNT SETTINGS','Player Profile','Manage your personal information, skill level and profile privacy.')}
    <div class="profile-layout"><section class="panel profile-card"><div class="v2-profile-identity">${avatarMarkup(profileAvatarUrl,name,'profile-large')}<h2>${esc(name)}</h2><p>${esc(p.email||user.email||'')}</p><p style="margin-top:8px"><span class="skill-pill">${esc(p.skill_level||'Beginner')}</span></p><label class="btn light v2-photo-upload">Upload photo<input id="profileAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" style="display:none"></label></div><p class="v2-avatar-status" id="profileAvatarStatus" role="status" aria-live="polite">JPG, PNG or WEBP. Maximum 8 MB.</p><div class="my-sports-card"><h3>My Sports</h3><div class="my-sport-row"><span class="sport-badge">${sports.find(s=>s[0]===p.preferred_sport)?.[1]||'＋'}</span><div><strong>${esc(p.preferred_sport||'Choose your sport')}</strong><small>${esc(p.skill_level||'Beginner')} · Self-rated skill level</small></div></div><div class="rating-note"><b>Official player rating</b><span>Rating provider integration is not connected yet. Your skill level is currently self-reported.</span></div></div></section>
    <form class="panel profile-form" id="profileForm"><div class="panel-head"><h2>Personal details</h2><span class="subtle">Saved to your player account</span></div><div class="form-grid"><div class="field"><label for="profileFullName">Full name</label><input id="profileFullName" required maxlength="100" value="${esc(p.full_name||'')}"></div><div class="field"><label for="profilePlayerName">Player name</label><input id="profilePlayerName" required maxlength="40" value="${esc(p.player_name||'')}"></div><div class="field"><label for="profileEmail">Email address</label><input id="profileEmail" disabled value="${esc(p.email||user.email||'')}"></div><div class="field"><label for="profilePhone">Contact number</label><input id="profilePhone" maxlength="30" value="${esc(p.phone||'')}"></div><div class="field"><label for="profilePublicLocation">Public address / location</label><input id="profilePublicLocation" maxlength="160" value="${esc(p.public_location||'')}" placeholder="City or barangay"><small class="field-help">Use a general area only, such as your city or barangay. Do not enter your home or street address. This appears only while your player profile is public.</small></div><div class="field"><label for="profileSkill">Skill level</label><select id="profileSkill">${['Beginner','Intermediate','Advanced','Professional'].map(s=>`<option ${p.skill_level===s?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label for="profileSport">Preferred sport</label><select id="profileSport"><option value="">Choose a sport</option>${sports.map(([s])=>`<option value="${esc(s)}" ${p.preferred_sport===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div></div>
    <div class="privacy-row"><div><strong>Private player profile</strong><small>Keep your profile details out of public player listings. Your bookings still share necessary contact details with the venue you book.</small></div><label class="toggle"><input id="profilePrivate" type="checkbox" ${p.is_private?'checked':''}><span></span></label></div><button class="btn" type="submit">Save changes</button><div class="subtle" id="profileSaveStatus" style="margin-top:10px" aria-live="polite"></div></form></div>`;
  root.insertAdjacentHTML('beforeend',`<section class="panel" style="margin-top:16px;border-color:#efd4d8"><div class="panel-head"><h2 style="color:#9b2635">Delete account</h2><span class="subtle">Permanent</span></div><p class="subtle" style="line-height:1.7">Deleting your Courtly player account removes your profile, social activity, messages and account access. Booking and payment records that must remain for transaction history are anonymised and disconnected from your account.</p><button class="btn light" id="profileDeleteAccount" type="button" style="border-color:#d9a3aa;color:#9b2635">Delete my Courtly account</button><div class="subtle" id="profileDeleteStatus" style="margin-top:10px" aria-live="polite"></div></section><button class="v2-logout" id="profileLogout" type="button">Log out of Courtly</button>`);
  $('profileLogout').addEventListener('click',logoutPlayer);
  $('profileDeleteAccount').addEventListener('click',deletePlayerAccount);
  $('profileForm').addEventListener('submit',saveProfile);
  $('profileAvatarInput').addEventListener('change',uploadProfileAvatar);
}
function render() { setHeader(); if(view==='discover')return renderDiscover(); if(view==='players')return renderPlayers(); if(view==='invites')return renderClubInvites(); if(view==='tournaments')return renderTournaments(); if(view==='bookings')return renderBookings(); if(view==='memberships')return renderMemberships(); if(view==='profile')return renderProfile(); return renderHome(); }
function selectSport(sport) { selectedSport=sport; profile.preferred_sport=sport; supabase.from('player_profiles').update({preferred_sport:sport,updated_at:new Date().toISOString()}).eq('id',user.id).then(({error})=>{if(error)notify(error.message);}); renderHome(); }
function openSportModal() { $('sportModal').classList.add('open'); $('sportModalSearch').value=''; renderSportOptions(); setTimeout(()=>$('sportModalSearch').focus(),80); }
function renderSportOptions() { const q=$('sportModalSearch').value.toLowerCase(); $('sportModalGrid').innerHTML=sports.filter(([s])=>s.toLowerCase().includes(q)).map(([s,ico])=>`<button class="sport-option ${s===selectedSport?'active':''}" data-sport-option="${esc(s)}">${ico} &nbsp; ${esc(s)}</button>`).join(''); $('sportModalGrid').querySelectorAll('[data-sport-option]').forEach(btn=>btn.addEventListener('click',()=>{$('sportModal').classList.remove('open');selectSport(btn.dataset.sportOption); })); }
async function saveProfile(event) { event.preventDefault(); const status=$('profileSaveStatus'); status.textContent='Saving…'; const update={full_name:$('profileFullName').value.trim(),player_name:$('profilePlayerName').value.trim(),phone:$('profilePhone').value.trim(),public_location:$('profilePublicLocation').value.trim()||null,skill_level:$('profileSkill').value,preferred_sport:$('profileSport').value||null,is_private:$('profilePrivate').checked,updated_at:new Date().toISOString()}; try { const {data,error}=await supabase.from('player_profiles').update(update).eq('id',user.id).select().single(); if(error)throw error; profile={...profile,...data}; selectedSport=profile.preferred_sport||''; status.textContent='Your profile has been saved.';setHeader();notify('Profile updated successfully.'); } catch(error){status.textContent=error.message||'Could not save your profile.';} }
async function uploadProfileAvatar(event) {
  const input=event.target, file=input.files?.[0];if(!file)return;
  const status=$('profileAvatarStatus');
  const showStatus=(message)=>{const node=$('profileAvatarStatus')||status;if(node)node.textContent=message;};
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){
    const message='Choose a JPG, PNG or WEBP image up to 8 MB.';showStatus(message);notify(message);input.value='';return;
  }
  input.disabled=true;input.closest('label')?.setAttribute('aria-disabled','true');showStatus('Uploading your photo…');
  try {
    const {data:sessionData,error:sessionError}=await supabase.auth.getSession();
    if(sessionError||!sessionData?.session||sessionData.session.user.id!==user.id)throw new Error('Please sign in again before uploading your photo.');
    const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';
    const path=`${user.id}/avatar-${crypto.randomUUID()}.${ext}`;
    // Every photo has a new path. Do not ask Storage to replace an existing object.
    const {error:uploadError}=await supabase.storage.from('courtly-player-avatars').upload(path,file,{upsert:false,contentType:file.type});
    if(uploadError)throw uploadError;
    const {data,error}=await supabase.from('player_profiles').update({avatar_url:path,updated_at:new Date().toISOString()}).eq('id',user.id).select().single();
    if(error)throw error;
    profile={...profile,...data};await resolvePlayerAvatar();
    if(view==='profile')renderProfile();setHeader();showStatus('Your profile photo has been updated.');notify('Profile picture updated.');
  }catch(error){
    const message=error.message||'Could not upload your photo. Please try again.';showStatus(message);notify(message);
  }finally{
    input.disabled=false;input.value='';input.closest('label')?.removeAttribute('aria-disabled');
  }
}
async function loadPlayerActivity() {
  const bookingResult=await supabase.from('bookings').select('id,reference,customer_name,customer_email,starts_at,ends_at,duration_hours,total,status,payment_status,payment_method,created_at,venues(name,slug,city),courts(name,sport)').eq('player_id',user.id).order('created_at',{ascending:false}).limit(100);
  if(bookingResult.error)throw bookingResult.error; bookings=bookingResult.data||[];
  const regResult=await supabase.from('open_play_registrations').select('id,registration_reference,event_title,venue_name,venue_slug,event_date,event_time,fee,transaction_fee,transaction_fee_payer,player_total,payment_status,registration_status,created_at').eq('player_id',user.id).order('created_at',{ascending:false}).limit(100);
  if(regResult.error)throw regResult.error; registrations=regResult.data||[];
  const {data:coachRows,error:coachError}=await supabase.from('coaching_bookings').select('id,payment_status').eq('player_id',user.id).eq('payment_status','confirmed').limit(100);
  if(coachError) console.warn('Could not load coaching receipt triggers:',coachError.message);
  const {data:sessionData}=await supabase.auth.getSession(); const token=sessionData?.session?.access_token;
  if(token){
    const tasks=[...bookings.filter(b=>b.payment_status==='confirmed').map(b=>({type:'court_booking',id:b.id})),...(coachRows||[]).map(b=>({type:'coaching_booking',id:b.id}))];
    for(const item of tasks){try{await fetch('/api/receipts/issue',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(item)});}catch(e){console.warn('Receipt retry deferred:',e.message);}}
  }
  const receiptResult=await supabase.from('payment_receipts').select('id,receipt_number,description,reference,amount,paid_at,email_status').eq('player_id',user.id).order('paid_at',{ascending:false}).limit(100);
  if(receiptResult.error){if(receiptResult.error.code==='42P01'||receiptResult.error.code==='PGRST205'){console.warn('Apply the Courtly payment receipts migration in Supabase to enable receipt history.');paymentReceipts=[];}else throw receiptResult.error;}
  else paymentReceipts=receiptResult.data||[];
}
async function loadDiscoverCoaches(){
  discoverCoachesError='';
  const {data,error}=await supabase.rpc('browse_coaches',{p_search:null,p_sport:null,p_city:null,p_limit:100,p_offset:0});
  if(error){discoverCoachesError=error.message;console.warn('Coach directory:',error.message);}
  else{discoverCoaches=data||[];discoverCoachesLoaded=true;}
  if(view==='discover'&&discoverMode==='coaches')renderDiscover();
}
async function loadVenues() {
  const {data,error}=await supabase.from('venues').select('id,slug,name,address,city,sport,logo_url,cover_url,is_published,courts(id,name,sport,hourly_rate,off_peak_rate,is_active,image_url)').eq('is_published',true).order('created_at',{ascending:false});
  if(error)throw error;venues=(data||[]).map(v=>({...v,courts:(v.courts||[]).filter(c=>c.is_active!==false)}));
}
async function loadOpenPlayEvents() {
  const {data,error}=await supabase.from('open_play_events').select('id,title,details,banner_url,starts_at,location_text,fee,registration_limit,venue_id,venues(name,slug,city,sport)').eq('is_published',true).gte('starts_at',new Date().toISOString()).order('starts_at',{ascending:true}).limit(30);
  if(error)throw error;openPlayEvents=data||[];
  if(openPlayEvents.length){const {data:counts,error:countError}=await supabase.rpc('get_open_play_registration_counts',{p_event_ids:openPlayEvents.map(e=>e.id)});if(!countError){const countMap=new Map((counts||[]).map(r=>[String(r.event_id),Number(r.registered_count||0)]));openPlayEvents=openPlayEvents.map(e=>({...e,registered_count:countMap.get(e.id)||0}));}}
}
async function refreshCommunityActivityBadge(){
 if(!supabase||!user)return;
 const {data,error}=await supabase.rpc('get_community_activity_unread_count');
 if(error){console.warn('Could not load activity notifications:',error.message);return;}
 const count=Math.max(0,Number(data||0));
 document.querySelectorAll('[data-community-badge]').forEach(node=>{
  node.textContent=count>99?'99+':String(count);
  node.hidden=count===0;
 });
}
async function init() {
  if(!supabase){root.innerHTML=`<div class="empty-state"><strong>Supabase is not configured</strong><span>${esc(supabaseConfigError)}</span></div>`;return;}
  const {data:{session},error:sessionError}=await supabase.auth.getSession(); if(sessionError)throw sessionError;
  if(!session?.user){
    const confirmed = new URLSearchParams(location.search).get('welcome') === '1';
    location.replace(confirmed ? '/player-login.html?confirmed=1' : '/player-login.html');
    return;
  }
  user=session.user;
  if(user.user_metadata?.account_type!=='player'){location.replace('/login.html?message=Please+use+your+player+account');return;}
  profile=await syncPlayerProfile(supabase,user);
  selectedSport=profile.preferred_sport||'';
  await resolvePlayerAvatar();
  await Promise.all([loadVenues(),loadOpenPlayEvents(),loadPlayerActivity(),loadPlayerHomePosts(),loadSportsNews()]);
  await refreshCommunityActivityBadge();
  window.setInterval(refreshCommunityActivityBadge,30000);
  const refreshSportsNews=async()=>{
    if(document.visibilityState==='hidden')return;
    await loadSportsNews();
    const section=$('sportsNewsSection');
    if(view==='home'&&section)section.outerHTML=sportsNewsSection();
  };
  window.setInterval(refreshSportsNews,60*1000);
  window.addEventListener('focus',refreshSportsNews);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshSportsNews();});
  window.addEventListener('focus',refreshCommunityActivityBadge);
  if(view==='players')await Promise.all([loadPlayerDirectory(directorySearch),loadPlayerFriendRequests()]);
  if(view==='invites')await loadPlayerClubInvites();
  render();
  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === '1') {
    notify(`Welcome to Courtly, ${playerDisplayName(profile,user)}! Your player profile is synced.`);
    history.replaceState({}, '', '/player-dashboard.html' + (view === 'home' ? '' : `?view=${encodeURIComponent(view)}`));
  }
  if(!selectedSport&&view==='home')openSportModal();
}
const mobileMenuButton = $('mobileMenuButton');
const mobileSidebar = $('playerSidebar');
const mobileNavBackdrop = $('mobileNavBackdrop');
const mobileViewport = window.matchMedia('(max-width: 760px)');
function setMobileMenu(open) {
  const shouldOpen = Boolean(open && mobileViewport.matches);
  mobileSidebar.classList.toggle('mobile-open', shouldOpen);
  mobileNavBackdrop.classList.toggle('open', shouldOpen);
  document.body.classList.toggle('mobile-menu-open', shouldOpen);
  mobileMenuButton.setAttribute('aria-expanded', String(shouldOpen));
  mobileMenuButton.setAttribute('aria-label', shouldOpen ? 'Close navigation menu' : 'Open navigation menu');
  mobileSidebar.setAttribute('aria-hidden', String(mobileViewport.matches && !shouldOpen));
  if (shouldOpen) {
    const firstLink = mobileSidebar.querySelector('.nav-link');
    window.setTimeout(() => firstLink?.focus(), 80);
  }
}
mobileMenuButton.addEventListener('click', () => {
  setMobileMenu(mobileMenuButton.getAttribute('aria-expanded') !== 'true');
});
mobileNavBackdrop.addEventListener('click', () => { setMobileMenu(false); mobileMenuButton.focus(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobileMenuButton.getAttribute('aria-expanded') === 'true') {
    setMobileMenu(false);
    mobileMenuButton.focus();
  }
});
mobileViewport.addEventListener?.('change', () => setMobileMenu(false));
mobileSidebar.setAttribute('aria-hidden', String(mobileViewport.matches));

$('closeSportModal').addEventListener('click',()=>$('sportModal').classList.remove('open'));
$('sportModal').addEventListener('click',e=>{if(e.target===$('sportModal'))$('sportModal').classList.remove('open')});
$('sportModalSearch').addEventListener('input',renderSportOptions);
document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',async e=>{if(link.dataset.external==='true')return;e.preventDefault();setMobileMenu(false);mobileMenuButton.focus();view=link.dataset.view;history.pushState({},'',`/player-dashboard.html?view=${view}`);if(view==='players')await loadPlayerDirectory(directorySearch);if(view==='invites')await loadPlayerClubInvites();render();}));
window.addEventListener('popstate',async()=>{setMobileMenu(false);view=new URLSearchParams(location.search).get('view')||'home';if(view==='players')await loadPlayerDirectory(directorySearch);if(view==='invites')await loadPlayerClubInvites();render();});
async function deletePlayerAccount(){
  const status=$('profileDeleteStatus'),button=$('profileDeleteAccount');
  if(!confirm('Permanently delete your Courtly player account? This cannot be undone.'))return;
  const confirmation=prompt('Type DELETE to permanently delete your Courtly account.');
  if(confirmation!=='DELETE'){if(status)status.textContent='Account deletion cancelled.';return;}
  button.disabled=true;button.textContent='Deleting account…';if(status)status.textContent='Removing your Courtly account…';
  try{
    const {data:{session},error:sessionError}=await supabase.auth.getSession();
    if(sessionError||!session?.access_token)throw new Error('Please sign in again before deleting your account.');
    const response=await fetch('/api/account/delete',{method:'POST',headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({confirmation:'DELETE'})});
    let result={};try{result=await response.json();}catch{}
    if(!response.ok||result.success!==true)throw new Error(result.message||result.error||'Courtly could not delete your account.');
    try{await supabase.auth.signOut({scope:'local'});}catch{}
    location.replace('/?account=deleted');
  }catch(error){
    button.disabled=false;button.textContent='Delete my Courtly account';
    if(status)status.textContent=error.message||'Could not delete your account. Please try again.';
  }
}
async function logoutPlayer(){await supabase.auth.signOut();location.replace('/player-login.html');}
$('logoutButton').addEventListener('click',logoutPlayer);
$('topLogoutButton')?.addEventListener('click',logoutPlayer);
const topProfileButton=$('topProfileButton'), topProfileMenu=$('topProfileMenu');
function setTopProfileMenu(open){
  if(!topProfileButton||!topProfileMenu)return;
  topProfileMenu.hidden=!open;
  topProfileButton.setAttribute('aria-expanded',String(open));
}
topProfileButton?.addEventListener('click',event=>{
  event.stopPropagation();
  setTopProfileMenu(topProfileMenu.hidden);
});
topProfileMenu?.addEventListener('click',event=>event.stopPropagation());
document.addEventListener('click',()=>setTopProfileMenu(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape')setTopProfileMenu(false);});
supabase?.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||!session)location.replace('/player-login.html');});
init().catch(error=>{console.error('Courtly player dashboard failed:',error);root.innerHTML=`<div class="empty-state"><div class="empty-icon">!</div><strong>We could not load your player dashboard</strong><span>${esc(error.message||'Please refresh the page. If this is a new deployment, run the player account SQL migration in Supabase first.')}</span></div>`;});
