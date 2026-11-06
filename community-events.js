import { supabase } from './supabase-client.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {user:null,profile:null,venues:[],courts:[],events:[],banner:null,places:null,busy:false};
const TZ='Asia/Manila';
const MAPS_KEY=import.meta.env.VITE_GOOGLE_MAPS_API_KEY||'';

function notify(message){const node=$('communityToast');if(!node)return;node.textContent=message;node.classList.add('show');setTimeout(()=>node.classList.remove('show'),3600);}
function message(text,kind=''){const node=$('communityEventMessage');if(node){node.textContent=text;node.className=('community-inline-message '+kind).trim();}}
function phDate(value){return new Intl.DateTimeFormat('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:TZ}).format(new Date(value));}
function phTime(value){return new Intl.DateTimeFormat('en-PH',{hour:'numeric',minute:'2-digit',timeZone:TZ}).format(new Date(value));}
function localToday(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=t=>parts.find(p=>p.type===t)?.value;return get('year')+'-'+get('month')+'-'+get('day');}
function money(v){return Number(v||0)===0?'Free':'₱'+Number(v).toLocaleString('en-PH',{maximumFractionDigits:2})+' / player';}
function durationText(n){const hours=Math.floor(Number(n||0)/60),minutes=Number(n||0)%60;return hours&&minutes?hours+'h '+minutes+'m':hours?hours+' hour'+(hours===1?'':'s'):minutes+' minutes';}
function mapsHref(e){if(e.map_place_id)return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(e.map_label||e.location_name)+'&query_place_id='+encodeURIComponent(e.map_place_id);if(e.map_lat&&e.map_lng)return 'https://www.google.com/maps/search/?api=1&query='+e.map_lat+','+e.map_lng;return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent([e.map_label,e.location_name,e.address,e.city].filter(Boolean).join(', '));}
function shareUrl(id){return location.origin+'/api/community-event-share?id='+encodeURIComponent(id);}
async function shareEvent(id,title){
 const url=shareUrl(id);
 try{
  if(navigator.share)await navigator.share({title:title||'Courtly activity',text:'Join me for this Courtly activity.',url});
  else{await navigator.clipboard.writeText(url);notify('Share link copied.');}
 }catch(error){if(error?.name!=='AbortError'){try{await navigator.clipboard.writeText(url);notify('Share link copied.');}catch{notify('Copy this link: '+url);}}}
}
function renderCard(e){
 const badge=e.viewer_registration_status==='confirmed'?'You’re confirmed':e.viewer_registration_status==='waitlisted'?'Payment / waitlist pending':e.viewer_registration_status==='rejected'?'Payment rejected':e.viewer_is_host?'You’re hosting':'Registration open';
 const confirmed=Number(e.confirmed_count||0),capacity=Number(e.capacity||0);
 const image=e.banner_url?'<img class="ce-event-banner" src="'+esc(e.banner_url)+'" alt="'+esc(e.title)+' banner" loading="lazy">':'<div class="ce-event-banner ce-event-banner-placeholder"><span>COURTLY / PLAY TOGETHER</span></div>';
 const location=[e.venue_name,e.court_name].filter(Boolean).join(' · ');
 return '<article class="ce-event-card">'+
   '<a class="ce-event-card-banner" href="/community-event.html?id='+encodeURIComponent(e.event_id)+'">'+image+'</a>'+
   '<div class="ce-event-card-content"><div class="ce-event-card-top"><span class="ce-sport-pill">'+esc(e.sport)+'</span><span class="ce-type-pill">'+esc(e.event_type)+'</span><span class="ce-event-status">'+esc(badge)+'</span></div>'+
   '<a class="ce-event-card-title" href="/community-event.html?id='+encodeURIComponent(e.event_id)+'">'+esc(e.title)+'</a>'+
   '<div class="ce-event-card-meta"><span>◷ '+esc(phDate(e.starts_at))+' · '+esc(phTime(e.starts_at))+'</span><span>⌖ '+esc(location||e.location_name)+' · '+esc(e.city||'')+'</span></div>'+
   '<p>'+esc(e.description||'Join other Courtly players for this activity.')+'</p>'+
   '<div class="ce-event-card-foot"><div><strong>'+esc(money(e.fee_per_player))+'</strong><small>'+confirmed+(capacity?' / '+capacity:'')+' confirmed · '+esc(durationText(e.duration_minutes))+'</small></div>'+
   '<div class="ce-card-actions"><button type="button" class="ce-share-button" data-share-event="'+esc(e.event_id)+'" data-share-title="'+esc(e.title)+'" aria-label="Share activity">↗ Share</button><a class="community-primary" href="/community-event.html?id='+encodeURIComponent(e.event_id)+'">View activity →</a></div></div></div></article>';
}
function updateUnreadBadge(count){
 const value=Math.max(0,Number(count||0));
 const badge=$('communityUnreadBadge');
 if(badge){badge.textContent=value>99?'99+':String(value);badge.hidden=value===0;}
 document.querySelectorAll('[data-community-badge]').forEach(node=>{node.textContent=value>99?'99+':String(value);node.hidden=value===0;});
}
async function refreshUnreadCount(){
 if(!state.user)return updateUnreadBadge(0);
 const {data,error}=await supabase.rpc('get_community_activity_unread_count');
 if(error){console.warn('Could not load new activity notifications:',error.message);return;}
 updateUnreadBadge(data||0);
}
async function markActivitiesRead(){
 if(!state.user)return;
 const {error}=await supabase.rpc('mark_community_activity_notifications_read');
 if(error)console.warn('Could not mark activities as read:',error.message);
 updateUnreadBadge(0);
}
async function loadRegisteredVenues(){
 const [{data:venues,error:venueError},{data:courts,error:courtError}]=await Promise.all([
  supabase.from('venues').select('id,slug,name,address,city,sport,timezone,hours_open,hours_close,peak_hours_start,peak_hours_end,payment_qr_url,payment_method,payment_account,payment_instructions').eq('is_published',true).order('name'),
  supabase.from('courts').select('id,venue_id,name,sport,hourly_rate,off_peak_rate,peak_rate,is_active').eq('is_active',true).order('display_order')
 ]);
 if(venueError)throw venueError;if(courtError)throw courtError;
 state.venues=venues||[];state.courts=courts||[];
 const select=$('communityEventVenue');
 select.innerHTML='<option value="">Choose a registered venue</option>'+state.venues.map(v=>'<option value="'+esc(v.id)+'">'+esc(v.name)+' · '+esc(v.city||v.address||'')+'</option>').join('');
 if(!state.venues.length)select.innerHTML='<option value="">No published Courtly venues yet</option>';
}
function selectedVenue(){return state.venues.find(v=>v.id===$('communityEventVenue').value)||null;}
function selectedCourt(){return state.courts.find(c=>c.id===$('communityEventCourt').value)||null;}
function updateCourtChoices(){
 const venue=selectedVenue(),select=$('communityEventCourt');
 const courts=venue?state.courts.filter(c=>c.venue_id===venue.id):[];
 select.disabled=!venue;
 select.innerHTML=venue?'<option value="">Choose an active registered court</option>'+courts.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+' · '+esc(c.sport||venue.sport||'Court')+'</option>').join(''):'<option value="">Choose a venue first</option>';
 $('communitySelectedVenue').textContent=venue?[venue.name,venue.address,venue.city].filter(Boolean).join(' · ')+' — payment is verified by this venue owner.':'Select a registered venue to see its court list and payment instructions.';
 updateSuggestedFee();
}
function updateSuggestedFee(){
 const court=selectedCourt(),capacity=Math.max(2,Number($('communityEventCapacity').value||8)),hours=Number($('communityEventDuration').value||120)/60;
 if(!court){$('communitySuggestedFee').textContent='Choose a court and participant limit to calculate a suggested share.';return;}
 const rate=Number(court.off_peak_rate??court.hourly_rate??350);
 const suggested=Math.ceil(rate*hours/capacity);
 $('communitySuggestedFee').textContent='Suggested share: ₱'+suggested.toLocaleString('en-PH')+' per player based on ₱'+rate.toLocaleString('en-PH')+'/hour × '+hours+' hours ÷ '+capacity+' players. You can edit this amount.';
 if(Number($('communityEventFee').value||0)===0)$('communityEventFee').value=String(suggested);
}
function setBannerPreview(file){
 state.banner=file||null;
 const wrap=$('communityBannerPreview'),img=$('communityBannerPreviewImage');
 if(!file){wrap.hidden=true;img.removeAttribute('src');return;}
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)){message('Please use a JPG, PNG or WebP banner.','error');$('communityEventBanner').value='';state.banner=null;return;}
 if(file.size>5*1024*1024){message('Banner must be 5 MB or smaller.','error');$('communityEventBanner').value='';state.banner=null;return;}
 const reader=new FileReader();reader.onload=()=>{img.src=reader.result;wrap.hidden=false;};reader.readAsDataURL(file);
}
function initializeGooglePlaces(){
 const input=$('communityEventMap');
 if(!MAPS_KEY){$('communityMapsHelp').textContent='Google Maps suggestions require a VITE_GOOGLE_MAPS_API_KEY in the Courtly Vercel project. You can still leave this optional.';return;}
 const attach=()=>{
  if(!window.google?.maps?.places?.Autocomplete)return;
  const autocomplete=new google.maps.places.Autocomplete(input,{fields:['place_id','formatted_address','geometry','name'],componentRestrictions:{country:'ph'}});
  autocomplete.addListener('place_changed',()=>{
   const place=autocomplete.getPlace();
   if(!place.place_id)return;
   $('communityEventPlaceId').value=place.place_id;
   $('communityEventMap').value=place.formatted_address||place.name||'';
   $('communityEventPlaceLat').value=place.geometry?.location?.lat?.()??'';
   $('communityEventPlaceLng').value=place.geometry?.location?.lng?.()??'';
   $('communityMapsHelp').textContent='Google Maps location selected. The registered venue and court remain the reserved playing location.';
  });
 };
 if(window.google?.maps?.places){attach();return;}
 window.courtlyPlacesReady=attach;
 const script=document.createElement('script');
 script.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(MAPS_KEY)+'&libraries=places&callback=courtlyPlacesReady';
 script.async=true;script.defer=true;script.onerror=()=>{$('communityMapsHelp').textContent='Google Maps could not load. Check the API key and enable Places API in Google Cloud.';};
 document.head.appendChild(script);
}
async function loadEvents(){
 const host=$('communityEventsFeed');host.innerHTML='<div class="community-state">Loading activities…</div>';
 const {data,error}=await supabase.rpc('get_community_activities',{p_event_id:null,p_limit:48});
 if(error)throw error;
 state.events=data||[];
 const sport=$('communitySportFilter').value;
 const filtered=state.events.filter(e=>!sport||e.sport===sport);
 host.innerHTML=filtered.length?filtered.map(renderCard).join(''):'<div class="community-state"><strong>No activities found</strong>Choose another sport or host the first activity at a registered Courtly court.</div>';
 host.querySelectorAll('[data-share-event]').forEach(button=>button.addEventListener('click',()=>shareEvent(button.dataset.shareEvent,button.dataset.shareTitle)));
}
function openComposer(open=true){
 const panel=$('communityEventComposer');panel.hidden=!open;
 if(open){panel.scrollIntoView({behavior:'smooth',block:'start'});$('communityEventTitle').focus();}
}
async function uploadBanner(eventId){
 if(!state.banner)return;
 const ext=state.banner.type==='image/png'?'png':state.banner.type==='image/webp'?'webp':'jpg';
 const path=state.user.id+'/'+eventId+'/'+Date.now()+'.'+ext;
 const {error}=await supabase.storage.from('courtly-community-banners').upload(path,state.banner,{cacheControl:'3600',upsert:true,contentType:state.banner.type});
 if(error)throw error;
 const {data}=supabase.storage.from('courtly-community-banners').getPublicUrl(path);
 const {error:updateError}=await supabase.rpc('update_community_event_banner',{p_event_id:eventId,p_banner_path:path,p_banner_url:data.publicUrl});
 if(updateError)throw updateError;
}
async function submitEvent(event){
 event.preventDefault();if(state.busy)return;
 const venue=selectedVenue(),court=selectedCourt();
 if(!venue||!court){message('Select a registered venue and active court.','error');return;}
 const title=$('communityEventTitle').value.trim(),sport=$('communityEventSport').value,eventType=$('communityEventType').value;
 const date=$('communityEventDate').value,time=$('communityEventTime').value,duration=Number($('communityEventDuration').value);
 const capacity=Number($('communityEventCapacity').value),fee=Number($('communityEventFee').value||0);
 if(!title||!sport||!date||!time){message('Complete the activity title, sport, date and start time.','error');return;}
 if(!Number.isInteger(capacity)||capacity<2||capacity>500){message('Maximum players must be between 2 and 500, including you as host.','error');return;}
 if(!Number.isFinite(fee)||fee<0){message('Enter a valid player fee.','error');return;}
 const startsAt=new Date(date+'T'+time+':00+08:00');
 if(!Number.isFinite(startsAt.getTime())||startsAt.getTime()<Date.now()+10*60*1000){message('Choose a future start time.','error');return;}
 if(startsAt.getMinutes()!==0){message('Court reservations must start on the hour.','error');return;}
 state.busy=true;const button=$('publishCommunityEvent');button.disabled=true;button.textContent='Reserving court & publishing…';message('');
 try{
  const lat=$('communityEventPlaceLat').value, lng=$('communityEventPlaceLng').value;
  const {data,error}=await supabase.rpc('create_community_event',{
   p_venue_id:venue.id,p_court_id:court.id,p_title:title,p_sport:sport,p_event_type:eventType,
   p_starts_at:startsAt.toISOString(),p_duration_minutes:duration,p_fee_per_player:fee,
   p_capacity:capacity,p_description:$('communityEventDescription').value.trim(),
   p_map_place_id:$('communityEventPlaceId').value||null,p_map_label:$('communityEventMap').value.trim()||null,
   p_map_lat:lat?Number(lat):null,p_map_lng:lng?Number(lng):null
  });
  if(error)throw error;
  const id=typeof data==='string'?data:data?.id;if(!id)throw new Error('Courtly did not return the activity ID.');
  let bannerMessage='';
  try{await uploadBanner(id);}catch(uploadError){console.error('Activity banner upload failed:',uploadError);bannerMessage=' The activity was published, but the banner did not upload: '+uploadError.message;}
  await loadEvents();
  message('Activity published and the court slot is reserved.'+bannerMessage,'success');
  const url='/community-event.html?id='+encodeURIComponent(id);
  location.assign(url);
 }catch(error){console.error('Courtly activity creation failed:',error);message(error.message||'Could not publish the activity.','error');}
 finally{state.busy=false;button.disabled=false;button.textContent='Publish activity';}
}
async function init(){
 if(!supabase){$('communityEventsFeed').innerHTML='<div class="community-state">Courtly is not connected to Supabase.</div>';return;}
 const {data:{user},error}=await supabase.auth.getUser();if(error)throw error;
 state.user=user;
 const create=$('openEventComposer');
 if(!user){
  create.hidden=true;
  $('communityEventsFeed').innerHTML='<div class="community-state"><strong>Sign in to explore player activities</strong><a href="/player-login.html">Player login</a></div>';
  return;
 }
 const {data:profile,error:profileError}=await supabase.from('player_profiles').select('id,player_name,full_name,is_private').eq('id',user.id).maybeSingle();
 if(profileError)throw profileError;state.profile=profile;
 if(profile){
  create.hidden=false;
  if(profile.is_private){create.disabled=true;create.textContent='Make profile public to host';}
  else create.addEventListener('click',()=>openComposer(true));
 }
 await loadRegisteredVenues();
 $('communityEventDate').min=localToday();$('communityEventDate').value=localToday();$('communityEventTime').value='18:00';
 $('communityEventVenue').addEventListener('change',updateCourtChoices);
 $('communityEventCourt').addEventListener('change',()=>{updateSuggestedFee();updateCourtChoicesAfterSelectedCourt();});
 $('communityEventCapacity').addEventListener('input',updateSuggestedFee);
 $('communityEventDuration').addEventListener('change',updateSuggestedFee);
 $('communityEventBanner').addEventListener('change',e=>setBannerPreview(e.target.files?.[0]||null));
 $('clearCommunityBanner').addEventListener('click',()=>{state.banner=null;$('communityEventBanner').value='';setBannerPreview(null);});
 $('closeCommunityEventComposer').addEventListener('click',()=>openComposer(false));
 $('communityEventForm').addEventListener('submit',submitEvent);
 $('refreshCommunityEvents').addEventListener('click',()=>loadEvents().catch(e=>notify(e.message)));
 $('communitySportFilter').addEventListener('change',()=>loadEvents().catch(e=>notify(e.message)));
 initializeGooglePlaces();
 await refreshUnreadCount();
 await loadEvents();
 await markActivitiesRead();
}
function updateCourtChoicesAfterSelectedCourt(){
 const venue=selectedVenue(),court=selectedCourt();
 if(!venue||!court)return;
 $('communitySelectedVenue').textContent=[venue.name,court.name,venue.address,venue.city].filter(Boolean).join(' · ')+' — payments are verified by '+(venue.owner_name||'the venue owner')+'.';
 const map=$('communityEventMap');
 if(!map.value)map.value=[venue.address,venue.city].filter(Boolean).join(', ');
}
init().catch(error=>{
 console.error('Courtly Activities & Games failed:',error);
 $('communityEventsFeed').innerHTML='<div class="community-state"><strong>Activities could not be loaded</strong>'+esc(error.message||'Refresh and try again.')+'</div>';
});
