import { supabase } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { user:null, profile:null, events:[], busy:false };
const timezone = 'Asia/Manila';

function showMessage(message, kind='') {
  const node=$('communityEventMessage');
  if(node){node.textContent=message;node.className=('community-inline-message '+kind).trim();}
}
function showToast(message) {
  const node=$('communityToast');
  if(!node)return;
  node.textContent=message;node.classList.add('show');
  setTimeout(()=>node.classList.remove('show'),3200);
}
function phDate(value) {
  return new Intl.DateTimeFormat('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:timezone}).format(new Date(value));
}
function phTime(value) {
  return new Intl.DateTimeFormat('en-PH',{hour:'numeric',minute:'2-digit',timeZone:timezone}).format(new Date(value));
}
function dateKeyToday() {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
}
function formatDuration(minutes) {
  const h=Math.floor(Number(minutes||0)/60),m=Number(minutes||0)%60;
  if(h&&m)return h+'h '+m+'m';
  if(h)return h+' hour'+(h===1?'':'s');
  return m+' minutes';
}
function eventCard(e) {
  const when=phDate(e.starts_at)+' · '+phTime(e.starts_at);
  const fee=Number(e.fee_per_player||0)===0?'Free':('₱'+Number(e.fee_per_player).toLocaleString('en-PH',{maximumFractionDigits:2})+' / player');
  const capacity=e.capacity?Number(e.confirmed_count)+' / '+Number(e.capacity)+' confirmed':Number(e.confirmed_count)+' confirmed';
  const badge=e.viewer_rsvp==='confirmed'?'You’re confirmed':e.viewer_rsvp==='waitlist'?'On waitlist':e.is_host?'You’re hosting':'Open RSVP';
  return `<article class="ce-event-card">
    <div class="ce-event-card-top"><span class="ce-sport-pill">${esc(e.sport)}</span><span class="ce-type-pill">${esc(e.event_type)}</span><span class="ce-event-status">${badge}</span></div>
    <a class="ce-event-card-title" href="/community-event.html?id=${encodeURIComponent(e.event_id)}">${esc(e.title)}</a>
    <div class="ce-event-card-meta"><span>◷ ${esc(when)}</span><span>⌖ ${esc([e.location_name,e.city].filter(Boolean).join(' · '))}</span></div>
    <p>${esc(e.description||'Join other Courtly players for this community activity.')}</p>
    <div class="ce-event-card-foot"><div><strong>${esc(fee)}</strong><small>${esc(capacity)} · ${esc(formatDuration(e.duration_minutes))}</small></div><a class="community-primary" href="/community-event.html?id=${encodeURIComponent(e.event_id)}">View activity →</a></div>
  </article>`;
}
async function loadEvents() {
  const host=$('communityEventsFeed');
  if(!host)return;
  host.innerHTML='<div class="community-state">Loading player activities…</div>';
  const {data,error}=await supabase.rpc('get_community_events',{p_event_id:null,p_limit:36});
  if(error)throw error;
  state.events=data||[];
  host.innerHTML=state.events.length?state.events.map(eventCard).join(''):'<div class="community-state"><strong>No player activities scheduled yet</strong>Host the first Open Play, social game, training session or tournament meet-up.</div>';
}
function openComposer(open=true) {
  const panel=$('communityEventComposer');
  if(!panel)return;
  panel.hidden=!open;
  if(open){panel.scrollIntoView({behavior:'smooth',block:'start'});$('communityEventTitle')?.focus();}
}
function setTabs(tab) {
  document.querySelectorAll('[data-community-stream-tab]').forEach(btn=>{
    const active=btn.dataset.communityStreamTab===tab;
    btn.classList.toggle('active',active);
    btn.setAttribute('aria-selected',String(active));
  });
  $('communityPostsPanel').hidden=tab!=='posts';
  $('communityEventsPanel').hidden=tab!=='activities';
}
async function submitEvent(event) {
  event.preventDefault();
  if(state.busy)return;
  const form=$('communityEventForm');
  const title=$('communityEventTitle').value.trim();
  const sport=$('communityEventSport').value;
  const eventType=$('communityEventType').value;
  const date=$('communityEventDate').value;
  const time=$('communityEventTime').value;
  const locationName=$('communityEventLocation').value.trim();
  const address=$('communityEventAddress').value.trim();
  const city=$('communityEventCity').value.trim();
  const fee=Number($('communityEventFee').value||0);
  const capacityValue=$('communityEventCapacity').value;
  const capacity=capacityValue?Number(capacityValue):null;
  const duration=Number($('communityEventDuration').value);
  const description=$('communityEventDescription').value.trim();
  if(!title||!sport||!date||!time||!locationName){showMessage('Complete the title, sport, date, time and venue fields.','error');return;}
  const startsAt=new Date(date+'T'+time+':00+08:00');
  if(!Number.isFinite(startsAt.getTime())||startsAt.getTime()<Date.now()+10*60*1000){showMessage('Choose a start time at least 10 minutes in the future.','error');return;}
  if(!Number.isFinite(fee)||fee<0){showMessage('Enter a valid fee per player.','error');return;}
  if(capacity!==null&&(!Number.isInteger(capacity)||capacity<2||capacity>500)){showMessage('Participant limit must be between 2 and 500.','error');return;}
  state.busy=true;
  const button=$('publishCommunityEvent');
  button.disabled=true;button.textContent='Publishing activity…';showMessage('');
  try{
    const {data,error}=await supabase.rpc('create_community_event',{
      p_title:title,p_sport:sport,p_event_type:eventType,
      p_starts_at:startsAt.toISOString(),p_duration_minutes:duration,
      p_location_name:locationName,p_address:address,p_city:city,
      p_fee_per_player:fee,p_capacity:capacity,p_description:description
    });
    if(error)throw error;
    const id=typeof data==='string'?data:data?.id;
    if(!id)throw new Error('The activity was created but Courtly did not return its event link. Refresh the activity list.');
    form.reset();
    showMessage('Your activity is published. You are automatically confirmed as the host.','success');
    await loadEvents();
    location.assign('/community-event.html?id='+encodeURIComponent(id));
  }catch(error){
    console.error('Courtly activity creation failed:',error);
    showMessage(error.message||'Could not publish this activity.','error');
  }finally{
    state.busy=false;button.disabled=false;button.textContent='Publish activity';
  }
}
async function init() {
  if(!supabase)return;
  const {data:{user},error}=await supabase.auth.getUser();
  if(error)throw error;
  state.user=user;
  if(!user){$('communityEventsSection').hidden=true;return;}
  const {data:profile,error:profileError}=await supabase.from('player_profiles')
    .select('id,player_name,full_name,is_private').eq('id',user.id).maybeSingle();
  if(profileError)throw profileError;
  state.profile=profile;
  const createButton=$('openEventComposer');
  if(profile){
    if(profile.is_private){
      createButton.hidden=false;createButton.disabled=true;
      createButton.textContent='Make profile public to host';
      createButton.title='Public activities are shown to other Courtly players.';
      $('communityEventPrivacyNote').textContent='Your player profile is private. Change it to public in Player Profile before hosting a community activity.';
    }else{
      createButton.hidden=false;
      createButton.addEventListener('click',()=>openComposer(true));
    }
  }
  $('closeCommunityEventComposer')?.addEventListener('click',()=>openComposer(false));
  $('communityEventForm')?.addEventListener('submit',submitEvent);
  $('communityEventDate').min=dateKeyToday();
  $('communityEventDate').value=dateKeyToday();
  $('communityEventTime').value='18:00';
  document.querySelectorAll('[data-community-stream-tab]').forEach(btn=>btn.addEventListener('click',()=>setTabs(btn.dataset.communityStreamTab)));
  $('refreshCommunityEvents')?.addEventListener('click',()=>loadEvents().catch(e=>showToast(e.message||'Could not refresh activities.')));
  await loadEvents();
}
init().catch(error=>{
  console.error('Courtly community activities failed to load:',error);
  const feed=$('communityEventsFeed');
  if(feed)feed.innerHTML='<div class="community-state"><strong>Activities could not be loaded</strong>'+esc(error.message||'Run the new community events migration in Supabase, then refresh.')+'</div>';
});
