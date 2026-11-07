import { supabase } from './supabase-client.js';
const $ = (id) => document.getElementById(id);
const money = (v) => '₱' + Number(v||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc = (v) => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = (v) => v ? new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(v)) : '—';
let state = null;
let ownerAccounts = [];
let activeAdminTab = 'accounts';

function showLogin(message='') {
  $('loginPanel').classList.remove('hidden'); $('adminApp').classList.add('hidden');
  const box=$('loginMessage'); if(message){box.textContent=message;box.classList.remove('hidden')}else box.classList.add('hidden');
}
function render(data, accounts=[]) {
  state=data; ownerAccounts=accounts; $('loginPanel').classList.add('hidden'); $('adminApp').classList.remove('hidden');
  const s=data.summary||{};
  const trialCount=accounts.filter(v=>v.activation_status==='trial').length;
  const holdCount=accounts.filter(v=>v.activation_status==='on_hold').length;
  $('summaryGrid').innerHTML=`<div class="kpi"><small>Trial venues</small><strong>${trialCount}</strong></div><div class="kpi"><small>On Hold</small><strong>${holdCount}</strong></div><div class="kpi"><small>Accrued fees</small><strong>${money(s.unbilled_accrued)}</strong></div><div class="kpi"><small>Outstanding invoices</small><strong>${money(s.outstanding)}</strong></div><div class="kpi"><small>Remittances to review</small><strong>${Number(s.pending_remittances||0)}</strong></div><div class="kpi"><small>Suspended venues</small><strong>${Number(s.suspended_venues||0)}</strong></div>`;
  const settings=data.settings||{}; const form=$('settingsForm');
  for(const key of ['terms_version','payment_method','payment_account_name','payment_account_number','payment_qr_url','payment_instructions']) if(form.elements[key]) form.elements[key].value=settings[key]||'';
  renderOwnerAccounts(); renderRemittances(data.remittances||[]); renderInvoices(data.invoices||[]);
  setAdminTab(activeAdminTab);
}
function statusLabel(status){return String(status||'trial').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function ownerActions(v){
  const id=esc(v.venue_id), status=v.activation_status||'trial';
  const buttons=[];
  if(status==='suspended') buttons.push(`<button class="btn lime" data-owner-action="active" data-venue-id="${id}">Unsuspend</button>`);
  else if(status!=='active') buttons.push(`<button class="btn lime" data-owner-action="active" data-venue-id="${id}">Activate</button>`);
  if(status!=='on_hold') buttons.push(`<button class="btn ghost" data-owner-action="on_hold" data-venue-id="${id}">On Hold</button>`);
  if(status!=='suspended') buttons.push(`<button class="btn ghost" data-owner-action="suspended" data-venue-id="${id}">Suspend</button>`);
  if(status!=='trial') buttons.push(`<button class="btn ghost" data-owner-action="trial" data-venue-id="${id}">Return to Trial</button>`);
  if(status!=='banned') buttons.push(`<button class="btn danger" data-owner-action="banned" data-venue-id="${id}">Ban</button>`);
  return buttons.join('');
}
function renderOwnerAccounts(){
  const filter=$('ownerStatusFilter')?.value||'all';
  const rows=ownerAccounts.filter(v=>filter==='all'||v.activation_status===filter);
  $('ownerAccountList').innerHTML=rows.length?rows.map(v=>`<article class="owner-card">
    <div class="row"><div><strong style="font-size:17px">${esc(v.venue_name||'Unnamed venue')}</strong><div class="muted">${esc(v.slug||'')} · Created ${date(v.created_at)}</div></div><span class="pill ${esc(v.activation_status||'trial')}">${esc(statusLabel(v.activation_status))}</span></div>
    <div class="owner-meta">
      <div><small>Owner</small><strong>${esc(v.owner_name||'—')}</strong></div>
      <div><small>Email</small><strong>${esc(v.owner_email||'—')}</strong></div>
      <div><small>Phone</small><strong>${esc(v.phone||'—')}</strong></div>
      <div><small>Location</small><strong>${esc([v.address,v.city].filter(Boolean).join(', ')||'—')}</strong></div>
      <div><small>Sport</small><strong>${esc(v.sport||'—')}</strong></div>
      <div><small>Bookings</small><strong>${Number(v.booking_count||0)} total · ${Number(v.confirmed_booking_count||0)} confirmed</strong></div>
    </div>
    ${v.activation_status==='trial'?`<div class="notice"><strong>Trial:</strong> ${Number(v.trial_days_remaining||0)} day(s) remaining · ends ${date(v.trial_ends_at)} · Courtly owner fee: <strong>₱0</strong></div>`:''}
    ${v.activation_status==='on_hold'?'<div class="notice" style="background:#fff7df;border-left-color:#d79b00"><strong>ON HOLD:</strong> Trial expired or account was placed on hold. New bookings are paused until an admin activates or returns the venue to trial.</div>':''}
    ${v.activation_status==='active'?'<div class="notice"><strong>Fully active:</strong> New court bookings incur ₱10 per booked court-hour and flow to weekly billing.</div>':''}
    <div class="status-actions">${ownerActions(v)}</div>
  </article>`).join(''):'<div class="notice">No owner accounts match this status.</div>';
  $('ownerAccountList').querySelectorAll('[data-owner-action]').forEach(btn=>btn.addEventListener('click',()=>setOwnerStatus(btn.dataset.venueId,btn.dataset.ownerAction)));
}
async function setOwnerStatus(venueId,status){
  const venue=ownerAccounts.find(v=>v.venue_id===venueId); if(!venue)return;
  const labels={active:'fully activate',on_hold:'place ON HOLD',suspended:'suspend',banned:'BAN',trial:'restart a 7-day trial for'};
  const destructive=['on_hold','suspended','banned'].includes(status);
  const feeNote=status==='active'?'\n\nIMPORTANT: ₱10 per booked court-hour starts only on NEW bookings created after activation.':'';
  if(!confirm(`Are you sure you want to ${labels[status]||status} ${venue.venue_name}?${feeNote}`))return;
  let reason=null;
  if(destructive){reason=prompt('Optional admin reason / note:','')||null;}
  try{
    const {error}=await supabase.rpc('set_courtly_owner_account_status',{p_venue_id:venueId,p_status:status,p_reason:reason});
    if(error)throw error;
    await load();
  }catch(e){alert(e.message||'Could not change owner account status.');}
}
function setAdminTab(tab){
  activeAdminTab=tab==='billing'?'billing':'accounts';
  $('accountsPanel')?.classList.toggle('hidden',activeAdminTab!=='accounts');
  $('billingPanel')?.classList.toggle('hidden',activeAdminTab!=='billing');
  $('accountsTabBtn')?.classList.toggle('active',activeAdminTab==='accounts');
  $('billingTabBtn')?.classList.toggle('active',activeAdminTab==='billing');
}
function renderRemittances(rows) {
  $('remittanceList').innerHTML=rows.length?rows.map(r=>`<article class="item"><div class="row"><div><strong>${esc(r.venue_name)} · ${money(r.amount)}</strong><div class="muted">Invoice ${esc(r.invoice_number)} · ${esc(r.payment_method)} · ${esc(r.payment_reference)}</div><div class="muted">${esc(r.owner_email||'')} · Submitted ${date(r.submitted_at)}</div></div><span class="pill ${esc(r.status)}">${esc(r.status)}</span></div>${r.owner_note?`<div class="muted">Owner note: ${esc(r.owner_note)}</div>`:''}${r.proof_path?`<button class="btn ghost" data-proof="${esc(r.id)}">Open payment proof</button>`:''}${r.status==='submitted'?`<div class="row"><input data-admin-note="${esc(r.id)}" style="flex:1;min-width:180px;min-height:40px;border:1px solid #cbd5e1;border-radius:9px;padding:8px" placeholder="Optional review note"><button class="btn lime" data-review="approved" data-id="${esc(r.id)}">Approve</button><button class="btn danger" data-review="rejected" data-id="${esc(r.id)}">Reject</button></div>`:''}${r.admin_note?`<div class="muted">Admin note: ${esc(r.admin_note)}</div>`:''}</article>`).join(''):'<div class="notice">No remittance submissions yet.</div>';
  $('remittanceList').querySelectorAll('[data-review]').forEach(b=>b.addEventListener('click',()=>review(b.dataset.id,b.dataset.review)));
  $('remittanceList').querySelectorAll('[data-proof]').forEach(b=>b.addEventListener('click',()=>openProof(b.dataset.proof)));
}
function renderInvoices(rows) {
  $('invoiceList').innerHTML=rows.length?rows.map(i=>`<article class="item"><div class="row"><div><strong>${esc(i.invoice_number)} · ${esc(i.venue_name)}</strong><div class="muted">${esc(i.owner_email||'')} · Issued ${date(i.issued_at)} · Due ${date(i.due_at)}</div></div><span class="pill ${esc(i.status)}">${esc(i.status.replaceAll('_',' '))}</span></div><div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="kpi"><small>Amount</small><strong>${money(i.amount_due)}</strong></div><div class="kpi"><small>Paid</small><strong>${money(i.amount_paid)}</strong></div><div class="kpi"><small>Balance</small><strong>${money(i.balance)}</strong></div></div><div class="lineitems">${(i.lines||[]).map(l=>`<div class="line"><span>${esc(l.description)}</span><strong>${money(l.amount)}</strong></div>`).join('')}</div></article>`).join(''):'<div class="notice">No weekly invoices have been generated yet.</div>';
}
async function load() {
  if(!supabase){showLogin('Supabase configuration is missing.');return;}
  const {data:auth,error:authError}=await supabase.auth.getUser();
  if(authError||!auth?.user){showLogin();return;}
  const [{data,error},{data:ownerData,error:ownerError}]=await Promise.all([
    supabase.rpc('get_courtly_admin_billing'),
    supabase.rpc('get_courtly_admin_owner_accounts')
  ]);
  if(error){showLogin(`This account is not authorized for the Courtly admin console, or migration 006 is not installed. ${error.message}`);return;}
  if(ownerError && !['PGRST202','42883'].includes(ownerError.code)){showLogin(`Owner activation controls are unavailable. ${ownerError.message}`);return;}
  render(data||{},ownerData?.venues||[]);
}
async function review(id,decision){
  const note=$(`[data-admin-note="${CSS.escape(id)}"]`)?.value||'';
  if(decision==='approved'&&!confirm('Approve this remittance? Verify the actual funds have arrived in Courtly\'s receiving account first.'))return;
  if(decision==='rejected'&&!confirm('Reject this remittance submission?'))return;
  try{const {data,error}=await supabase.rpc('review_courtly_remittance',{p_remittance_id:id,p_decision:decision,p_admin_note:note||null});if(error)throw error;await load();alert(data?.already_processed?'This remittance was already reviewed.':'Remittance '+decision+'.');}
  catch(e){alert(e.message||'Could not review remittance.');}
}
async function openProof(remittanceId){
  const r=(state?.remittances||[]).find(x=>x.id===remittanceId);if(!r?.proof_path)return;
  const {data,error}=await supabase.storage.from('courtly-remittance-proofs').createSignedUrl(r.proof_path,300);
  if(error){alert(error.message);return;}window.open(data.signedUrl,'_blank','noopener');
}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const {error}=await supabase.auth.signInWithPassword({email:String(fd.get('email')).trim(),password:String(fd.get('password'))});if(error){showLogin(error.message);return;}await load();});
$('refreshBtn').addEventListener('click',load);
$('logoutBtn').addEventListener('click',async()=>{await supabase.auth.signOut();showLogin('You have signed out.');});
$('generateBtn').addEventListener('click',async()=>{if(!confirm('Generate weekly invoices for all unbilled Courtly fee-ledger entries now? This creates real invoices.'))return;const {data,error}=await supabase.rpc('generate_weekly_courtly_invoices');if(error){alert(error.message);return;}alert(`Invoice generation complete. Created: ${data?.invoices_created??0}`);await load();});
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const {error}=await supabase.rpc('update_courtly_billing_settings',{p_terms_version:String(fd.get('terms_version')),p_payment_method:String(fd.get('payment_method')),p_payment_account_name:String(fd.get('payment_account_name')||''),p_payment_account_number:String(fd.get('payment_account_number')||''),p_payment_qr_url:String(fd.get('payment_qr_url')||''),p_payment_instructions:String(fd.get('payment_instructions')||'')});if(error){alert(error.message);return;}alert('Courtly remittance settings saved. Changing the terms version requires venue owners to accept the new version.');await load();});
load();

$('accountsTabBtn')?.addEventListener('click',()=>setAdminTab('accounts'));
$('billingTabBtn')?.addEventListener('click',()=>setAdminTab('billing'));
$('ownerStatusFilter')?.addEventListener('change',renderOwnerAccounts);
