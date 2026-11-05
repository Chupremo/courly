import { supabase } from './supabase-client.js';
const $ = (id) => document.getElementById(id);
const money = (v) => '₱' + Number(v||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc = (v) => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = (v) => v ? new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(v)) : '—';
let state = null;

function showLogin(message='') {
  $('loginPanel').classList.remove('hidden'); $('adminApp').classList.add('hidden');
  const box=$('loginMessage'); if(message){box.textContent=message;box.classList.remove('hidden')}else box.classList.add('hidden');
}
function render(data) {
  state=data; $('loginPanel').classList.add('hidden'); $('adminApp').classList.remove('hidden');
  const s=data.summary||{};
  $('summaryGrid').innerHTML=`<div class="kpi"><small>Total fees owed (live)</small><strong>${money(s.total_owed)}</strong></div><div class="kpi"><small>Accrued, not yet invoiced</small><strong>${money(s.unbilled_accrued)}</strong></div><div class="kpi"><small>Outstanding invoices</small><strong>${money(s.outstanding)}</strong></div><div class="kpi"><small>Overdue balance</small><strong>${money(s.overdue)}</strong></div><div class="kpi"><small>Remittances to review</small><strong>${Number(s.pending_remittances||0)}</strong></div><div class="kpi"><small>Suspended venues</small><strong>${Number(s.suspended_venues||0)}</strong></div>`;
  const settings=data.settings||{}; const form=$('settingsForm');
  for(const key of ['terms_version','payment_method','payment_account_name','payment_account_number','payment_qr_url','payment_instructions']) if(form.elements[key]) form.elements[key].value=settings[key]||'';
  renderRemittances(data.remittances||[]); renderInvoices(data.invoices||[]);
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
  const {data,error}=await supabase.rpc('get_courtly_admin_billing');
  if(error){showLogin(`This account is not authorized for the Courtly admin console, or migration 006 is not installed. ${error.message}`);return;}
  render(data||{});
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
