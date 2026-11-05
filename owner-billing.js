import { supabase } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const peso = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmtDate = (value) => value ? new Intl.DateTimeFormat('en-PH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Manila' }).format(new Date(value)) : '—';
let busy = false;
let latestBilling = null;
let billingRefreshTimer = null;
let billingVisibilityHandlerAttached = false;

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

function feeActivityMarkup(rows) {
  if (!rows.length) {
    return '<div class="billing-empty">No Courtly fees have been recorded yet. Once a paid court booking or paid Open Play registration is confirmed, it will appear here.</div>';
  }
  return `<div class="billing-activity-list">${rows.map((entry) => {
    const amount = Number(entry.fee_amount || 0);
    const credit = amount < 0;
    const status = entry.billing_status || (credit ? 'credit' : entry.invoice_id ? 'invoiced' : 'accrued');
    const statusLabel = status === 'accrued' ? 'Accrued · next Friday statement'
      : status === 'invoiced' ? `Included in ${entry.invoice_number || 'invoice'}`
      : 'Credit / adjustment';
    return `<div class="billing-activity-row">
      <div class="billing-activity-copy">
        <strong>${esc(entry.description || 'Courtly transaction fee')}</strong>
        <div class="billing-muted">${fmtDate(entry.occurred_at)} · ${entry.source_type === 'court_booking' ? 'Court rental' : 'Open Play'}</div>
      </div>
      <div class="billing-activity-amount">
        <strong>${credit ? '−' : ''}${peso(Math.abs(amount))}</strong>
        <span class="billing-pill ${credit ? 'credit' : esc(status)}">${esc(statusLabel)}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
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
  const feeActivity = Array.isArray(data.fee_activity) ? data.fee_activity : [];
  const billingState = venue.billing_status || 'active';
  const suspended = billingState === 'suspended';
  const balance = Number(summary.outstanding_balance ?? summary.total_owed ?? 0);
  const accrued = Number(summary.unbilled_balance || 0);
  const invoiced = Number(summary.invoiced_balance || 0);
  const credits = Number(summary.pending_credits || 0);
  const updatedAt = summary.updated_at || new Date().toISOString();

  host.innerHTML = `
    ${suspended ? `<div class="notice" style="border-left-color:#b42318;background:#fff1f0;color:#7a271a"><strong>Your venue listing is temporarily suspended.</strong><br>${esc(venue.billing_suspend_reason || 'Settle the overdue Courtly invoice and wait for payment verification.')} Your owner portal and existing confirmed bookings remain accessible.</div>` : ''}
    <div class="billing-grid">
      <div class="billing-card"><div class="billing-muted">Current Courtly balance</div><div class="billing-kpi">${peso(balance)}</div><div class="billing-muted">All unpaid invoices plus fees already accumulated.</div></div>
      <div class="billing-card"><div class="billing-muted">Accrued · not yet invoiced</div><div class="billing-kpi">${peso(accrued)}</div><div class="billing-muted">Already recorded and included in your live balance.${credits > 0 ? ` Pending credits: ${peso(credits)}.` : ''}</div></div>
      <div class="billing-card"><div class="billing-muted">Invoiced · unpaid balance</div><div class="billing-kpi">${peso(invoiced)}</div><div class="billing-muted">Issued statements that are not fully paid.</div></div>
    </div>
    <div class="billing-row billing-status-strip">
      <span>Venue status: <strong style="color:${suspended ? '#b42318' : '#2e6500'}">${suspended ? 'Suspended' : 'Active'}</strong> · ${venue.is_published ? 'Visible to players' : 'Not publicly listed'}</span>
      <span>Weekly statement: <strong>Friday, 9:00 AM Manila time</strong> · Due within 72 hours of issue</span>
    </div>
    <div class="notice billing-live-note"><strong>Your balance is kept up to date.</strong> Each qualifying court booking or paid Open Play registration adds its Courtly fee to the live balance when it is confirmed. Friday's statement does not add a new fee—it simply groups the charges already shown in the activity list below. You can check your exact running balance here at any time.</div>
    ${!terms.accepted ? `<section class="billing-terms"><div><strong style="color:#234b08">Accept the Courtly Venue Owner Terms</strong><div class="billing-muted">Before your venue can accept new court bookings or Open Play registrations, the owner must accept the current fee and weekly remittance policy (version ${esc(terms.version)}).</div></div><div class="billing-actions"><a class="btn" href="/venue-owner-terms" target="_blank" rel="noopener">Read Terms &amp; Conditions</a><button class="btn primary" id="acceptCourtlyTerms">I agree and accept</button></div></section>` : `<div class="billing-row"><span class="billing-muted">Venue Owner Terms ${esc(terms.version)} accepted.</span><span class="billing-pill paid">Accepted</span></div>`}
    <section class="panel">
      <div class="panelhead billing-panelhead"><div><h3>Live Courtly fee activity</h3><div class="billing-muted">Latest 100 charges and adjustments · Updated ${fmtDate(updatedAt)}</div></div><button class="btn" id="refreshCourtlyBalance" type="button">↻ Refresh balance</button></div>
      ${feeActivityMarkup(feeActivity)}
    </section>
    <section class="panel"><div class="panelhead"><h3>Weekly statements &amp; invoices</h3><span class="pill">Every Friday</span></div><div class="billing-muted" style="margin-bottom:10px">You can submit payment against an issued invoice below. Fees marked “Accrued · next Friday statement” are already included in your current balance; they become payable against an invoice once grouped into the weekly statement.</div>${invoices.length ? `<div style="display:grid;gap:14px">${invoices.map((invoice) => invoiceCard(invoice,payment)).join('')}</div>` : `<div class="billing-empty">No weekly statement has been issued yet. Your accrued fees are already included in the live balance above and will be grouped into the next Friday statement. You do not need to estimate or guess the amount.</div>`}</section>
    <section class="panel"><div class="panelhead"><h3>Remittance history</h3><span class="muted small">${remittances.length} submission(s)</span></div>${remittances.length ? remittances.map((r) => `<div class="billing-row" style="padding:10px 0;border-bottom:1px solid #edf0f4"><div><strong>${peso(r.amount)} · ${esc(r.payment_reference)}</strong><div class="billing-muted">${esc(r.payment_method)} · ${fmtDate(r.submitted_at)}</div></div>${statusPill(r.status)}</div>`).join('') : `<div class="billing-empty">No remittances submitted yet.</div>`}</section>
    <div class="notice">Court rentals: ₱10 per successfully paid court-hour, owed by the venue owner. Paid Open Play: the player pays a ₱10 Transaction Fee on top of the registration price; because the venue receives the full QR payment, the venue remits that ₱10 to Courtly. Free Open Play has no fee. Friday statements summarize fees already recorded in this live ledger. Any issued invoice is due within 72 hours.</div>
  `;

  host.querySelector('#acceptCourtlyTerms')?.addEventListener('click', acceptTerms);
  host.querySelectorAll('[data-remit-form]').forEach((form) => form.addEventListener('submit', submitRemittance));
  host.querySelector('#refreshCourtlyBalance')?.addEventListener('click', () => loadCourtlyOwnerBilling({ silent: true }));
}

async function loadCourtlyOwnerBilling(options = {}) {
  const silent = options.silent === true;
  const host = $('ownerBillingApp');
  if (!host) return;
  ensureBillingAutoRefresh();
  if (!supabase) { if (!silent) host.innerHTML = '<div class="notice">Courtly is not connected to Supabase.</div>'; return; }
  if (!silent || !latestBilling) host.innerHTML = '<section class="panel"><div class="muted">Loading your live Courtly balance and fee activity…</div></section>';
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth?.user) {
    if (!silent) host.innerHTML = '<div class="notice">Your owner session has expired. Please sign in again.</div>';
    return;
  }
  const { data, error } = await supabase.rpc('get_owner_courtly_billing');
  if (error) {
    if (!silent || !latestBilling) host.innerHTML = `<div class="notice" style="color:#b42318">Could not load Courtly billing: ${esc(error.message)}<br><span class="billing-muted">Confirm migrations 006 and 008 are installed and that you are signed in using the venue owner account.</span></div>`;
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

function ensureBillingAutoRefresh() {
  if (!billingRefreshTimer) {
    billingRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && $('ownerBillingApp')) {
        loadCourtlyOwnerBilling({ silent: true });
      }
    }, 60000);
  }
  if (!billingVisibilityHandlerAttached) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && $('ownerBillingApp')) {
        loadCourtlyOwnerBilling({ silent: true });
      }
    });
    billingVisibilityHandlerAttached = true;
  }
}

window.loadCourtlyOwnerBilling = loadCourtlyOwnerBilling;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if ($('ownerBillingApp')) loadCourtlyOwnerBilling();
  }, { once:true });
} else if ($('ownerBillingApp')) {
  loadCourtlyOwnerBilling();
}
