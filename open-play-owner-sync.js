import { supabase } from './supabase-client.js';
import { dispatchBookingNotifications } from './notification-client.js';

const DEMO_KEY_PREFIX = 'courtlyDemoOpenPlayTransactionsV1:';
const DEMO_REQUEST = new URLSearchParams(location.search).get('demo');
const DEMO_VENUE_SLUGS = new Set([
  'demo-batangas-racquet-club',
  'demo-lipa-pickleball-hub',
  'demo-santos-pickleball-club',
  'demo-southside-sports-center'
]);
const PORTAL_KEY = DEMO_VENUE_SLUGS.has(DEMO_REQUEST) ? `courtlyOwnerPortalDemoV1:${DEMO_REQUEST}` : 'courtlyOwnerPortalV1';
let transactionLoadId = 0;
const pendingReviews = new Set();
let latestOpenPlayMetrics = { registrations: 0, confirmedCount: 0, pendingCount: 0, revenue: 0, playerPaidFees: 0, legacyOwnerFees: 0, remittanceDue: 0, venueNet: 0 };

function portalState() {
  if (!DEMO_VENUE_SLUGS.has(DEMO_REQUEST) && window.courtlyOwnerState) return window.courtlyOwnerState;
  try { return JSON.parse(localStorage.getItem(PORTAL_KEY) || '{}'); }
  catch { return {}; }
}
function venueContext() {
  const state = portalState();
  const venue = state.venue || {};
  return {
    slug: String(venue.slug || 'courtly-demo').trim(),
    name: String(venue.name || 'Courtly Demo Venue').trim(),
    email: String(venue.email || '').trim()
  };
}
function demoRows() {
  const venue = venueContext();
  const key = DEMO_KEY_PREFIX + venue.slug;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(saved)) return saved.map(row => ({ ...row, transaction_fee: row.transaction_fee ?? 10, transaction_fee_payer: row.transaction_fee_payer || 'player', player_total: row.player_total ?? (Number(row.fee||0) + Number(row.transaction_fee||0)), billing_eligible: row.billing_eligible ?? true }));
  } catch {}
  const today = new Date();
  const day = offset => {
    const d = new Date(today); d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const rows = [
    { id:'demo-op-001', registration_reference:'OP-DEMO-001', event_title:'Weekend Social Play', event_date:day(1), event_time:'9:00 AM', player_name:'Alex Reyes', player_email:'alex@example.com', player_phone:'0917 000 0001', fee:200, payment_status:'confirmed', registration_status:'confirmed', receipt_path:null, transaction_fee:10, transaction_fee_payer:'player', player_total:210, created_at:new Date().toISOString(), demo:true },
    { id:'demo-op-002', registration_reference:'OP-DEMO-002', event_title:'Beginner Open Play', event_date:day(2), event_time:'4:00 PM', player_name:'Jamie Cruz', player_email:'jamie@example.com', player_phone:'0917 000 0002', fee:150, payment_status:'awaiting_verification', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-3600000).toISOString(), demo:true },
    { id:'demo-op-003', registration_reference:'OP-DEMO-003', event_title:'Weekend Social Play', event_date:day(3), event_time:'9:00 AM', player_name:'Taylor Santos', player_email:'taylor@example.com', player_phone:'0917 000 0003', fee:200, payment_status:'awaiting_verification', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-7200000).toISOString(), demo:true },
    { id:'demo-op-004', registration_reference:'OP-DEMO-004', event_title:'Evening Doubles', event_date:day(-1), event_time:'6:00 PM', player_name:'Morgan Dela Cruz', player_email:'morgan@example.com', player_phone:'0917 000 0004', fee:180, payment_status:'rejected', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-86400000).toISOString(), demo:true }
  ];
  rows.forEach(row => { row.transaction_fee = row.transaction_fee ?? 10; row.transaction_fee_payer = row.transaction_fee_payer || 'player'; row.player_total = row.player_total ?? (Number(row.fee||0) + (row.transaction_fee_payer === 'player' ? Number(row.transaction_fee||0) : 0)); row.billing_eligible = row.billing_eligible ?? true; });
  localStorage.setItem(key, JSON.stringify(rows));
  return rows;
}
function saveDemoRows(rows) {
  localStorage.setItem(DEMO_KEY_PREFIX + venueContext().slug, JSON.stringify(rows));
}
function fmtMoney(value) {
  return '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function updateMetrics(rows, venueName, demo = false) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const active = safeRows.filter(r => r.registration_status !== 'cancelled');
  const confirmed = active.filter(r => r.payment_status === 'confirmed');
  const pending = active.filter(r => r.payment_status === 'awaiting_verification');
  const revenue = confirmed.reduce((sum, r) => sum + Number(r.fee || 0), 0);
  const billingEligible = confirmed.filter(r => r.billing_eligible !== false);
  const playerPaidFees = billingEligible.reduce((sum, r) => sum + (r.transaction_fee_payer === 'player' ? Number(r.transaction_fee || 0) : 0), 0);
  const billableLegacyOwnerFees = billingEligible.reduce((sum, r) => sum + (r.transaction_fee_payer === 'venue_owner' ? Number(r.transaction_fee || 0) : 0), 0);
  const legacyOwnerFees = confirmed.reduce((sum, r) => sum + (r.transaction_fee_payer === 'venue_owner' ? Number(r.transaction_fee || 0) : 0), 0);
  const venueNet = revenue - legacyOwnerFees;
  const remittanceDue = playerPaidFees + billableLegacyOwnerFees;

  // Only registrations created on/after billing_effective_at are included in
  // the current weekly invoice estimate. Historical rows remain visible for
  // reporting but are not silently back-billed by the new policy.
  latestOpenPlayMetrics = {
    registrations: active.length,
    confirmedCount: confirmed.length,
    pendingCount: pending.length,
    revenue,
    playerPaidFees,
    legacyOwnerFees,
    remittanceDue,
    venueNet,
    transactionFees: playerPaidFees
  };
  window.getCourtlyOpenPlayMetrics = () => ({ ...latestOpenPlayMetrics });

  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  set('opEarnRegistrations', active.length.toLocaleString('en-PH'));
  set('opEarnPaidCount', confirmed.length.toLocaleString('en-PH'));
  set('opEarnPendingCount', pending.length.toLocaleString('en-PH'));
  set('opEarnRevenue', fmtMoney(revenue));
  set('opEarnFees', fmtMoney(playerPaidFees));
  set('opEarnLegacyFees', fmtMoney(legacyOwnerFees));
  set('opEarnNet', fmtMoney(venueNet));
  set('opEarnRemittance', fmtMoney(remittanceDue));

  const note = document.getElementById('opEarnNote');
  if (note) note.textContent = demo
    ? `${venueName}: sample Open Play transactions for demo purposes only. No real payments or receipts are represented.`
    : `${venueName}: the Open Play remittance estimate includes only registrations created on or after the current Courtly billing start. Historical registrations remain visible for reference and are not back-billed. For eligible paid sessions, the ₱10 player-paid Convenience Fee is collected through your venue QR on Courtly’s behalf; it is not deducted from event registration revenue. Free events have no fee.`;

  if (typeof window.updateOverviewGrossStats === 'function') {
    window.updateOverviewGrossStats();
  }
}
function reservationStatus(row) {
  if (row.registration_status === 'cancelled') return 'Cancelled';
  if (row.payment_status === 'confirmed') return row.registration_status === 'waitlisted' ? 'Paid · Waitlisted' : 'Confirmed';
  return row.payment_status === 'rejected' ? 'Rejected' : 'Awaiting verification';
}
function transactionMarkup(rows, demo = false) {
  if (!rows.length) return '<div class="empty">No Open Play registrations have been submitted yet.</div>';
  return rows.map(row => {
    const pending = row.payment_status === 'awaiting_verification' && row.registration_status !== 'cancelled';
    const status = reservationStatus(row);
    const statusClass = status === 'Cancelled' ? 'cancelled' : row.payment_status === 'confirmed' ? 'confirmed' : row.payment_status === 'rejected' ? 'rejected' : 'pending';
    const receipt = demo ? '<span class="muted small">Sample receipt (demo)</span>' : (row.receipt_path ? `<span class="muted small" data-op-receipt-id="${esc(row.id)}">Loading receipt…</span>` : '<span class="muted small">Receipt unavailable</span>');
    return `<article class="owner-openplay-transaction" style="border:1px solid #e5e9f1;border-radius:12px;padding:14px;margin:10px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center">
      <div><strong>${esc(row.player_name)}</strong> <span class="muted small">· ${esc(row.registration_reference)}</span>
      <div class="muted small">${esc(row.event_title)} · ${esc(row.event_date)} · ${esc(row.event_time)}</div>
      <div class="muted small">${esc(row.player_email)}${row.player_phone?' · '+esc(row.player_phone):''}</div>
      <div class="op-txn-meta"><span class="op-txn-amount">Registration: ${fmtMoney(row.fee)}</span>${Number(row.transaction_fee||0)>0?`<span class="muted small">${row.transaction_fee_payer==='player'?'Convenience Fee (paid by player)':'Historical owner-paid Convenience Fee'}: ${fmtMoney(row.transaction_fee)}</span>`:''}<span class="muted small">Total player checkout: ${fmtMoney(row.player_total ?? (Number(row.fee||0)+(row.transaction_fee_payer==='player'?Number(row.transaction_fee||0):0)))}</span><span class="pill ${statusClass}">${status}</span>${row.billing_eligible===false?'<span class="muted small">Historical · excluded from current invoices</span>':''}${receipt}</div></div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end">${pending?`<button class="btn" data-op-review="confirmed" data-op-id="${esc(row.id)}">${demo?'Mark paid (demo)':'Verify payment'}</button><button class="btn" data-op-review="rejected" data-op-id="${esc(row.id)}" style="background:#fff;color:#b42318;border:1px solid #f0c8c8">Reject</button>`:''}</div>
    </article>`;
  }).join('');
}
function ensureTransactionPanel() {
  let host = document.getElementById('opRecentTransactions');
  if (host) return host;
  host = document.createElement('section');
  host.id = 'opRecentTransactions'; host.className = 'panel'; host.style.marginTop = '16px';
  host.innerHTML = '<div class="panelhead"><h3>Recent Open Play transactions</h3><span class="pill">Payment review</span></div><div id="opTxnBody" class="muted small">Loading registrations…</div>';
  const recent = [...document.querySelectorAll('.panel')].find(panel => panel.querySelector('.panelhead h3')?.textContent?.trim() === 'Recent reservations');
  const earnings = document.getElementById('opEarnRevenue')?.closest('.panel');
  (recent || earnings || document.querySelector('.content') || document.body)?.insertAdjacentElement('afterend', host);
  return host;
}
async function reviewPayment(id, decision, demo) {
  if (pendingReviews.has(id) || window.courtlyOwnerIsBusy?.()) return;
  const run = async () => {
    let committed = false;
    pendingReviews.add(id);
    document.querySelectorAll(`[data-op-id="${CSS.escape(id)}"]`).forEach(button => { button.disabled = true; });
    try {
      if (demo) {
        saveDemoRows(demoRows().map(row => row.id === id ? { ...row, payment_status: decision, registration_status: decision === 'confirmed' ? 'confirmed' : 'reserved' } : row));
      } else {
        const { error } = await supabase.rpc('review_open_play_payment', { p_registration_id: id, p_decision: decision });
        if (error) throw error;
        void dispatchBookingNotifications(supabase, { type: 'open_play_registration', id }).catch(() => {});
      }
      committed = true;
      // The mutation is already committed. A later list/receipt refresh cannot
      // turn a successful approval into a payment-failed message.
      window.toast?.(demo ? 'Demo Open Play payment updated in this browser.' : decision === 'confirmed' ? 'Open Play payment confirmed.' : 'Open Play payment rejected.');
      try { await renderTransactions(); }
      catch {
        window.toast?.('Open Play payment updated. Refresh the reservations list to see the latest status.');
      }
    } finally {
      pendingReviews.delete(id);
      document.querySelectorAll(`[data-op-id="${CSS.escape(id)}"]`).forEach(button => { button.disabled = committed; });
    }
  };
  if (typeof window.ownerAction === 'function') return window.ownerAction(run);
  try { await run(); } catch (error) { alert(error.message || 'Unable to update Open Play payment.'); }
}
function bindReview(rows, demo, host = document.getElementById('opRecentTransactions')) {
  host?.querySelectorAll('[data-op-review]').forEach(button => {
    button.disabled = pendingReviews.has(button.dataset.opId);
    button.addEventListener('click', () => reviewPayment(button.dataset.opId, button.dataset.opReview, demo));
  });
}


function renderUnifiedRows(rows, demo = false) {
  const tbody = document.getElementById('unifiedReservationRows');
  if (!tbody) return false;
  tbody.querySelector('#unifiedOpenPlayLoading')?.remove();
  tbody.querySelector('#openPlayLoadError')?.remove();
  tbody.querySelectorAll('[data-openplay-row="true"]').forEach(node => node.remove());
  const html = (rows || []).map(row => {
    const status = reservationStatus(row);
    const pill = status === 'Cancelled' ? 'cancelled' : row.payment_status === 'confirmed' ? 'confirmed' : row.payment_status === 'rejected' ? 'rejected' : 'pending';
    const fee = Number(row.fee || 0);
    const txnFee = Number(row.transaction_fee || 0);
    const feePayer = row.transaction_fee_payer || 'venue_owner';
    const venueNet = feePayer === 'player' || feePayer === 'none' ? fee : fee - txnFee;
    return `<tr data-openplay-row="true" data-reservation-status="${esc(status)}">
      <td class="nowrap"><span class="pill" style="background:#f3ecdc;color:#8a672b">Open Play</span></td>
      <td><strong>${esc(row.registration_reference || row.id)}</strong><br>${esc(row.player_name)}<br><span class="muted">${esc(row.player_email || '')}</span></td>
      <td>${esc(row.event_date || '')}<br>${esc(row.event_time || '')}</td>
      <td>${esc(row.event_title || 'Open Play session')}</td>
      <td class="num">${fmtMoney(fee)}</td><td class="num">${fmtMoney(row.payment_status === 'confirmed' ? txnFee : 0)}<br><span class="muted small">${feePayer === 'player' ? 'paid by player' : feePayer === 'none' ? 'no fee' : 'legacy owner fee'}</span></td><td class="num"><strong>${fmtMoney(row.payment_status === 'confirmed' ? venueNet : 0)}</strong></td>
      <td class="nowrap"><span class="pill ${pill}">${status}</span>${row.billing_eligible===false?'<br><span class="muted small">Historical · excluded from current invoices</span>':''}${row.receipt_path && !demo ? `<br><span class="muted small" data-op-receipt-id="${esc(row.id)}">Loading receipt…</span>` : demo ? '<br><span class="muted small">Demo receipt</span>' : ''}</td>
      <td class="nowrap"><div class="actions">${row.payment_status === 'awaiting_verification' && row.registration_status !== 'cancelled' ? `<button class="btn primary sm" data-op-review="confirmed" data-op-id="${esc(row.id)}">${demo ? 'Mark paid (demo)' : 'Confirm paid'}</button><button class="btn danger sm" data-op-review="rejected" data-op-id="${esc(row.id)}">Reject</button>` : ''}</div></td>
    </tr>`;
  }).join('');
  tbody.insertAdjacentHTML('beforeend', html || '<tr data-openplay-row="true"><td colspan="9" class="muted small">No Open Play reservations.</td></tr>');
  bindReview(rows, demo, tbody);
  window.prepareOwnerTables?.();
  window.filterBookings?.();
  return true;
}

async function attachReceiptLinks(rows, host, current) {
  for (const row of rows) {
    if (!row.receipt_path || !current()) continue;
    const label = host.querySelector(`[data-op-receipt-id="${CSS.escape(String(row.id))}"]`);
    if (!label) continue;
    try {
      const { data: signed, error } = await supabase.storage.from('courtly-payment-receipts').createSignedUrl(row.receipt_path, 600);
      if (!current()) return;
      if (error || !signed?.signedUrl) { label.textContent = 'Receipt unavailable — refresh to retry'; continue; }
      label.outerHTML = `<a class="btn sm" href="${esc(signed.signedUrl)}" target="_blank" rel="noopener noreferrer">View receipt ↗</a>`;
    } catch { if (current()) label.textContent = 'Receipt unavailable — refresh to retry'; }
  }
}

async function renderTransactions() {
  const tbody = document.getElementById('unifiedReservationRows');
  const host = document.getElementById('opRecentTransactions');
  if (!tbody && !host) return;
  const body = tbody || host.querySelector('#opTxnBody');
  if (!body) return;
  const requestId = ++transactionLoadId;
  const current = () => requestId === transactionLoadId && body.isConnected && (tbody ? document.getElementById('unifiedReservationRows') === body : document.getElementById('opTxnBody') === body);
  body.setAttribute('aria-busy', 'true');
  if (!tbody && !body.dataset.loaded) body.textContent = 'Loading Open Play transactions…';
  const venue = venueContext();
  try {
    const demo = DEMO_VENUE_SLUGS.has(DEMO_REQUEST);
    let rows, venueName = venue.name;
    if (demo) {
      rows = demoRows();
    } else {
      if (!supabase) throw new Error('The booking service is unavailable. Please refresh and try again.');
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (!current()) return;
      if (authError || !authData?.user) throw new Error('Your owner session has expired. Please sign in again.');
      const { data: ownedVenues, error: venueError } = await supabase.from('venues').select('id,slug,name').eq('owner_id', authData.user.id).order('created_at', { ascending: true });
      if (venueError) throw venueError;
      if (!current()) return;
      const venueId = window.courtlyOwnerState?.venue?.id;
      const ownedVenue = venueId ? (ownedVenues || []).find(item => item.id === venueId) : (ownedVenues || []).find(item => item.slug === venue.slug) || (ownedVenues || [])[0];
      if (!ownedVenue?.slug) throw new Error('This venue is not linked to your owner account. Please sign in with its owner account.');
      syncPortalSlug(ownedVenue);
      const { data, error } = await supabase.rpc('get_owner_open_play_transactions', { p_venue_slug: ownedVenue.slug });
      if (error) throw error;
      if (!current()) return;
      rows = data || [];
      venueName = ownedVenue.name;
    }
    if (!current()) return;
    if (tbody) renderUnifiedRows(rows, demo);
    else {
      body.innerHTML = (demo ? '<div class="notice gold">Demo workspace — sample records only. Changes stay in this browser.</div>' : '') + transactionMarkup(rows, demo);
      bindReview(rows, demo, body);
    }
    body.dataset.loaded = 'true';
    if (window.courtlyOwnerIsBusy?.()) window.setOwnerBusy?.(true);
    updateMetrics(rows, venueName, demo);
    if (!demo) await attachReceiptLinks(rows, body, current);
  } catch (error) {
    if (!current()) return;
    const message = esc(error.message || 'Could not load Open Play reservations.');
    if (tbody) {
      tbody.querySelectorAll('[data-openplay-row],#unifiedOpenPlayLoading,#openPlayLoadError').forEach(node => node.remove());
      tbody.insertAdjacentHTML('beforeend', `<tr id="openPlayLoadError"><td colspan="9"><div role="alert">${message}</div><button type="button" class="btn sm" onclick="window.loadOpenPlayTransactions()">Try again</button></td></tr>`);
      window.filterBookings?.();
    } else {
      body.innerHTML = `<div class="notice" role="alert">${message}</div><button type="button" class="btn sm" onclick="window.loadOpenPlayTransactions()">Try again</button>`;
    }
    // An unavailable earnings source is not a verified zero balance.
    for (const id of ['opEarnRegistrations','opEarnPaidCount','opEarnPendingCount','opEarnRevenue','opEarnFees','opEarnLegacyFees','opEarnNet','opEarnRemittance']) {
      const node = document.getElementById(id); if (node) node.textContent = 'Unavailable';
    }
    console.warn('Open Play reservations could not be refreshed:', error);
  } finally { if (current()) body.setAttribute('aria-busy', 'false'); }
}

// Keep the owner portal's public booking slug identical to the slug stored in Supabase.
// A mismatch makes /v/<slug> point at a venue the database does not know, and Open Play
// registrations are rejected as "not linked to an active Courtly owner venue".
function syncPortalSlug(ownedVenue) {
  try {
    const slug = String(ownedVenue?.slug || '').trim();
    if (!slug || DEMO_VENUE_SLUGS.has(DEMO_REQUEST)) return;
    const stored = portalState();
    const current = stored.venue || {};
    if (current.slug === slug && current.slugLocked) return;
    stored.venue = { ...current, slug, slugLocked: true };
    if (DEMO_VENUE_SLUGS.has(DEMO_REQUEST)) localStorage.setItem(PORTAL_KEY, JSON.stringify(stored));
    if (window.courtlyOwnerState?.venue) {
      window.courtlyOwnerState.venue.slug = slug;
      window.courtlyOwnerState.venue.slugLocked = true;
    }
  } catch (error) { console.warn('Could not sync the public booking slug:', error); }
}

async function refreshOpenPlayRegistrationCounts() {
  // A signed-in owner can also open a demo. Never send demo event IDs to the live service.
  if (DEMO_VENUE_SLUGS.has(DEMO_REQUEST)) return;
  if (!supabase) return;
  const nodes = [...document.querySelectorAll('[data-op-count]')];
  if (!nodes.length) return;
  try {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) return; // Demo announcement counts are local preview data.
    const ids = nodes.map(node => node.getAttribute('data-op-count')).filter(Boolean);
    const { data, error } = await supabase.rpc('get_open_play_registration_counts', { p_event_ids: ids });
    if (error) throw error;
    const counts = new Map((data || []).map(row => [String(row.event_id), Number(row.registered_count || 0)]));
    const stored = portalState(); const events = stored.openPlays || [];
    nodes.forEach(node => {
      const id = node.getAttribute('data-op-count'); const event = events.find(item => String(item.id) === id);
      if (!event) return;
      const count = counts.get(id) || 0; const limit = Number(event.limit || 20);
      event.registeredCount = count; node.textContent = `${count} / ${limit}`;
      const spots = document.querySelector(`[data-op-spots="${CSS.escape(id)}"]`);
      if (spots) spots.textContent = `${Math.max(0, limit - count)} spots available`;
    });
    stored.openPlays = events; if (DEMO_VENUE_SLUGS.has(DEMO_REQUEST)) localStorage.setItem(PORTAL_KEY, JSON.stringify(stored));
  } catch (error) { console.warn('Open Play registration counts could not be refreshed:', error.message || error); }
}

window.refreshOpenPlayRegistrationCounts = refreshOpenPlayRegistrationCounts;
window.loadOpenPlayTransactions = renderTransactions;
renderTransactions();
setInterval(() => { if (document.visibilityState === 'visible' && !pendingReviews.size && !window.courtlyOwnerIsBusy?.()) { refreshOpenPlayRegistrationCounts(); renderTransactions(); } }, 30000);

// Refresh as soon as the owner returns to the tab, instead of waiting for the 30-second timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !pendingReviews.size && !window.courtlyOwnerIsBusy?.()) { refreshOpenPlayRegistrationCounts(); renderTransactions(); }
});
