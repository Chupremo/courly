import { supabase, supabaseConfigError } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { user:null, role:'', displayName:'', avatarUrl:'', venues:[], posts:[], selectedFile:null, previewUrl:'', toastTimer:null };

function initials(value='Courtly') { return String(value).trim().split(/\s+/).map(x=>x[0]||'').join('').slice(0,2).toUpperCase() || 'C'; }
function toast(message) { const node=$('communityToast'); node.textContent=message; node.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer=setTimeout(()=>node.classList.remove('show'),3200); }
function setMessage(message='', kind='') { const node=$('communityPostMessage'); if(node){node.textContent=message;node.className=`community-inline-message ${kind}`.trim();} }
function avatarMarkup(url,name,klass='post-avatar') { return `<div class="${klass}">${url?`<img src="${esc(url)}" alt="${esc(name)}">`:esc(initials(name))}</div>`; }
async function signedUrl(bucket,path) {
  if(!path)return '';
  if(/^https?:\/\//i.test(path))return path;
  const {data,error}=await supabase.storage.from(bucket).createSignedUrl(path,3600);
  if(error){console.warn(`Could not sign ${bucket} asset`,error.message);return '';}
  return data?.signedUrl||'';
}
async function resolvePost(row) {
  const avatarBucket=row.author_type==='player'?'courtly-player-avatars':'courtly-venue-media';
  const [avatarUrl,mediaUrl]=await Promise.all([
    signedUrl(avatarBucket,row.author_avatar_path),
    signedUrl('courtly-community-media',row.media_path)
  ]);
  return {...row,author_avatar_url:avatarUrl,media_url:mediaUrl};
}
async function checkAccount() {
  const {data:{session},error:sessionError}=await supabase.auth.getSession();
  if(sessionError)throw sessionError;
  if(!session?.user)return false;
  state.user=session.user;
  const {data:player,error:playerError}=await supabase.from('player_profiles').select('id,player_name,full_name,avatar_url,is_private').eq('id',state.user.id).maybeSingle();
  if(playerError)throw playerError;
  if(player){
    state.role='player';
    state.displayName=player.player_name||player.full_name||'Courtly Player';
    state.avatarUrl=await signedUrl('courtly-player-avatars',player.avatar_url);
    state.privateProfile=!!player.is_private;
    return true;
  }
  const {data:venues,error:venueError}=await supabase.from('venues').select('id,name,owner_name,logo_url').eq('owner_id',state.user.id).order('created_at',{ascending:true}).limit(20);
  if(venueError)throw venueError;
  if(venues?.length){
    state.role='venue_owner'; state.venues=venues;
    state.displayName=venues[0].owner_name||venues[0].name||'Venue Owner';
    state.avatarUrl=await signedUrl('courtly-venue-media',venues[0].logo_url);
    return true;
  }
  return false;
}
function composerMarkup() {
  const venueSelect=state.role==='venue_owner'&&state.venues.length>1
    ? `<label class="venue-select-label">Post as venue<select id="communityVenueSelect">${state.venues.map((v,i)=>`<option value="${esc(v.id)}" ${i===0?'selected':''}>${esc(v.name)}</option>`).join('')}</select></label>` : '';
  return `<section class="community-composer card">
    <div class="composer-heading"><div><span class="composer-kicker">YOUR COMMUNITY</span><h2>Share an update</h2></div><span class="community-role">${state.role==='player'?'Player':'Venue owner'}</span></div>
    <form id="communityPostForm"><textarea id="communityPostBody" maxlength="2000" rows="3" placeholder="${state.role==='player'?'What’s happening on your court? Share a game, a highlight or an update…':'Share news, upcoming games, venue updates or photos from your facility…'}"></textarea>
      <div class="community-media-preview" id="communityMediaPreview" hidden></div>
      <div class="composer-actions"><div class="composer-tools">${venueSelect}<label class="media-pick">＋ Add photo or video<input id="communityMediaInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"></label><span class="media-limit">Images up to 10 MB · Videos up to 25 MB</span></div><button class="community-primary" id="communityPostButton" type="submit">Post to community</button></div>
      <div class="community-inline-message" id="communityPostMessage" aria-live="polite"></div></form>
    <p class="privacy-reminder">Posts are visible to signed-in Courtly members. ${state.role==='player'&&state.privateProfile?'Your profile is private, so posts you create will only be visible to you. You can change this in Player Profile.':'Keep posts respectful and only upload photos/videos you have permission to share.'}</p>
  </section>`;
}
function postMarkup(post) {
  const time=new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short'}).format(new Date(post.created_at));
  const media=post.media_url ? (post.media_type==='video'
    ? `<div class="post-media-wrap"><video controls playsinline preload="metadata" src="${esc(post.media_url)}"></video></div>`
    : `<img class="post-media" loading="lazy" src="${esc(post.media_url)}" alt="Community post media">`) : '';
  return `<article class="community-post" data-post-card="${esc(post.post_id)}">
    <header class="post-header">${avatarMarkup(post.author_avatar_url,post.author_name)}<div class="post-author"><strong>${esc(post.author_name)}${post.author_type==='venue_owner'?'<span class="venue-author-tag">VENUE</span>':''}</strong><small>${post.author_type==='venue_owner'&&post.venue_name?`${esc(post.venue_name)} · `:''}${esc(time)}</small></div><button class="post-more" type="button" data-report-post="${esc(post.post_id)}" aria-label="Report post">•••</button></header>
    ${post.body?`<div class="post-body">${esc(post.body)}</div>`:''}${media}
    <div class="post-counts"><span>${Number(post.likes_count||0).toLocaleString('en-PH')} likes</span><span>${Number(post.comments_count||0).toLocaleString('en-PH')} comments · ${Number(post.shares_count||0).toLocaleString('en-PH')} shares</span></div>
    <div class="post-actions"><button class="post-action ${post.viewer_liked?'liked':''}" type="button" data-like-post="${esc(post.post_id)}" data-liked="${post.viewer_liked?'1':'0'}">${post.viewer_liked?'♥ Liked':'♡ Like'}</button><button class="post-action" type="button" data-toggle-comments="${esc(post.post_id)}">☷ Comment</button><button class="post-action" type="button" data-share-post="${esc(post.post_id)}">↗ Share</button>${post.viewer_can_delete?`<button class="post-action" type="button" data-delete-post="${esc(post.post_id)}">Delete</button>`:''}</div>
    <div class="post-comments" id="comments-${esc(post.post_id)}" hidden></div>
  </article>`;
}
async function loadFeed() {
  $('communityFeed').innerHTML='<div class="community-state">Loading community posts…</div>';
  const requestedPost=new URLSearchParams(location.search).get('post');
  const {data,error}=await supabase.rpc('get_community_feed',{p_limit:30,p_offset:0,p_post_id:requestedPost||null});
  if(error)throw error;
  state.posts=await Promise.all((data||[]).map(resolvePost));
  renderFeed();
}
function renderFeed() {
  const node=$('communityFeed');
  node.innerHTML=state.posts.length?state.posts.map(postMarkup).join(''):'<div class="community-state"><strong>The Courtly community is just getting started</strong>Be the first to share a game, a court update or a sports moment.</div>';
  node.querySelectorAll('[data-like-post]').forEach(btn=>btn.addEventListener('click',()=>toggleLike(btn)));
  node.querySelectorAll('[data-toggle-comments]').forEach(btn=>btn.addEventListener('click',()=>toggleComments(btn.dataset.toggleComments)));
  node.querySelectorAll('[data-share-post]').forEach(btn=>btn.addEventListener('click',()=>sharePost(btn.dataset.sharePost)));
  node.querySelectorAll('[data-delete-post]').forEach(btn=>btn.addEventListener('click',()=>deletePost(btn.dataset.deletePost)));
  node.querySelectorAll('[data-report-post]').forEach(btn=>btn.addEventListener('click',()=>reportPost(btn.dataset.reportPost)));
}
async function toggleLike(button) {
  const postId=button.dataset.likePost; const liked=button.dataset.liked==='1'; button.disabled=true;
  try{
    if(liked){const {error}=await supabase.from('community_post_likes').delete().eq('post_id',postId).eq('user_id',state.user.id);if(error)throw error;}
    else {const {error}=await supabase.from('community_post_likes').insert({post_id:postId,user_id:state.user.id});if(error&&error.code!=='23505')throw error;}
    await loadFeed();
  }catch(error){button.disabled=false;toast(error.message||'Could not update your like.');}
}
async function resolveComment(row) {
  const bucket=row.author_type==='player'?'courtly-player-avatars':'courtly-venue-media';
  return {...row,avatar_url:await signedUrl(bucket,row.author_avatar_path)};
}
async function toggleComments(postId) {
  const panel=$(`comments-${postId}`); if(!panel)return;
  if(!panel.hidden){panel.hidden=true;return;}
  panel.hidden=false;panel.innerHTML='<div class="community-state">Loading comments…</div>';
  try{
    const {data,error}=await supabase.rpc('get_community_comments',{p_post_id:postId});if(error)throw error;
    const comments=await Promise.all((data||[]).map(resolveComment));
    panel.innerHTML=`<div class="comments-list">${comments.length?comments.map(c=>`<div class="comment-item">${avatarMarkup(c.avatar_url,c.author_name,'comment-avatar')}<div class="comment-bubble"><strong>${esc(c.author_name)}</strong><p>${esc(c.body)}</p></div></div>`).join(''):'<div class="subtle">No comments yet. Start the conversation.</div>'}</div><form class="comment-form" data-comment-form="${esc(postId)}"><input name="body" maxlength="1000" required placeholder="Write a comment…"><button type="submit">Send</button></form>`;
    panel.querySelector('form')?.addEventListener('submit',async e=>{e.preventDefault();const input=e.currentTarget.elements.body;const body=input.value.trim();if(!body)return;const button=e.currentTarget.querySelector('button');button.disabled=true;try{const {error}=await supabase.from('community_comments').insert({post_id:postId,author_id:state.user.id,body});if(error)throw error;await loadFeed();await toggleComments(postId);}catch(error){button.disabled=false;toast(error.message||'Could not post your comment.');}});
  }catch(error){panel.innerHTML=`<div class="community-state">Could not load comments: ${esc(error.message)}</div>`;}
}
async function sharePost(postId) {
  const url=`${location.origin}/community.html?post=${encodeURIComponent(postId)}`;
  try{
    if(navigator.share){await navigator.share({title:'Courtly Community',text:'See this post on Courtly',url});}
    else if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);toast('Post link copied.');}
    else {window.prompt('Copy this Courtly post link:',url);}
    const {error}=await supabase.rpc('record_community_post_share',{p_post_id:postId});if(error)throw error;
    await loadFeed();
  }catch(error){if(error?.name==='AbortError')return;toast(error.message||'Could not share this post.');}
}
async function deletePost(postId) {
  const post=state.posts.find(p=>p.post_id===postId);if(!post||!post.viewer_can_delete)return;
  if(!confirm('Delete this community post? This cannot be undone.'))return;
  try{
    const {error}=await supabase.from('community_posts').delete().eq('id',postId).eq('author_id',state.user.id);if(error)throw error;
    if(post.media_path){const {error:mediaError}=await supabase.storage.from('courtly-community-media').remove([post.media_path]);if(mediaError)console.warn('Post media cleanup failed:',mediaError.message);}
    await loadFeed();toast('Your post was deleted.');
  }catch(error){toast(error.message||'Could not delete this post.');}
}
async function reportPost(postId) {
  const reason=prompt('Why are you reporting this post? Enter spam, harassment, inappropriate, misleading or other.','inappropriate');
  if(!reason)return;const allowed=['spam','harassment','inappropriate','misleading','other'];const normalized=reason.trim().toLowerCase();
  if(!allowed.includes(normalized)){toast('Choose spam, harassment, inappropriate, misleading or other.');return;}
  try{const {error}=await supabase.from('community_reports').insert({post_id:postId,reporter_id:state.user.id,reason:normalized});if(error&&error.code!=='23505')throw error;toast(error?.code==='23505'?'You have already reported this post.':'Thanks. Your report has been submitted for review.');}
  catch(error){toast(error.message||'Could not submit your report.');}
}
function clearMediaPreview() {
  if(state.previewUrl)URL.revokeObjectURL(state.previewUrl);state.previewUrl='';state.selectedFile=null;
  const preview=$('communityMediaPreview');preview.hidden=true;preview.innerHTML='';$('communityMediaInput').value='';
}
function handleMediaSelect(event) {
  const file=event.target.files?.[0];if(!file)return;
  const isImage=file.type.startsWith('image/');const isVideo=file.type.startsWith('video/');
  const allowed=['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'];
  if(!allowed.includes(file.type)||(!isImage&&!isVideo)){toast('Choose a JPG, PNG, WEBP, GIF, MP4, WEBM or MOV file.');event.target.value='';return;}
  const max=isImage?10*1024*1024:25*1024*1024;
  if(file.size>max){toast(isImage?'Images must be 10 MB or smaller.':'Videos must be 25 MB or smaller.');event.target.value='';return;}
  clearMediaPreview();state.selectedFile=file;state.previewUrl=URL.createObjectURL(file);
  const preview=$('communityMediaPreview');preview.hidden=false;
  preview.innerHTML=isImage?`<img src="${esc(state.previewUrl)}" alt="Selected photo preview">`:`<video controls playsinline src="${esc(state.previewUrl)}"></video>`;
  const remove=document.createElement('button');remove.className='preview-remove';remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Remove selected media');remove.addEventListener('click',clearMediaPreview);preview.append(remove);
}
async function submitPost(event) {
  event.preventDefault();const button=$('communityPostButton');const body=$('communityPostBody').value.trim();const file=state.selectedFile;
  if(!body&&!file){setMessage('Write something or add a photo/video before posting.','error');return;}
  button.disabled=true;button.textContent='Publishing…';setMessage('');let mediaPath=null;let mediaType=null;
  try{
    if(file){
      const ext=(file.name.split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'');
      const uuid=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
      mediaPath=`${state.user.id}/${uuid}.${ext}`;mediaType=file.type.startsWith('video/')?'video':'image';
      const {error:uploadError}=await supabase.storage.from('courtly-community-media').upload(mediaPath,file,{upsert:false,contentType:file.type,cacheControl:'3600'});
      if(uploadError)throw new Error(`Media upload failed: ${uploadError.message}`);
    }
    const payload={body,media_path:mediaPath,media_type:mediaType};
    if(state.role==='venue_owner'&&$('communityVenueSelect')?.value)payload.venue_id=$('communityVenueSelect').value;
    const {error}=await supabase.from('community_posts').insert(payload);
    if(error){if(mediaPath)await supabase.storage.from('courtly-community-media').remove([mediaPath]);throw error;}
    $('communityPostBody').value='';clearMediaPreview();setMessage('Your update has been published.','success');await loadFeed();toast('Posted to the Courtly community.');
  }catch(error){console.error('Courtly community post failed:',error);setMessage(error.message||'Could not publish your post.','error');}
  finally{button.disabled=false;button.textContent='Post to community';}
}
function showSignin() {
  $('communityComposer').hidden=true;$('communityFeed').innerHTML='';$('communitySignin').hidden=false;
  $('communityUser').textContent='Guest';
}
async function init() {
  if(!supabase){showSignin();$('communityFeed').innerHTML=`<div class="community-state"><strong>Courtly is not connected</strong>${esc(supabaseConfigError||'Check the Supabase configuration.')}</div>`;return;}
  const allowed=await checkAccount();
  if(!allowed){showSignin();return;}
  $('communitySignin').hidden=true;$('communityComposer').hidden=false;
  $('communityUser').textContent=state.displayName;
  $('communityRole').textContent=state.role==='player'?'Player':'Venue owner';
  $('communityPostForm').addEventListener('submit',submitPost);
  $('communityMediaInput').addEventListener('change',handleMediaSelect);
  $('refreshCommunityFeed').addEventListener('click',()=>loadFeed().catch(e=>toast(e.message)));
  await loadFeed();
  const postId=new URLSearchParams(location.search).get('post');
  if(postId){setTimeout(()=>{const card=document.querySelector(`[data-post-card="${CSS.escape(postId)}"]`);card?.scrollIntoView({behavior:'smooth',block:'center'});},250);}
}
init().catch(error=>{
  console.error('Courtly community failed to load:',error);
  $('communityFeed').innerHTML=`<div class="community-state"><strong>We could not load the community</strong>${esc(error.message||'Please refresh and try again. If this is a new deployment, run migration 011 in Supabase.')}</div>`;
});
