import { supabase, supabaseConfigError } from './supabase-client.js';
import { syncPlayerProfile, playerDisplayName } from './player-profile-sync.js';

const $ = (id) => document.getElementById(id);
const root = $('viewRoot');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const sports = [
  ['Pickleball','🏓'],['Basketball','🏀'],['Padel','🎾'],['Archery','🏹'],['Badminton','🏸'],['Lawn Tennis','🎾'],['Billiards','🎱'],['Dart','🎯'],['Golf','⛳'],['Boxing','🥊'],['Swimming','🏊'],['Muay Thai','🥊'],['Volleyball','🏐'],['Gym','🏋️'],['Gymnastics','🤸'],['Table Tennis','🏓'],['Yoga','🧘'],['Dance Studio','💃'],['Football','⚽'],['Futsal','⚽'],['Bowling','🎳'],['Other','＋']
];
let user = null, profile = null, profileAvatarUrl = '', venues = [], openPlayEvents = [], bookings = [], registrations = [];
let view = new URLSearchParams(location.search).get('view') || 'home';
let selectedSport = '', discoverSearch = '', discoverCity = '', discoverSport = '', discoverMode = new URLSearchParams(location.search).get('mode') === 'openplay' ? 'openplay' : 'list';
let bookingFilter = 'all', tournamentTab = 'active', bookingFrom = '', bookingTo = '';
let toastTimer;

function notify(text) { const node=$('toast'); node.textContent=text; node.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('show'),3400); }
function initials(name='Player') { return String(name).trim().split(/\s+/).map(part=>part[0]||'').join('').slice(0,2).toUpperCase() || 'P'; }
function avatarMarkup(url,name='Player',klass='avatar') { return `<div class="${klass}">${url?`<img src="${esc(url)}" alt="${esc(name)} profile photo">`:esc(initials(name))}</div>`; }
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
  return `<article class="venue-card"><div class="venue-cover">${image?`<img loading="lazy" src="${esc(image)}" alt="${esc(v.name)}">`:esc(initials(v.name))}<span class="sport-label">${esc(names[0]||v.sport||'Sports venue')}</span></div><div class="venue-body"><h3>${esc(v.name)}</h3><div class="venue-loc">⌖ ${esc([v.city,v.address].filter(Boolean).join(' · ')||'Location not provided')}</div><div class="venue-tags">${names.slice(0,3).map(s=>`<span class="tag">${esc(s)}</span>`).join('')}<span class="tag">${cs.length} ${cs.length===1?'court':'courts'}</span></div><div class="venue-foot"><div class="price">${min===null?'Rates not listed':'From'}<b>${min===null?'—':`${money(min)}/hr`}</b></div><a class="btn" href="/venue.html?slug=${encodeURIComponent(v.slug||'')}">View venue →</a></div></div></article>`;
}
function eventCard(event) {
  const venue=event.venues||{}; const image=event.banner_url||''; const date=formatDate(event.starts_at); const time=formatTime(event.starts_at);
  const spots=event.registration_limit ? `${Number(event.registered_count||0)} / ${event.registration_limit} spots` : 'Open registration';
  return `<article class="venue-card"><div class="venue-cover">${image?`<img loading="lazy" src="${esc(image)}" alt="${esc(event.title)}">`:'◉'}<span class="sport-label">OPEN PLAY</span></div><div class="venue-body"><h3>${esc(event.title)}</h3><div class="venue-loc">${esc(venue.name||'Courtly venue')} · ${esc(venue.city||event.location_text||'Location to be confirmed')}<br>${esc(date)} · ${esc(time)}</div><div class="venue-tags"><span class="tag">${esc(venue.sport||'Social play')}</span><span class="tag">${esc(spots)}</span></div><div class="venue-foot"><div class="price">${Number(event.fee||0)>0?'Total at checkout':'Free registration'}<b>${money(Number(event.fee||0)+(Number(event.fee||0)>0?10:0))}</b><small>${Number(event.fee||0)>0?`${money(event.fee)} registration + ₱10 transaction fee`:'No transaction fee'}</small></div><a class="btn" href="/venue.html?slug=${encodeURIComponent(venue.slug||'')}">View session →</a></div></div></article>`;
}
function heading(kicker,title,desc,action='') { return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(desc)}</p></div>${action}</div>`; }
function setHeader() {
  const name=playerDisplayName(profile,user);
  $('sideName').textContent=name; $('topName').textContent=name; $('sideSkill').textContent=profile?.skill_level||'Player';
  const img=profileAvatarUrl; $('sideAvatar').innerHTML=img?`<img src="${esc(img)}" alt="">`:esc(initials(name)); $('topAvatar').innerHTML=img?`<img src="${esc(img)}" alt="">`:esc(initials(name));
  document.querySelectorAll('.nav-link').forEach(link=>link.classList.toggle('active',link.dataset.view===view));
  $('crumbText').textContent=({home:'Home',discover:'Discover',tournaments:'My Tournaments',bookings:'My Bookings',memberships:'Memberships',profile:'Profile'})[view]||'Home';
}
function renderHome() {
  const name=playerDisplayName(profile,user).split(' ')[0];
  const current=selectedSport||profile?.preferred_sport||'';
  const homeSports=[...new Set(['Pickleball','Basketball','Padel','Badminton','Lawn Tennis','Volleyball',...(current?[current]:[])])];
  const chips=homeSports.map(s=>`<button class="sport-chip ${s===current?'active':''}" data-home-sport="${esc(s)}"><span class="sico">${sports.find(x=>x[0]===s)?.[1]||'⚽'}</span>${esc(s)}</button>`).join('');
  const list=venues.filter(v=>!current||(v.courts||[]).some(c=>String(c.sport||'').toLowerCase().includes(current.toLowerCase()))).slice(0,3);
  const upcoming=normalizeBookings().filter(r=>r.starts_at&&new Date(r.starts_at)>=new Date()&&r.status!=='cancelled').slice(0,2);
  root.innerHTML=`${heading('PLAYER HOME',`Welcome back, ${name}`,current?`Your Courtly home feed is focused on ${current}. Find a venue, book a court or join an upcoming session.`:'Choose a sport to personalize your Courtly home feed.')}
    <section class="panel sport-panel"><div class="sport-top"><div><div class="eyebrow">PLAY ON</div><h2>${current?`Explore ${esc(current)}`:'Select your sport'}</h2><p>${current?'Your home feed is filtered for this sport.':'Pick a sport to unlock the home marketplace.'}</p></div><button class="btn light" id="openSportModal">${current?'Change sport':'Choose sport'}</button></div><div class="sport-chips">${chips}<button class="sport-chip more" id="openSportModal">＋ More sports</button></div></section>
    <div class="quick-grid"><a class="quick-card" href="/player-dashboard.html?view=discover&amp;mode=openplay"><span class="quick-icon">◉</span><span><strong>Open Play</strong><small>Find social games and sessions</small></span></a><a class="quick-card" href="/player-dashboard.html?view=discover"><span class="quick-icon">▦</span><span><strong>Court Rental</strong><small>Choose a venue and timeslot</small></span></a><a class="quick-card" href="/player-dashboard.html?view=memberships"><span class="quick-icon">♛</span><span><strong>Memberships</strong><small>Explore venue member plans</small></span></a><a class="quick-card" href="/player-dashboard.html?view=tournaments"><span class="quick-icon">♜</span><span><strong>Tournaments</strong><small>Competition activity</small></span></a><a class="quick-card" href="/player-dashboard.html?view=discover"><span class="quick-icon">⌖</span><span><strong>Sports Hubs</strong><small>Discover nearby venues</small></span></a><a class="quick-card" href="/player-dashboard.html?view=bookings"><span class="quick-icon">▣</span><span><strong>My Bookings</strong><small>Manage reservations</small></span></a><a class="quick-card" href="/player-dashboard.html?view=profile"><span class="quick-icon">♙</span><span><strong>My Profile</strong><small>Personal details and privacy</small></span></a><a class="quick-card" href="/player-dashboard.html?view=tournaments"><span class="quick-icon">✦</span><span><strong>Player Stats</strong><small>View your player activity</small></span></a></div>
    <section class="section-block"><div class="section-title"><div><h2>Featured games</h2><p>Published Open Play sessions from Courtly venues.</p></div><a class="link" href="/player-dashboard.html?view=discover&amp;mode=openplay">Explore Open Play →</a></div><div class="venue-grid">${openPlayEvents.length?openPlayEvents.slice(0,3).map(eventCard).join(''):'<div class="venue-empty" style="grid-column:1/-1"><strong>No upcoming Open Play sessions yet</strong>When venues publish upcoming sessions, they will appear here.</div>'}</div></section>
    <section class="section-block"><div class="section-title"><div><h2>Must try this week</h2><p>Sports venues you can discover and book.</p></div><a class="link" href="/player-dashboard.html?view=discover">View all venues →</a></div><div class="venue-grid">${list.length?list.map(venueCard).join(''):'<div class="venue-empty" style="grid-column:1/-1"><strong>No venues match this sport yet</strong>Choose another sport or view all registered venues.</div>'}</div></section>
    <section class="section-block"><div class="section-title"><div><h2>Your upcoming activity</h2><p>Bookings attached to your signed-in player account.</p></div><a class="link" href="/player-dashboard.html?view=bookings">View all bookings →</a></div>${upcoming.length?`<div class="booking-list">${upcoming.map(bookingCard).join('')}</div>`:'<div class="empty-state"><div class="empty-icon">▣</div><strong>No upcoming bookings yet</strong><span>When you reserve a court or register for Open Play while signed in, your activity will appear here.</span><div style="margin-top:14px"><a class="btn" href="/player-dashboard.html?view=discover">Find a court</a></div></div>'}</section>`;
  root.querySelectorAll('[data-home-sport]').forEach(btn=>btn.addEventListener('click',()=>selectSport(btn.dataset.homeSport)));
  root.querySelectorAll('#openSportModal').forEach(btn=>btn.addEventListener('click',openSportModal));
}
function renderDiscover() {
  const cities=[...new Set(venues.map(v=>v.city).filter(Boolean))].sort();
  const sportOptions=[...new Set([...sports.map(s=>s[0]),...allVenueSports()])].sort();
  const filtered=venues.filter(v=>{
    const cs=v.courts||[]; const hay=[v.name,v.city,v.address,...cs.map(c=>c.name),...cs.map(c=>c.sport)].join(' ').toLowerCase();
    return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))&&(!discoverCity||v.city===discoverCity)&&(!discoverSport||cs.some(c=>String(c.sport||'').toLowerCase().includes(discoverSport.toLowerCase())));
  });
  const filteredEvents=openPlayEvents.filter(event=>{
    const v=event.venues||{}; const hay=[event.title,event.location_text,v.name,v.city,v.sport].join(' ').toLowerCase();
    return (!discoverSearch||hay.includes(discoverSearch.toLowerCase()))&&(!discoverCity||v.city===discoverCity)&&(!discoverSport||String(v.sport||'').toLowerCase().includes(discoverSport.toLowerCase()));
  });
  let content=''; let count=filtered.length;
  if(discoverMode==='openplay'){
    count=filteredEvents.length;
    content=filteredEvents.length?`<div class="venue-grid">${filteredEvents.map(eventCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">◉</div><strong>No upcoming Open Play sessions</strong><span>Published sessions appear here automatically. Check back as more venues add games.</span></div>`;
  }else if(discoverMode==='map'){
    content=filtered.length?`<div class="map-list">${filtered.map(v=>{const image=v.cover_url||v.logo_url||(v.courts||[]).find(c=>c.image_url)?.image_url||'';const query=encodeURIComponent([v.name,v.address,v.city].filter(Boolean).join(', '));return `<article class="map-card"><div class="map-thumb">${image?`<img loading="lazy" src="${esc(image)}" alt="">`:'⌖'}</div><div><h3>${esc(v.name)}</h3><p>${esc([v.address,v.city].filter(Boolean).join(', ')||'Location not provided')}<br>${(v.courts||[]).filter(c=>c.is_active!==false).length} active courts</p><a class="map-open" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${query}">Open in Google Maps ↗</a><br><a class="map-open" href="/venue.html?slug=${encodeURIComponent(v.slug||'')}">View booking page →</a></div></article>`}).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">⌖</div><strong>No mapped venues found</strong><span>Try changing your filters. Venue locations open in Google Maps based on the address stored by each venue.</span></div>`;
  }else{
    content=filtered.length?`<div class="venue-grid">${filtered.map(venueCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">⌕</div><strong>No venues found</strong><span>Try another sport, location or search term. Published venues will appear here automatically.</span></div>`;
  }
  root.innerHTML=`${heading('DISCOVER COURTLY','Discover sports venues','Find a court, sports hub or Open Play venue near you.')}
    <section class="toolbar"><div class="search"><input id="discoverSearch" type="search" placeholder="Search by venue name or location…" value="${esc(discoverSearch)}"></div><select id="discoverSport"><option value="">All sports</option>${sportOptions.map(s=>`<option value="${esc(s)}" ${discoverSport===s?'selected':''}>${esc(s)}</option>`).join('')}</select><select id="discoverCity"><option value="">All locations</option>${cities.map(c=>`<option value="${esc(c)}" ${discoverCity===c?'selected':''}>${esc(c)}</option>`).join('')}</select><div class="segmented"><button data-discover-mode="list" class="${discoverMode==='list'?'active':''}">Venues</button><button data-discover-mode="openplay" class="${discoverMode==='openplay'?'active':''}">Open Play</button><button data-discover-mode="map" class="${discoverMode==='map'?'active':''}">Map</button></div></section>
    <div class="section-title"><div><h2>${count} ${discoverMode==='openplay'?(count===1?'session':'sessions'):(count===1?'venue':'venues')} found</h2><p>${discoverMode==='openplay'?'Upcoming published Open Play sessions.':'Published Courtly venues with active courts.'}</p></div></div>${content}`;
  $('discoverSearch')?.addEventListener('input',e=>{const value=e.target.value;const caret=e.target.selectionStart;discoverSearch=value;renderDiscover();const next=$('discoverSearch');if(next){next.focus();next.setSelectionRange(caret,caret);}});
  $('discoverSport')?.addEventListener('change',e=>{discoverSport=e.target.value;renderDiscover()});
  $('discoverCity')?.addEventListener('change',e=>{discoverCity=e.target.value;renderDiscover()});
  root.querySelectorAll('[data-discover-mode]').forEach(btn=>btn.addEventListener('click',()=>{discoverMode=btn.dataset.discoverMode;renderDiscover()}));
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
  const filters=[['all','All',countAll],['openplay','Open Play',open],['court','Court Rental',courts],['sessions','Sessions',sessions]];
  const rows=all.filter(r=>{
    const itemDate=new Date(r.starts_at||r.created_at).toISOString().slice(0,10);
    const matchesType=bookingFilter==='all'||(bookingFilter==='sessions'?false:r.type===bookingFilter);
    return matchesType&&(!bookingFrom||itemDate>=bookingFrom)&&(!bookingTo||itemDate<=bookingTo);
  });
  root.innerHTML=`${heading('PLAYER ACTIVITY','My Bookings','Manage your court reservations and Open Play registrations.')}
    <div class="stat-grid"><div class="stat-card"><small>All</small><strong>${countAll}</strong></div><div class="stat-card"><small>Open Play</small><strong>${open}</strong></div><div class="stat-card"><small>Court Rental</small><strong>${courts}</strong></div><div class="stat-card"><small>Sessions</small><strong>${sessions}</strong></div></div>
    <div class="toolbar"><div class="subtle">Filter your activity</div><div class="tabs" style="margin:0;flex:1">${filters.map(([key,label,n])=>`<button data-booking-filter="${key}" class="${bookingFilter===key?'active':''}">${label} <span style="opacity:.65">${n}</span></button>`).join('')}</div><label class="date-filter">From <input id="bookingFrom" type="date" value="${esc(bookingFrom)}"></label><label class="date-filter">To <input id="bookingTo" type="date" value="${esc(bookingTo)}"></label><button class="btn light" id="clearBookingDates">Clear dates</button><button class="btn light" id="refreshBookings">↻ Refresh</button></div>
    <div class="section-title"><div><h2>${bookingFilter==='all'?'All activity':filters.find(f=>f[0]===bookingFilter)?.[1]||'Bookings'}</h2><p>${rows.length} ${rows.length===1?'record':'records'}</p></div></div>
    ${rows.length?`<div class="booking-list">${rows.map(bookingCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">▣</div><strong>No ${bookingFilter==='all'?'bookings or registrations':filters.find(f=>f[0]===bookingFilter)?.[1]?.toLowerCase()||'activity'} yet</strong><span>Bookings and Open Play registrations you create while signed in will be stored in your Courtly account and appear here.</span><div style="margin-top:14px"><a class="btn" href="/player-dashboard.html?view=discover">Find a court</a></div></div>`}`;
  root.querySelectorAll('[data-booking-filter]').forEach(btn=>btn.addEventListener('click',()=>{bookingFilter=btn.dataset.bookingFilter;renderBookings()}));
  $('bookingFrom')?.addEventListener('change',e=>{bookingFrom=e.target.value;renderBookings()});
  $('bookingTo')?.addEventListener('change',e=>{bookingTo=e.target.value;renderBookings()});
  $('clearBookingDates')?.addEventListener('click',()=>{bookingFrom='';bookingTo='';renderBookings()});
  $('refreshBookings')?.addEventListener('click',async()=>{await loadPlayerActivity();renderBookings();notify('Your bookings have been refreshed.');});
}
function renderTournaments() {
  const tabs=[['active','Active Tournaments'],['stats','Player Stats'],['history','History']];
  let body='';
  if(tournamentTab==='stats') body=`<div class="stat-grid"><div class="stat-card"><small>Court bookings</small><strong>${bookings.length}</strong></div><div class="stat-card"><small>Open Play registrations</small><strong>${registrations.length}</strong></div><div class="stat-card"><small>Self-rated skill</small><strong style="font-size:16px">${esc(profile?.skill_level||'—')}</strong></div><div class="stat-card"><small>Tournament results</small><strong>—</strong></div></div><div class="empty-state"><div class="empty-icon">♜</div><strong>Tournament ratings are not connected yet</strong><span>Courtly currently stores your self-rated playing level. Official tournament rankings and match results will be shown when tournament features are released.</span></div>`;
  else if(tournamentTab==='history') body=`<div class="empty-state"><div class="empty-icon">◷</div><strong>No tournament history</strong><span>Your completed Courtly tournament entries and results will appear here once tournament registration is available.</span></div>`;
  else body=`<div class="empty-state"><div class="empty-icon">♜</div><strong>Tournaments are coming to Courtly</strong><span>There are no tournament listings connected to Courtly yet. You can already discover venues, book courts and join venue-hosted Open Play sessions.</span><div style="margin-top:14px"><a class="btn" href="/player-dashboard.html?view=discover">Discover venues</a></div></div>`;
  root.innerHTML=`${heading('COMPETE & CONNECT','My Tournaments','Track competition activity, player stats and your tournament history.')}<div class="tabs">${tabs.map(([key,label])=>`<button data-tournament-tab="${key}" class="${tournamentTab===key?'active':''}">${label}</button>`).join('')}</div>${body}`;
  root.querySelectorAll('[data-tournament-tab]').forEach(btn=>btn.addEventListener('click',()=>{tournamentTab=btn.dataset.tournamentTab;renderTournaments()}));
}
function renderMemberships() {
  root.innerHTML=`${heading('PLAYER BENEFITS','Memberships','Explore membership plans offered by participating sports venues.')}<div class="empty-state"><div class="empty-icon">♛</div><strong>No venue memberships available yet</strong><span>Courtly's current database does not yet have published membership plans. When venue memberships are introduced, you will be able to compare benefits and manage your subscriptions here.</span><div style="margin-top:14px"><a class="btn light" href="/player-dashboard.html?view=discover">Discover sports venues</a></div></div><div class="membership-note"><b>Coming next:</b> club-specific memberships, included court hours, Open Play credits, renewal dates and membership status. No sample plans or prices are being displayed as real offers.</div>`;
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
    <div class="profile-layout"><section class="panel profile-card">${avatarMarkup(profileAvatarUrl,name,'profile-large')}<h2>${esc(name)}</h2><p>${esc(p.email||user.email||'')}</p><p style="margin-top:8px"><span class="skill-pill">${esc(p.skill_level||'Beginner')}</span></p><label class="btn light" style="margin-top:15px;cursor:pointer">Upload photo<input id="profileAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" style="display:none"></label><div class="my-sports-card"><h3>My Sports</h3><div class="my-sport-row"><span class="sport-badge">${sports.find(s=>s[0]===p.preferred_sport)?.[1]||'＋'}</span><div><strong>${esc(p.preferred_sport||'Choose your sport')}</strong><small>${esc(p.skill_level||'Beginner')} · Self-rated skill level</small></div></div><div class="rating-note"><b>Official player rating</b><span>Rating provider integration is not connected yet. Your skill level is currently self-reported.</span></div></div></section>
    <form class="panel profile-form" id="profileForm"><div class="panel-head"><h2>Personal details</h2><span class="subtle">Saved to your player account</span></div><div class="form-grid"><div class="field"><label for="profileFullName">Full name</label><input id="profileFullName" required maxlength="100" value="${esc(p.full_name||'')}"></div><div class="field"><label for="profilePlayerName">Player name</label><input id="profilePlayerName" required maxlength="40" value="${esc(p.player_name||'')}"></div><div class="field"><label for="profileEmail">Email address</label><input id="profileEmail" disabled value="${esc(p.email||user.email||'')}"></div><div class="field"><label for="profilePhone">Contact number</label><input id="profilePhone" maxlength="30" value="${esc(p.phone||'')}"></div><div class="field"><label for="profileSkill">Skill level</label><select id="profileSkill">${['Beginner','Intermediate','Advanced','Professional'].map(s=>`<option ${p.skill_level===s?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label for="profileSport">Preferred sport</label><select id="profileSport"><option value="">Choose a sport</option>${sports.map(([s])=>`<option value="${esc(s)}" ${p.preferred_sport===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div></div>
    <div class="privacy-row"><div><strong>Private player profile</strong><small>Keep your profile details out of public player listings. Your bookings still share necessary contact details with the venue you book.</small></div><label class="toggle"><input id="profilePrivate" type="checkbox" ${p.is_private?'checked':''}><span></span></label></div><button class="btn" type="submit">Save changes</button><div class="subtle" id="profileSaveStatus" style="margin-top:10px" aria-live="polite"></div></form></div>`;
  $('profileForm').addEventListener('submit',saveProfile);
  $('profileAvatarInput').addEventListener('change',uploadProfileAvatar);
}
function render() { setHeader(); if(view==='discover')return renderDiscover(); if(view==='tournaments')return renderTournaments(); if(view==='bookings')return renderBookings(); if(view==='memberships')return renderMemberships(); if(view==='profile')return renderProfile(); return renderHome(); }
function selectSport(sport) { selectedSport=sport; profile.preferred_sport=sport; supabase.from('player_profiles').update({preferred_sport:sport,updated_at:new Date().toISOString()}).eq('id',user.id).then(({error})=>{if(error)notify(error.message);}); renderHome(); }
function openSportModal() { $('sportModal').classList.add('open'); $('sportModalSearch').value=''; renderSportOptions(); setTimeout(()=>$('sportModalSearch').focus(),80); }
function renderSportOptions() { const q=$('sportModalSearch').value.toLowerCase(); $('sportModalGrid').innerHTML=sports.filter(([s])=>s.toLowerCase().includes(q)).map(([s,ico])=>`<button class="sport-option ${s===selectedSport?'active':''}" data-sport-option="${esc(s)}">${ico} &nbsp; ${esc(s)}</button>`).join(''); $('sportModalGrid').querySelectorAll('[data-sport-option]').forEach(btn=>btn.addEventListener('click',()=>{$('sportModal').classList.remove('open');selectSport(btn.dataset.sportOption); })); }
async function saveProfile(event) { event.preventDefault(); const status=$('profileSaveStatus'); status.textContent='Saving…'; const update={full_name:$('profileFullName').value.trim(),player_name:$('profilePlayerName').value.trim(),phone:$('profilePhone').value.trim(),skill_level:$('profileSkill').value,preferred_sport:$('profileSport').value||null,is_private:$('profilePrivate').checked,updated_at:new Date().toISOString()}; try { const {data,error}=await supabase.from('player_profiles').update(update).eq('id',user.id).select().single(); if(error)throw error; profile={...profile,...data}; selectedSport=profile.preferred_sport||''; status.textContent='Your profile has been saved.';setHeader();notify('Profile updated successfully.'); } catch(error){status.textContent=error.message||'Could not save your profile.';} }
async function uploadProfileAvatar(event) { const file=event.target.files?.[0]; if(!file)return; if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){notify('Choose a JPG, PNG or WEBP image up to 8 MB.');event.target.value='';return;} try { const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';const path=`${user.id}/avatar-${Date.now()}.${ext}`;const {error:uploadError}=await supabase.storage.from('courtly-player-avatars').upload(path,file,{upsert:true,contentType:file.type});if(uploadError)throw uploadError;const {data,error}=await supabase.from('player_profiles').update({avatar_url:path,updated_at:new Date().toISOString()}).eq('id',user.id).select().single();if(error)throw error;profile={...profile,...data};await resolvePlayerAvatar();renderProfile();setHeader();notify('Profile picture updated.');}catch(error){notify(error.message||'Could not upload profile picture.');} }
async function loadPlayerActivity() {
  const bookingResult=await supabase.from('bookings').select('id,reference,customer_name,customer_email,starts_at,ends_at,duration_hours,total,status,payment_status,payment_method,created_at,venues(name,slug,city),courts(name,sport)').eq('player_id',user.id).order('created_at',{ascending:false}).limit(100);
  if(bookingResult.error)throw bookingResult.error; bookings=bookingResult.data||[];
  const regResult=await supabase.from('open_play_registrations').select('id,registration_reference,event_title,venue_name,venue_slug,event_date,event_time,fee,transaction_fee,transaction_fee_payer,player_total,payment_status,registration_status,created_at').eq('player_id',user.id).order('created_at',{ascending:false}).limit(100);
  if(regResult.error)throw regResult.error; registrations=regResult.data||[];
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
  await Promise.all([loadVenues(),loadOpenPlayEvents(),loadPlayerActivity()]);
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
document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();setMobileMenu(false);mobileMenuButton.focus();view=link.dataset.view;history.pushState({},'',`/player-dashboard.html?view=${view}`);render();}));
window.addEventListener('popstate',()=>{setMobileMenu(false);view=new URLSearchParams(location.search).get('view')||'home';render();});
$('logoutButton').addEventListener('click',async()=>{await supabase.auth.signOut();location.replace('/player-login.html');});
supabase?.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||!session)location.replace('/player-login.html');});
init().catch(error=>{console.error('Courtly player dashboard failed:',error);root.innerHTML=`<div class="empty-state"><div class="empty-icon">!</div><strong>We could not load your player dashboard</strong><span>${esc(error.message||'Please refresh the page. If this is a new deployment, run the player account SQL migration in Supabase first.')}</span></div>`;});
