import { supabase } from './supabase-client.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const admin = document.body.dataset.supportMode === 'admin';
let currentUser = null, requestId = null, submittedPayload = null, busy = false;
let accountVersion = 0, loadVersion = 0, accountInitialized = false;
let observedSession = null, observedAuth = false;
function status(text, error = false) { $('supportStatus').textContent = text; $('supportStatus').className = 'support-status' + (error ? ' error' : ''); $('supportStatus').hidden = !text; }
function accountChanged() {
  accountVersion++;
  loadVersion++;
  currentUser = null;
  requestId = null;
  submittedPayload = null;
  busy = false;
  $('supportWorkspace').hidden = true;
  $('supportRequests').innerHTML = '';
  $('supportForm')?.reset();
  if ($('supportAdminLink')) $('supportAdminLink').hidden = true;
  $('supportSignIn').hidden = false;
  status('Your sign-in changed. Sign in again or refresh this page before viewing or sending private requests.', true);
}
function requestMarkup(row) {
  return `<article class="support-request"><h3>${esc(row.subject)}</h3><p class="support-muted"><span class="support-tag">${esc(row.status.replaceAll('_',' '))}</span> · ${esc(row.category)} · ${esc(new Date(row.created_at).toLocaleString('en-PH'))}<br>Reference: ${esc(row.id)}</p><p>${esc(row.message)}</p>${row.admin_reply ? `<div class="support-reply"><strong>Courtly reply</strong><p>${esc(row.admin_reply)}</p></div>` : `<p class="support-muted">${row.status==='resolved'?'This request is marked resolved. No reply was added.':'Your request is waiting for a reply. Check this page for updates.'}</p>`}${admin ? `<form class="support-form support-section" data-request="${esc(row.id)}"><label>Status<select name="status">${['open','in_progress','resolved'].map(s => `<option value="${s}" ${s===row.status?'selected':''}>${s.replaceAll('_',' ')}</option>`).join('')}</select></label><label>Reply visible to this user<textarea name="reply" maxlength="4000">${esc(row.admin_reply)}</textarea></label><button class="support-btn" type="submit">Save reply and status</button></form>` : ''}</article>`;
}
async function loadRequests() {
  if (!currentUser) return;
  const actor = currentUser.id, account = accountVersion, request = ++loadVersion;
  const current = () => account === accountVersion && request === loadVersion && currentUser?.id === actor;
  let query = supabase.from('courtly_support_requests').select('id,category,subject,message,status,admin_reply,created_at,updated_at').order('created_at',{ascending:false}).limit(admin ? 100 : 25);
  if (!admin) query = query.eq('user_id',currentUser.id);
  if (admin && $('supportFilter')?.value !== 'all') query = query.eq('status',$('supportFilter').value);
  const {data,error}=await query;
  if (!current()) return;
  if(error) {
    if (!$('supportRequests').dataset.loaded) $('supportRequests').textContent = 'Requests could not be loaded. Use Refresh status to try again.';
    throw new Error('We couldn’t load support requests. Please refresh the list to try again.');
  }
  $('supportRequests').innerHTML = (data || []).map(requestMarkup).join('') || '<p class="support-muted">No support requests to show.</p>';
  $('supportRequests').dataset.loaded = 'true';
  if (admin) $('supportRequests').querySelectorAll('form[data-request]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); const button=form.querySelector('button'); if(button.disabled||!currentUser)return;button.disabled=true;
    const account = accountVersion;
    try {
      const values=new FormData(form);const {error}=await supabase.rpc('review_courtly_support_request',{p_id:form.dataset.request,p_status:values.get('status'),p_reply:values.get('reply')});if(error)throw error;
      if (account !== accountVersion) return;
      status('Reply and status saved. The user can read the reply on their Help page.');
      try { await loadRequests(); } catch { status('Reply saved. Refresh to update the request list.'); }
    } catch(error) { if(account===accountVersion)status(error.message || 'Unable to save this reply.',true); } finally {button.disabled=false;}
  }));
}
async function init() {
  if(!supabase){status('Account help is temporarily unavailable. Please try again shortly.',true);return;}
  supabase.auth.onAuthStateChange((_event, session) => {
    // Keep this callback synchronous and invalidate private DOM immediately.
    if (!accountInitialized) { observedSession=session; observedAuth=true; return; }
    if ((session?.user?.id || null) !== (currentUser?.id || null)) accountChanged();
  });
  const {data,error}=await supabase.auth.getSession();if(error)throw error;
  currentUser=(observedAuth?observedSession:data?.session)?.user;
  accountInitialized=true;
  const account = accountVersion;
  if(!currentUser){$('supportSignIn').hidden=false;return;}
  if(admin){const {data:allowed,error:authError}=await supabase.rpc('is_courtly_admin');if(account!==accountVersion)return;if(authError||!allowed){status('This inbox is available to Courtly administrators only.',true);return;}}
  $('supportWorkspace').hidden=false;
  if(!admin){
    const {data:allowed}=await supabase.rpc('is_courtly_admin');if(account!==accountVersion)return;if(allowed && $('supportAdminLink'))$('supportAdminLink').hidden=false;
    $('supportForm').addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!currentUser||!event.currentTarget.reportValidity())return;
      const account = accountVersion;
      const form=event.currentTarget;const values=new FormData(form);const payload={p_category:values.get('category'),p_subject:String(values.get('subject')).trim(),p_message:String(values.get('message')).trim()};
      const serialized=JSON.stringify(payload);if(submittedPayload!==serialized){requestId=crypto.randomUUID();submittedPayload=serialized;}
      busy=true;const button=form.querySelector('button');button.disabled=true;button.textContent='Sending request…';status('');
      try {
        const {data:receivedId,error}=await supabase.rpc('submit_courtly_support_request',{p_id:requestId,...payload});if(error)throw error;
        if(account!==accountVersion)return;
        if(receivedId!==requestId)throw new Error('We could not confirm receipt of your request. Retry with the same details.');
        status('Request received. Reference: '+requestId+'. Check this page for a reply.');form.reset();requestId=null;submittedPayload=null;
        try {await loadRequests();}catch{status('Your request was received. Refresh this page to see its status.');}
      }catch(error){if(account===accountVersion)status(error.message||'We could not confirm receipt of your request. Retry with the same details.',true);}
      finally{busy=false;button.disabled=false;button.textContent='Send private request';}
    });
  }
  $('supportRefresh')?.addEventListener('click',()=>loadRequests().catch(error=>status(error.message,true)));
  $('supportFilter')?.addEventListener('change',()=>loadRequests().catch(error=>status(error.message,true)));
  await loadRequests();
}
init().catch(error=>status(error.message||'Unable to load account support. Please refresh and try again.',true));
