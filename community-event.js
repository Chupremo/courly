import { supabase } from './supabase-client.js';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={user:null,isPlayer:false,event:null,attendees:[],busy:false};
const tz='Asia/Manila';

function initials(name='Player'){return String(name).trim().split(/\s+/).map(x=>x[0]||'').join('').slice(0,2).toUpperCase()||'P';}
function money(v){return Number(v||0)===0?'Free':'₱'+Number(v).toLocaleString('en-PH',{maximumFractionDigits:2});}
function when(value){
 const d=new Date(value);
 return new Intl.DateTimeFormat('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:tz}).format(d);
}
function time(value){return new Intl.DateTimeFormat('en-PH',{hour:'numeric',minute:'2-digit',timeZone:tz}).format(new Date(value));}
function duration(n){const h=Math.floor(Number(n||0)/60),m=Number(n||0)%60;return h&&m?h+'h '+m+'m':h?h+' hour'+(h===1?'':'s'):m+' minutes';}
async function signedAvatar(path){
 if(!path||!state.user)return '';
 if(/^https?:\/\//i.test(path))return path;
 const {data,error}=await supabase.storage.from('courtly-player-avatars').createSignedUrl(path,3600);
 if(error){console.info('Could not load a community event avatar:',error.message);return '';}
 return data?.signedUrl||'';
}
function toast(message){
 const node=$('eventToast');if(!node)return;
 node.textContent=message;node.classList.add('show');
 setTimeout(()=>node.classList.remove('show'),3200);
}
function attendeeMarkup(a){
 const avatar=a.avatar_url?'<img src="'+esc(a.avatar_url)+'" alt="">':esc(initials(a.player_name));
 return '<div class="ce-attendee"><span class="ce-attendee-avatar">'+avatar+'</span><strong>'+esc(a.player_name)+'</strong>'+(a.is_host?'<small>HOST</small>':'')+'</div>';
}
function placeholderMarkup(){
 const e=state.event;if(!e?.capacity)return '';
 const remaining=Math.max(0,Number(e.capacity)-Number(e.confirmed_count||0));
 const slots=Math.min(remaining,12);
 return Array.from({length:slots},()=>'<div class="ce-attendee ce-attendee-open"><span class="ce-attendee-avatar">＋</span><strong>Open spot</strong></div>').join('');
}
function render(){
 const e=state.event;if(!e)return;
 const attendees=state.attendees.filter(a=>a.rsvp_status==='confirmed');
 const waitlist=state.attendees.filter(a=>a.rsvp_status==='waitlist');
 const host=attendees.find(a=>a.is_host)||null;
 const mapQuery=encodeURIComponent([e.location_name,e.address,e.city].filter(Boolean).join(', '));
 const confirmed=Number(e.confirmed_count||0);
 const waitCount=Number(e.waitlist_count||0);
 $('eventKicker').textContent=e.sport+' · '+e.event_type;
 $('eventTitle').textContent=e.title;
 $('eventDate').textContent=when(e.starts_at);
 $('eventTime').textContent=time(e.starts_at)+' · '+duration(e.duration_minutes);
 $('eventLocationName').textContent=e.location_name;
 $('eventAddress').textContent=[e.address,e.city].filter(Boolean).join(', ')||e.city||'Location details provided by the host';
 $('eventDescription').textContent=e.description||'The host has not added a description for this activity.';
 $('eventMapLink').href='https://www.google.com/maps/search/?api=1&query='+mapQuery;
 $('eventFee').textContent=money(e.fee_per_player)+(Number(e.fee_per_player||0)>0?' per player':'');
 $('eventHostName').textContent=e.host_name;
 $('eventHostAvatar').innerHTML=host?.avatar_url?'<img src="'+esc(host.avatar_url)+'" alt="">':esc(initials(e.host_name));
 $('eventHostSubtitle').textContent='Activity host · Courtly player';
 $('eventConfirmedCount').textContent='Confirmed · '+confirmed;
 $('eventConfirmedSummary').textContent=confirmed+' confirmed'+(e.capacity?' of '+e.capacity+' spots':'');
 $('eventAttendees').innerHTML=attendees.length?attendees.map(attendeeMarkup).join(''):'<div class="ce-attendees-empty">No confirmed players yet.</div>';
 $('eventAttendees').insertAdjacentHTML('beforeend',placeholderMarkup());
 $('eventWaitlistBlock').hidden=!waitlist.length;
 $('eventWaitlistCount').textContent='Waitlist · '+waitCount;
 $('eventWaitlist').innerHTML=waitlist.map(attendeeMarkup).join('');
 $('eventCapacity').textContent=e.capacity?confirmed+' / '+e.capacity+' spots confirmed':confirmed+' players confirmed · no fixed limit';
 $('eventStatusNote').textContent=e.event_status==='cancelled'?'This activity has been cancelled by the host.':e.event_status==='completed'?'This activity has ended.':'RSVP is your confirmation to join. Any listed fee is payable directly to the host or venue.';
 const rsvp=e.viewer_rsvp;
 const button=$('eventRsvpButton');
 const cancel=$('eventCancelActivity');
 button.disabled=false;button.dataset.action='join';
 if(e.event_status!=='published'){
   button.textContent=e.event_status==='cancelled'?'Activity cancelled':'Activity completed';
   button.disabled=true;
 }else if(e.viewer_is_host){
   button.textContent='You’re hosting this activity';
   button.disabled=true;
 }else if(rsvp==='confirmed'){
   button.textContent='You’re confirmed ✓';
   button.dataset.action='cancel';
 }else if(rsvp==='waitlist'){
   button.textContent='You’re on the waitlist';
   button.dataset.action='cancel';
 }else if(e.capacity&&confirmed>=Number(e.capacity)){
   button.textContent='Join the waitlist';
 }else{
   button.textContent=Number(e.fee_per_player||0)>0?'RSVP · '+money(e.fee_per_player)+' / player':'Confirm my RSVP';
 }
 if(!state.user){button.textContent='Sign in to RSVP';button.disabled=true;}
 else if(!state.isPlayer&&!e.viewer_is_host){button.textContent='Player account required';button.disabled=true;}
 $('eventSignInPrompt').hidden=!!state.user&&state.isPlayer;
 button.classList.toggle('ce-button-confirmed',rsvp==='confirmed');
 $('eventRsvpStatus').textContent=rsvp==='confirmed'?'Your place is confirmed.':rsvp==='waitlist'?'You are on the waitlist and will be promoted if a place opens.':'';
 cancel.hidden=!e.viewer_is_host||e.event_status!=='published';
 $('eventStickyTitle').textContent=when(e.starts_at)+' · '+time(e.starts_at);
 $('eventStickyFee').textContent=money(e.fee_per_player)+(Number(e.fee_per_player||0)>0?' per player':'');
 $('eventAttendanceRefresh').textContent='↻ Refresh attendees';
}
async function loadEvent(){
 const params=new URLSearchParams(location.search);
 const id=params.get('id');
 if(!id){$('eventMain').innerHTML='<div class="ce-load-state">Activity link is missing an ID.</div>';return;}
 const {data,error}=await supabase.rpc('get_community_events',{p_event_id:id,p_limit:1});
 if(error)throw error;
 if(!data?.length)throw new Error('This activity could not be found, or the host profile is private.');
 state.event=data[0];
 const {data:attendees,error:attendeeError}=await supabase.rpc('get_community_event_attendees',{p_event_id:id});
 if(attendeeError)throw attendeeError;
 state.attendees=await Promise.all((attendees||[]).map(async a=>({...a,avatar_url:await signedAvatar(a.avatar_path)})));
 if(state.event.host_avatar_path)state.event.host_avatar_url=await signedAvatar(state.event.host_avatar_path);
 const host=state.attendees.find(a=>a.is_host);
 if(host?.avatar_url)state.event.host_avatar_url=host.avatar_url;
 else if(state.event.host_avatar_url)state.event.host_avatar_url=state.event.host_avatar_url;
 await updateViewerRsvp();
 render();
}
async function updateViewerRsvp(){
 if(!state.user||!state.event)return;
 const {data:profile,error}=await supabase.from('player_profiles').select('id').eq('id',state.user.id).maybeSingle();
 if(error)throw error;
 state.isPlayer=!!profile;
}
async function doRsvp(){
 if(state.busy||!state.event)return;
 if(!state.user){toast('Sign in with a Courtly player account to RSVP.');return;}
 if(!state.isPlayer){toast('RSVP is available to player accounts only.');return;}
 const button=$('eventRsvpButton'),action=button.dataset.action;
 state.busy=true;button.disabled=true;
 try{
  if(action==='cancel'){
   const {error}=await supabase.rpc('cancel_community_event_rsvp',{p_event_id:state.event.event_id});
   if(error)throw error;
   toast('Your RSVP has been cancelled.');
  }else{
   const {data,error}=await supabase.rpc('rsvp_community_event',{p_event_id:state.event.event_id});
   if(error)throw error;
   const result=Array.isArray(data)?data[0]:data;
   toast(result?.rsvp_status==='waitlist'?'The activity is full. You’re on the waitlist.':'You’re confirmed for this activity!');
  }
  await loadEvent();
 }catch(error){toast(error.message||'Could not update your RSVP.');}
 finally{state.busy=false;button.disabled=false;}
}
async function cancelActivity(){
 if(!state.event||!state.event.viewer_is_host||state.busy)return;
 if(!confirm('Cancel this activity? Players will no longer be able to RSVP.'))return;
 state.busy=true;
 try{
  const {error}=await supabase.rpc('cancel_community_event',{p_event_id:state.event.event_id});
  if(error)throw error;
  await loadEvent();toast('Your activity has been cancelled.');
 }catch(error){toast(error.message||'Could not cancel this activity.');}
 finally{state.busy=false;}
}
async function init(){
 if(!supabase)throw new Error('Courtly is not connected to Supabase.');
 const {data:{user},error}=await supabase.auth.getUser();if(error)throw error;
 state.user=user;
 if(!user){
  $('eventSignInPrompt').hidden=false;
  $('eventRsvpButton').disabled=true;$('eventRsvpButton').textContent='Sign in to RSVP';
 }
 $('eventRsvpButton').addEventListener('click',doRsvp);
 $('eventCancelActivity').addEventListener('click',cancelActivity);
 $('eventAttendanceRefresh').addEventListener('click',()=>loadEvent().catch(e=>toast(e.message)));
 await loadEvent();
}
init().catch(error=>{
 console.error('Courtly activity page failed:',error);
 $('eventMain').innerHTML='<div class="ce-load-state"><strong>We could not load this activity</strong><p>'+esc(error.message||'Please refresh and try again.')+'</p><a href="/community.html">Return to community</a></div>';
 $('eventStickyBar').hidden=true;
});
