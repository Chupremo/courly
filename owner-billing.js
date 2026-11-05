import { supabase } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const peso = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmtDate = (value) => value ? new Intl.DateTimeFormat('en-PH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Manila' }).format(new Date(value)) : '—';
let busy = false;
let latestBilling = null;

function statusPill(status) {
  const value = String(status || 'issued').toLowerCase();
  const label = value.replaceAll('_',' ');
  return `<span class="billing-pill ${esc(value)}">${esc(label)}</span>`;
}

function invoiceCard(invoice, paymentDetails) {
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const remittances = (latestBilling?.remittances || []).filter((r) => r.invoice_id === invoice.id);
  const pendingTotal = remittances.filter((r) => r.status === 'submitted').reduce((sum,r) => sum + Number(r.amount || 0), 0);
  const balance = Math.max(0, Number(invoice.balance ?? Number(invoice.amount_due || 0) - Number(invoice.amount_paid || 0)));
  const canSubmit = balance > pendingTotal && invoice.status !== 'paid' && invoice.status !== 'void';
  return `<article class="billing-invoice">
    <div class="billing-row">
      <div><div class="eyebrow">${esc(invoice.invoice_number)}</div><h3 style="margin:4px 0;color:#001A47">Weekly Courtly invoice</h3><div class="billing-muted">Issued ${fmtDate(invoice.issued_at)} · Due ${fmtDate(invoice.due_at)}</div></div>
      ${statusPill(invoice.status)}
    </div>
    <div class="billing-grid">
      <div class="billing-card"><div class="billing-muted">Invoice amount</div><div class="billing-kpi">${peso(invoice.amount_due)}</div></div>
      <div class="billing-card"><div class="billing-muted">Paid / approved</div><div class="billing-kpi">${peso(invoice.amount_paid)}</div></div>
      <div class="billing-card"><div class="billing-muted">Remaining balance</div><div class="billing-kpi">${peso(balance)}</div></div>
    </div>
    <div class="billing-lines">${lines.map((line) => `<div class="billing-line"><span>${esc(line.description)}</span><strong>${peso(line.amount)}</strong></div>`).join('') || '<div class="billing-muted">No invoice line details.</div>'}</div>
    ${pendingTotal > 0 ? `<div class="notice">Remittance submitted and awaiting verification: <strong>${peso(pendingTotal)}</strong>. This submission is not considered paid until Courtly approves it.</div>` : ''}
    ${canSubmit ? `<div class="billing-card">
      <h3>Pay Courtly and submit remittance</h3>
      <div class="billing-muted">Pay using the Courtly account below, then enter your transaction reference. Your venue's player payments are separate from this weekly remittance.</div>
      ${paymentDetails.qr_url ? `<div style="display:grid;justify-items:center;margin:14px 0"><img class="billing-qr" src="${esc(paymentDetails.qr_url)}" alt="Courtly remittance QR"></div>` : ''}
      <div class="billing-lines">
        ${paymentDetails.method ? `<div class="billing-line"><span>Payment method</span><strong>${esc(paymentDetails.method)}</strong></div>` : ''}
        ${paymentDetails.account_name ? `<div class="billing-line"><span>Account name</span><strong>${esc(paymentDetails.account_name)}</strong></div>` : ''}
        ${paymentDetails.account_number ? `<div class="billing-line"><span>Account / wallet number</span><strong>${esc(paymentDetails.account_number)}</strong></div>` : ''}
        ${paymentDetails.instructions ? `<div class="notice">${esc(paymentDetails.instructions)}</div>` : ''}
      </div>
      <form class="billing-form" data-remit-form="${esc(invoice.id)}">
        <div><label for="remitAmount-${esc(invoice.id)}">Amount remitted (₱)</label><input id="remitAmount-${esc(invoice.id)}" name="amount" type="number" min="0.01" max="${balance-pendingTotal}" step="0.01" value="${(balance-pendingTotal).toFixed(2)}" required></div>
        <div><label for="remitMethod-${esc(invoice.id)}">Payment method</label><select id="remitMethod-${esc(invoice.id)}" name="method" required><option value="GCash">GCash</option><option value="Maya">Maya</option><option value="Bank transfer">Bank transfer</option><option value="QR Ph">QR Ph</option><option value="Other">Other</option></select></div>
        <div class="full"><label for="remitRef-${esc(invoice.id)}">Transaction reference number</label><input id="remitRef-${esc(invoice.id)}" name="reference" required maxlength="120" placeholder="Enter the reference shown by your payment app"></div>
        <div class="full"><label for="remitProof-${esc(invoice.id)}">Payment proof (optional)</label><input id="remitProof-${esc(invoice.id)}" name="proof" type="file" accept="image/png,image/jpeg,image/webp,application/pdf"><div class="billing-muted">Optional image or PDF, maximum 10 MB.</div></div>
        <div class="full"><label for="remitNote-${esc(invoice.id)}">Note (optional)</label><textarea id="remitNote-${esc(invoice.id)}" name="note" rows="2" maxlength="500" placeholder="Additional payment information"></textarea></div>
        <div class="full"><button class="btn primary" type="submit" ${busy?'disabled':''}>Submit remittance for verification</button></div>
      </form>
    </div>` : ''}
    ${remittances.length ? `<div><h4 style="color:#001A47;margin:4px 0 8px">Remittance submissions</h4>${remittances.map((r) => `<div class="billing-row" style="padding:8px 0;border-top:1px solid #e8edf3"><div><strong>${peso(r.amount)}</strong><div class="billing-muted">${esc(r.payment_method)} · ${esc(r.payment_reference)} · ${fmtDate(r.submitted_at)}</div>${r.admin_note?`<div class="billing-muted">Courtly note: ${esc(r.admin_note)}</div>`:''}</div>${statusPill(r.status)}</div>`).join('')}</div>` : ''}
  </article>`;
}

function renderBilling(data) {
  latestBilling = data;
  const host = $('ownerBillingApp');
  if (!host) return;
  const venue = data.venue || {};
  const summary = data.summary || {};
  const terms = data.terms || {};
  const invoices = Array.isArray(data.invoices) ? data.invoices : [];
  const payment = data.payment_details || {};
  const remittances = Array.isArray(data.remittances) ? data.remittances : [];
  const billingState = venue.billing_status || 'active';
  const suspended = billingState === 'suspended';
  const balance = Number(summary.outstanding_balance || 0);

  host.innerHTML = `
    ${suspended ? `<div class="notice" style="border-left-color:#b42318;background:#fff1f0;color:#7a271a"><strong>Your venue listing is temporarily suspended.</strong><br>${esc(venue.billing_suspend_reason || 'Settle the overdue Courtly invoice and wait for payment verification.')} Your owner portal and existing confirmed bookings remain accessible.</div>` : ''}
    <div class="billing-grid">
      <div class="billing-card"><div class="billing-muted">Outstanding Courtly fees</div><div class="billing-kpi">${peso(balance)}</div><div class="billing-muted">All unpaid invoices for ${esc(venue.name)}</div></div>
      <div class="billing-card"><div class="billing-muted">Venue listing</div><div style="font-size:22px;font-weight:700;color:${suspended?'#b42318':'#2e6500'}">${suspended?'Suspended':'Active'}</div><div class="billing-muted">${venue.is_published?'Visible to players':'Not publicly listed'}</div></div>
      <div class="billing-card"><div class="billing-muted">Payment deadline</div><div class="billing-kpi">72 hours</div><div class="billing-muted">From invoice issue time, every Friday</div></div>
    </div>
    ${!terms.accepted ? `<section class="billing-terms"><div><strong style="color:#234b08">Accept the Courtly Venue Owner Terms</strong><div class="billing-muted">Before your venue can accept new court bookings or Open Play registrations, the owner must accept the current fee and weekly remittance policy (version ${esc(terms.version)}).</div></div><div class="billing-actions"><a class="btn" href="/venue-owner-terms" target="_blank" rel="noopener">Read Terms &amp; Conditions</a><button class="btn primary" id="acceptCourtlyTerms">I agree and accept</button></div></section>` : `<div class="billing-row"><span class="billing-muted">Venue Owner Terms ${esc(terms.version)} accepted.</span><span class="billing-pill paid">Accepted</span></div>`}
    <section class="panel"><div class="panelhead"><h3>Weekly invoices</h3><span class="pill">Every Friday</span></div>${invoices.length ? `<div style="display:grid;gap:14px">${invoices.map((invoice) => invoiceCard(invoice,payment)).join('')}</div>` : `<div class="billing-empty">No Courtly invoices yet. Your first invoice will be generated on Friday when eligible fees have been recorded.</div>`}</section>
    <section class="panel"><div class="panelhead"><h3>Remittance history</h3><span class="muted small">${remittances.length} submission(s)</span></div>${remittances.length ? remittances.map((r) => `<div class="billing-row" style="padding:10px 0;border-bottom:1px solid #edf0f4"><div><strong>${peso(r.amount)} · ${esc(r.payment_reference)}</strong><div class="billing-muted">${esc(r.payment_method)} · ${fmtDate(r.submitted_at)}</div></div>${statusPill(r.status)}</div>`).join('') : `<div class="billing-empty">No remittances submitted yet.</div>`}</section>
    <div class="notice">Courtly fees are invoiced weekly. Court rentals are charged at ₱10 per successfully paid court-hour (venue owner-paid). Paid Open Play adds a ₱10 Transaction Fee to the player's checkout; the venue collects it through its own QR and remits it to Courtly. Free Open Play has no transaction fee. New bookings are paused if an invoice remains unpaid after 72 hours. Existing confirmed bookings remain available.</div>
  `;

  host.querySelector('#acceptCourtlyTerms')?.addEventListener('click', acceptTerms);
  host.querySelectorAll('[data-remit-form]').forEach((form) => form.addEventListener('submit', submitRemittance));
}

async function loadCourtlyOwnerBilling() {
  const host = $('ownerBillingApp');
  if (!host) return;
  if (!supabase) { host.innerHTML = '<div class="notice">Courtly is not connected to Supabase.</div>'; return; }
  host.innerHTML = '<section class="panel"><div class="muted">Loading invoices and remittance history…</div></section>';
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth?.user) {
    host.innerHTML = '<div class="notice">Your owner session has expired. Please sign in again.</div>';
    return;
  }
  const { data, error } = await supabase.rpc('get_owner_courtly_billing');
  if (error) {
    host.innerHTML = `<div class="notice" style="color:#b42318">Could not load Courtly billing: ${esc(error.message)}<br><span class="billing-muted">Confirm migration 006 is installed and that you are signed in using the venue owner account.</span></div>`;
    return;
  }
  renderBilling(data || {});
}

async function acceptTerms() {
  if (busy) return;
  const button = $('acceptCourtlyTerms');
  if (button) { button.disabled = true; button.textContent = 'Saving acceptance…'; }
  try {
    const { error } = await supabase.rpc('accept_courtly_venue_terms');
    if (error) throw error;
    await loadCourtlyOwnerBilling();
    alert('Courtly Venue Owner Terms accepted. Your venue can continue accepting new bookings, subject to its listing status.');
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = 'I agree and accept'; }
    alert(error.message || 'Could not save terms acceptance.');
  }
}

async function submitRemittance(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const invoiceId = form.dataset.remitForm;
  const fd = new FormData(form);
  const amount = Number(fd.get('amount'));
  const method = String(fd.get('method') || 'GCash');
  const reference = String(fd.get('reference') || '').trim();
  const note = String(fd.get('note') || '').trim();
  const file = fd.get('proof');
  const button = form.querySelector('button[type="submit"]');

  if (!Number.isFinite(amount) || amount <= 0 || !reference) {
    alert('Enter a valid amount and transaction reference.');
    return;
  }
  busy = true;
  if (button) { button.disabled = true; button.textContent = 'Submitting…'; }
  try {
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth?.user) throw new Error('Your owner session has expired. Please sign in again.');
    let proofPath = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Payment proof must be 10 MB or smaller.');
      const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
      if (!allowed.includes(file.type)) throw new Error('Upload a JPG, PNG, WebP or PDF file.');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-90) || 'proof';
      proofPath = `${auth.user.id}/${invoiceId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from('courtly-remittance-proofs').upload(proofPath,file,{upsert:false,contentType:file.type});
      if (uploadError) throw new Error(`Payment proof upload failed: ${uploadError.message}`);
    }
    const { error } = await supabase.rpc('submit_courtly_remittance', {
      p_invoice_id: invoiceId,
      p_amount: amount,
      p_payment_method: method,
      p_payment_reference: reference,
      p_proof_path: proofPath,
      p_owner_note: note || null
    });
    if (error) throw error;
    await loadCourtlyOwnerBilling();
    alert('Remittance submitted. Courtly will verify your payment and update your invoice.');
  } catch (error) {
    alert(error.message || 'Could not submit remittance.');
    if (button) { button.disabled = false; button.textContent = 'Submit remittance for verification'; }
  } finally {
    busy = false;
  }
}

window.loadCourtlyOwnerBilling = loadCourtlyOwnerBilling;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if ($('ownerBillingApp')) loadCourtlyOwnerBilling(); }, { once:true });
}
