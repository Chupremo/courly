import { supabase } from './supabase-client.js';

const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={user:null,isPlayer:false,event:null,attendees:[],busy:false};
const TZ='Asia/Manila';
function initials(name='Player'){return String(name).trim().split(/\s+/).map(x=>x[0]||'').join('').slice(0,2).toUpperCase()||'P';}
function money(v){return Number(v||0)===0?'Free':'₱'+Number(v).toLocaleString('en-PH',{maximumFractionDigits:2});}
function when(value){return new Intl.DateTimeFormat('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:TZ}).format(new Date(value));}
function time(value){return new Intl.DateTimeFormat('en-PH',{hour:'numeric',minute:'2-digit',timeZone:TZ}).format(new Date(value));}
function duration(n){const h=Math.floor(Number(n||0)/60),m=Number(n||0)%60;return h&&m?h+'h '+m+'m':h?h+' hour'+(h===1?'':'s'):m+' minutes';}
function toast(text){const node=$('eventToast');if(!node)return;node.textContent=text;node.classList.add('show');setTimeout(()=>node.classList.remove('show'),3600);}
function setRegistrationMessage(text,kind=''){const node=$('eventRegistrationStatus');node.textContent=text;node.className=('ce-registration-status '+kind).trim();}
async function signedAvatar(path){
 if(!path)return '';
 if(/^https?:\/\//i.test(path))return path;
 const {data,error}=await supabase.storage.from('courtly-player-avatars').createSignedUrl(path,3600);
 if(error){console.info('Could not sign player avatar:',error.message);return '';}
 return data?.signedUrl||'';
}
function attendeeMarkup(a){
 const image=a.avatar_url?'<img src="'+esc(a.avatar_url)+'" alt="">':esc(initials(a.player_name));
 return '<div class="ce-attendee"><span class="ce-attendee-avatar">'+image+'</span><strong>'+esc(a.player_name)+'</strong>'+(a.is_host?'<small>HOST</small>':'')+'</div>';
}
function mapsUrl(e){
 if(e.map_place_id)return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(e.map_label||e.location_name)+'&query_place_id='+encodeURIComponent(e.map_place_id);
 if(e.map_lat&&e.map_lng)return 'https://www.google.com/maps/search/?api=1&query='+e.map_lat+','+e.map_lng;
 return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent([e.map_label,e.venue_name,e.court_name,e.address,e.city].filter(Boolean).join(', '));
}
function shareUrl(id){return location.origin+'/api/community-event-share?id='+encodeURIComponent(id);}
async function shareActivity(){
 const e=state.event;if(!e)return;
 if(!state.user){location.href='/player-register.html?next='+encodeURIComponent(location.pathname+location.search);return;}
 const url=shareUrl(e.event_id);
 try{if(navigator.share)await navigator.share({title:e.title,text:'Join me for '+e.title+' at '+e.venue_name+'.',url});else{await navigator.clipboard.writeText(url);toast('Share link copied.');}}
 catch(error){if(error?.name!=='AbortError'){try{await navigator.clipboard.writeText(url);toast('Share link copied.');}catch{toast('Copy this link: '+url);}}}
}
function render(){
 const e=state.event;if(!e)return;
 const confirmed=Number(e.confirmed_count||0),capacity=Number(e.capacity||0);
 $('eventKicker').textContent=e.sport+' · '+e.event_type;
 $('eventTitle').textContent=e.title;
 $('eventDate').textContent=when(e.starts_at);
 $('eventTime').textContent=time(e.starts_at)+' · '+duration(e.duration_minutes);
 $('eventFee').textContent=money(e.fee_per_player)+(Number(e.fee_per_player||0)>0?' per player':'');
 $('eventLocationName').textContent=[e.venue_name,e.court_name].filter(Boolean).join(' · ')||e.location_name;
 $('eventAddress').textContent=[e.map_label||e.address,e.city].filter(Boolean).join(', ')||'Registered Courtly court';
 $('eventMapLink').href=mapsUrl(e);
 $('eventDescription').textContent=e.description||'The host has not added a description for this activity.';
 $('eventHostName').textContent=e.host_name;
 const host=state.attendees.find(a=>a.is_host);
 $('eventHostAvatar').innerHTML=host?.avatar_url?'<img src="'+esc(host.avatar_url)+'" alt="">':esc(initials(e.host_name));
 $('eventConfirmedCount').textContent='Confirmed · '+confirmed;
 $('eventCapacity').textContent=capacity?confirmed+' / '+capacity+' players':'No fixed participant limit';
 $('eventConfirmedSummary').textContent=confirmed+' profiles confirmed'+(capacity?' of '+capacity+' spots':'');
 $('eventAttendees').innerHTML=state.attendees.length?state.attendees.map(attendeeMarkup).join(''):'<div class="ce-attendees-empty">No confirmed profiles yet.</div>';
 $('eventPaymentMethod').textContent=e.payment_method||'Contact the venue owner for payment instructions';
 $('eventPaymentAccount').textContent=e.payment_account||'';
 $('eventPaymentInstructions').textContent=e.payment_instructions||'Pay the selected Courtly venue directly. Upload your payment proof below so the venue owner can verify it.';
 $('eventPaymentAmount').textContent=money(e.fee_per_player);
 $('eventPaymentTitle').textContent=e.venue_name+' payment details';
 const qrWrap=$('eventPaymentQrWrap');
 if(e.payment_qr_url){$('eventPaymentQr').src=e.payment_qr_url;qrWrap.hidden=false;}else qrWrap.hidden=true;
 if(e.banner_url){$('eventBanner').src=e.banner_url;$('eventBannerWrap').hidden=false;}else $('eventBannerWrap').hidden=true;
 const reg=e.viewer_registration_status,payment=e.viewer_payment_status;
 const form=$('eventRegistrationForm'),open=$('eventOpenRegistration'),cancel=$('eventCancelRegistration');
 form.hidden=true;open.hidden=false;cancel.hidden=true;
 $('eventReceiptRequiredMark').hidden=Number(e.fee_per_player||0)===0;
 $('eventPaymentReceipt').required=Number(e.fee_per_player||0)>0;
 if(e.event_status!=='published'){
  open.disabled=true;open.textContent=e.event_status==='cancelled'?'Activity cancelled':'Activity completed';
  $('eventStatusNote').textContent='This activity is no longer accepting registrations.';
 }else if(e.viewer_is_host){
  open.disabled=true;open.textContent='You are hosting this activity';
  $('eventStatusNote').textContent='Your court slot is reserved. Players can register and submit payment proof to the selected venue.';
 }else if(!state.user){
  open.textContent='Sign in to register';open.disabled=false;
  $('eventSignInPrompt').hidden=false;
  $('eventStatusNote').textContent='Player registration requires a Courtly player account.';
 }else if(!state.isPlayer){
  open.textContent='Player account required';open.disabled=true;
  $('eventSignInPrompt').hidden=true;
  $('eventStatusNote').textContent='Only Courtly player accounts can register for activities.';
 }else if(reg==='confirmed'){
  open.hidden=true;cancel.hidden=false;
  setRegistrationMessage('Payment verified. You are confirmed for this activity.','success');
  $('eventExistingRegistration').hidden=false;$('eventExistingRegistration').textContent='You are on the confirmed list. Your profile is visible to other players.';
  $('eventStatusNote').textContent='Your payment was approved by the venue owner.';
 }else if(reg==='waitlisted'){
  open.hidden=true;cancel.hidden=false;
  $('eventExistingRegistration').hidden=false;
  if(payment==='confirmed'){
   setRegistrationMessage('Payment verified. You are waitlisted because all confirmed places are currently full.','warning');
   $('eventExistingRegistration').textContent='Payment approved · Waitlist. Your profile will appear in the confirmed list when a place opens.';
  }else{
   setRegistrationMessage('Registration received. You are waitlisted until the venue owner verifies your payment.','warning');
   $('eventExistingRegistration').textContent='Payment awaiting owner verification. Your profile will appear in the confirmed list after approval.';
  }
 }else if(reg==='rejected'){
  $('eventExistingRegistration').hidden=false;$('eventExistingRegistration').textContent='Your previous payment proof was rejected. You can submit a new receipt.';
  setRegistrationMessage('Payment was rejected by the venue. Please upload a corrected receipt.','error');
  open.textContent='Submit new payment proof';
 }else{
  $('eventExistingRegistration').hidden=true;
  setRegistrationMessage('Submit your registration and payment proof. You will remain waitlisted until the venue owner approves it.','');
  open.textContent='Register & submit payment';
 }
 if(reg==='confirmed'||reg==='waitlisted')cancel.hidden=false;
 $('eventStickyTitle').textContent=when(e.starts_at)+' · '+time(e.starts_at);
 $('eventStickyFee').textContent=money(e.fee_per_player)+' / player';
 $('eventStickyJoin').textContent=reg==='confirmed'?'You’re confirmed':reg==='waitlisted'?'Payment / waitlist pending':e.viewer_is_host?'You’re hosting': 'Register · '+money(e.fee_per_player);
 $('eventStickyJoin').disabled=e.event_status!=='published'||e.viewer_is_host||reg==='confirmed'||reg==='waitlisted';
 $('eventCancelActivity').hidden=!e.viewer_is_host||e.event_status!=='published';
}
async function loadEvent(){
 const id=new URLSearchParams(location.search).get('id');
 if(!id)throw new Error('This activity link is missing an ID.');
 const {data,error}=await supabase.rpc('get_community_activities',{p_event_id:id,p_limit:1});
 if(error)throw error;
 if(!data?.length)throw new Error('This activity could not be found or is no longer available.');
 state.event=data[0];
 const {data:attendees,error:attendeeError}=await supabase.rpc('get_community_activity_attendees',{p_event_id:id});
 if(attendeeError)throw attendeeError;
 state.attendees=await Promise.all((attendees||[]).map(async a=>({...a,avatar_url:await signedAvatar(a.avatar_path)})));
 if(state.user){
  const {data:profile,error:profileError}=await supabase.from('player_profiles').select('id').eq('id',state.user.id).maybeSingle();
  if(profileError)throw profileError;state.isPlayer=!!profile;
 }
 render();
}
async function loadEventComments(){
 const host=$('eventComments'),gate=$('eventCommentGate'),form=$('eventCommentForm');
 if(!host)return;
 host.innerHTML='<div class="ce-attendees-empty">Loading comments…</div>';
 const {data,error}=await supabase.rpc('get_community_event_comments',{p_event_id:state.event.event_id});
 if(error){host.innerHTML='<div class="ce-attendees-empty">Comments are unavailable right now.</div>';return;}
 const rows=await Promise.all((data||[]).map(async row=>({...row,avatar_url:await signedAvatar(row.avatar_path)})));
 host.innerHTML=rows.length?rows.map(row=>'<div class="comment-item" style="display:flex;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f4"><span class="ce-attendee-avatar">'+(row.avatar_url?'<img src="'+esc(row.avatar_url)+'" alt="">':esc(initials(row.author_name)))+'</span><div style="min-width:0;flex:1"><div style="display:flex;justify-content:space-between;gap:10px"><strong>'+esc(row.author_name)+'</strong><small>'+esc(new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:TZ}).format(new Date(row.created_at)))+'</small></div><p style="margin:6px 0 0;white-space:pre-wrap;line-height:1.6">'+esc(row.body)+'</p></div></div>').join(''):'<div class="ce-attendees-empty">No comments yet.</div>';
 if(!state.user){
  form.hidden=true;gate.hidden=false;gate.innerHTML='Create a free Courtly player account to comment. <a href="/player-register.html?next='+encodeURIComponent(location.pathname+location.search)+'">Register</a> or <a href="/player-login.html?next='+encodeURIComponent(location.pathname+location.search)+'">log in</a>.';
 }else if(!state.isPlayer){
  form.hidden=true;gate.hidden=false;gate.textContent='Comments are available to registered Courtly player accounts.';
 }else{
  gate.hidden=true;form.hidden=false;
 }
}
async function submitEventComment(event){
 event.preventDefault();
 if(!state.user){location.href='/player-register.html?next='+encodeURIComponent(location.pathname+location.search);return;}
 if(!state.isPlayer){toast('Use a registered player account to comment.');return;}
 const field=$('eventCommentBody'),button=$('eventCommentSubmit'),body=field.value.trim();
 if(!body)return;
 button.disabled=true;button.textContent='Posting…';
 try{
  const {error}=await supabase.from('community_event_comments').insert({event_id:state.event.event_id,author_id:state.user.id,body});
  if(error)throw error;
  field.value='';await loadEventComments();toast('Comment posted.');
 }catch(error){toast(error.message||'Could not post your comment.');}
 finally{button.disabled=false;button.textContent='Post comment';}
}
async function registerActivity(event){
 event.preventDefault();if(state.busy||!state.event)return;
 if(!state.user||!state.isPlayer){toast('Sign in with a Courtly player account to register.');return;}
 const e=state.event,receipt=$('eventPaymentReceipt').files?.[0]||null,amount=Number(e.fee_per_player||0);
 if(amount>0&&!receipt){toast('Upload your payment proof before submitting.');return;}
 if(receipt){
  if(!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(receipt.type)){toast('Use a JPG, PNG, WebP or HEIC receipt image.');return;}
  if(receipt.size>10*1024*1024){toast('Payment receipt must be 10 MB or smaller.');return;}
 }
 state.busy=true;const button=$('eventSubmitRegistration');button.disabled=true;button.textContent='Submitting registration…';
 try{
  let receiptPath=null;
  if(receipt){
   const venueSlug=e.venue_slug||'venue';
   const ext=receipt.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'')||'jpg';
   receiptPath=venueSlug+'/community-activity/'+e.event_id+'/'+state.user.id+'/'+Date.now()+'.'+ext;
   const {error:uploadError}=await supabase.storage.from('courtly-payment-receipts').upload(receiptPath,receipt,{cacheControl:'600',upsert:false,contentType:receipt.type});
   if(uploadError)throw uploadError;
  }
  const {data,error}=await supabase.rpc('register_community_activity',{
   p_event_id:e.event_id,p_receipt_path:receiptPath,
   p_payment_method:e.payment_method||'Venue payment',
   p_payment_reference:$('eventPaymentReference').value.trim()||null
  });
  if(error)throw error;
  $('eventRegistrationForm').reset();
  toast(data?.message||'Registration submitted. Waiting for venue payment verification.');
  await loadEvent();
 }catch(error){console.error('Community activity registration failed:',error);toast(error.message||'Could not submit your registration.');}
 finally{state.busy=false;button.disabled=false;button.textContent='Submit registration';}
}
function openRegistration(){
 if(!state.user){location.href='/player-login.html?next='+encodeURIComponent(location.pathname+location.search);return;}
 if(!state.isPlayer){toast('Only player accounts can register for activities.');return;}
 $('eventRegistrationForm').hidden=false;$('eventOpenRegistration').hidden=true;
 $('eventRegistrationForm').scrollIntoView({behavior:'smooth',block:'center'});
}
async function cancelRegistration(){
 if(!state.event||state.busy)return;
 if(!confirm('Cancel your registration for this activity?'))return;
 state.busy=true;
 try{const {error}=await supabase.rpc('cancel_community_activity_registration',{p_event_id:state.event.event_id});if(error)throw error;toast('Your registration was cancelled.');await loadEvent();}
 catch(error){toast(error.message||'Could not cancel your registration.');}
 finally{state.busy=false;}
}
async function cancelActivity(){
 if(!state.event?.viewer_is_host||state.busy)return;
 if(!confirm('Cancel this activity and release its reserved court slot?'))return;
 state.busy=true;
 try{const {error}=await supabase.rpc('cancel_community_event',{p_event_id:state.event.event_id});if(error)throw error;toast('Activity cancelled and court slot released.');await loadEvent();}
 catch(error){toast(error.message||'Could not cancel this activity.');}
 finally{state.busy=false;}
}
async function init(){
 if(!supabase)throw new Error('Courtly is not connected to Supabase.');
 let user=null;
 const {data:userResult,error:userError}=await supabase.auth.getUser();
 if(userError){
  const message=String(userError.message||'');
  const staleSession=/sub claim|user.*does not exist|invalid.*jwt|jwt.*invalid|session.*not found/i.test(message);
  if(staleSession){
   console.warn('Clearing stale Courtly session:',message);
   try{await supabase.auth.signOut({scope:'local'});}catch{}
  }else{
   console.warn('Courtly session check failed; continuing as guest:',message);
  }
 }else{
  user=userResult?.user||null;
 }
 state.user=user;
 if(!user)$('eventSignInPrompt').hidden=false;
 $('eventShareButton').addEventListener('click',shareActivity);
 $('eventStickyJoin').addEventListener('click',openRegistration);
 $('eventOpenRegistration').addEventListener('click',openRegistration);
 $('eventRegistrationForm').addEventListener('submit',registerActivity);
 $('eventCancelRegistration').addEventListener('click',cancelRegistration);
 $('eventCancelActivity').addEventListener('click',cancelActivity);
 $('eventCommentForm')?.addEventListener('submit',submitEventComment);
 await loadEvent();
 await loadEventComments();
}
init().catch(error=>{
 console.error('Courtly activity page failed:',error);
 $('eventMain').innerHTML='<div class="ce-load-state"><strong>We could not load this activity</strong><p>'+esc(error.message||'Please refresh and try again.')+'</p><a href="/community.html">Return to Activities & Games</a></div>';
 $('eventStickyBar').hidden=true;
});
