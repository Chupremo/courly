import { supabase } from './supabase-client.js';

const DEMO_KEY_PREFIX = 'courtlyDemoOpenPlayTransactionsV1:';
const DEMO_REQUEST = new URLSearchParams(location.search).get('demo');
const DEMO_VENUE_SLUGS = new Set([
  'demo-batangas-racquet-club',
  'demo-lipa-pickleball-hub',
  'demo-santos-pickleball-club',
  'demo-southside-sports-center'
]);
const PORTAL_KEY = DEMO_VENUE_SLUGS.has(DEMO_REQUEST) ? `courtlyOwnerPortalDemoV1:${DEMO_REQUEST}` : 'courtlyOwnerPortalV1';

function portalState() {
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
    if (Array.isArray(saved)) return saved;
  } catch {}
  const today = new Date();
  const day = offset => {
    const d = new Date(today); d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const rows = [
    { id:'demo-op-001', registration_reference:'OP-DEMO-001', event_title:'Weekend Social Play', event_date:day(1), event_time:'9:00 AM', player_name:'Alex Reyes', player_email:'alex@example.com', player_phone:'0917 000 0001', fee:200, payment_status:'confirmed', registration_status:'confirmed', receipt_path:null, created_at:new Date().toISOString(), demo:true },
    { id:'demo-op-002', registration_reference:'OP-DEMO-002', event_title:'Beginner Open Play', event_date:day(2), event_time:'4:00 PM', player_name:'Jamie Cruz', player_email:'jamie@example.com', player_phone:'0917 000 0002', fee:150, payment_status:'awaiting_verification', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-3600000).toISOString(), demo:true },
    { id:'demo-op-003', registration_reference:'OP-DEMO-003', event_title:'Weekend Social Play', event_date:day(3), event_time:'9:00 AM', player_name:'Taylor Santos', player_email:'taylor@example.com', player_phone:'0917 000 0003', fee:200, payment_status:'awaiting_verification', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-7200000).toISOString(), demo:true },
    { id:'demo-op-004', registration_reference:'OP-DEMO-004', event_title:'Evening Doubles', event_date:day(-1), event_time:'6:00 PM', player_name:'Morgan Dela Cruz', player_email:'morgan@example.com', player_phone:'0917 000 0004', fee:180, payment_status:'rejected', registration_status:'reserved', receipt_path:null, created_at:new Date(Date.now()-86400000).toISOString(), demo:true }
  ];
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
  const active = rows.filter(r => r.registration_status !== 'cancelled');
  const confirmed = active.filter(r => r.payment_status === 'confirmed');
  const pending = active.filter(r => r.payment_status === 'awaiting_verification');
  const revenue = confirmed.reduce((sum, r) => sum + Number(r.fee || 0), 0);
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  set('opEarnRegistrations', active.length.toLocaleString('en-PH'));
  set('opEarnPaidCount', confirmed.length.toLocaleString('en-PH'));
  set('opEarnPendingCount', pending.length.toLocaleString('en-PH'));
  set('opEarnRevenue', fmtMoney(revenue));
  set('overviewOpenPlayBookings', confirmed.length.toLocaleString('en-PH'));
  const state = portalState();
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const courtGross = bookings.filter(b => b.status === 'Confirmed' && b.paymentStatus !== 'Unpaid').reduce((sum,b)=>sum+Number(b.price||0),0);
  const courtFees = bookings.filter(b => b.status === 'Confirmed' && b.paymentStatus !== 'Unpaid').reduce((sum,b)=>sum+10*Math.max(1,Number(b.duration||b.hours||1)),0);
  set('overviewCombinedGross', fmtMoney(courtGross + revenue));
  set('overviewTotalGross', fmtMoney(courtGross + revenue + courtFees));
  const note = document.getElementById('opEarnNote');
  if (note) note.textContent = demo
    ? `${venueName}: sample Open Play transactions for demo purposes only. No real payments or receipts are represented.`
    : `${venueName}: confirmed Open Play payments only. Pending receipts are excluded until verified.`;
  if (typeof window.updateOverviewGrossStats === 'function' && !demo) window.updateOverviewGrossStats();
}
function transactionMarkup(rows, demo = false) {
  if (!rows.length) return '<div class="empty">No Open Play registrations have been submitted yet.</div>';
  return rows.map(row => {
    const pending = row.payment_status === 'awaiting_verification';
    const status = row.payment_status === 'confirmed' ? 'Confirmed' : row.payment_status === 'rejected' ? 'Rejected' : 'Awaiting verification';
    const statusClass = row.payment_status === 'confirmed' ? 'confirmed' : row.payment_status === 'rejected' ? 'rejected' : 'pending';
    const receipt = demo ? '<span class="muted small">Sample receipt (demo)</span>' : (row.receipt_path ? '<span class="muted small">Receipt uploaded</span>' : '<span class="muted small">Receipt unavailable</span>');
    return `<article style="border:1px solid #e5e9f1;border-radius:12px;padding:14px;margin:10px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center">
      <div><strong>${esc(row.player_name)}</strong> <span class="muted small">· ${esc(row.registration_reference)}</span>
      <div class="muted small">${esc(row.event_title)} · ${esc(row.event_date)} · ${esc(row.event_time)}</div>
      <div class="muted small">${esc(row.player_email)}${row.player_phone?' · '+esc(row.player_phone):''}</div>
      <div style="margin-top:6px">${fmtMoney(row.fee)} · <span class="pill ${statusClass}">${status}</span> · ${receipt}</div></div>
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
function bindReview(rows, demo) {
  const host = document.getElementById('opRecentTransactions');
  host?.querySelectorAll('[data-op-review]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    const decision = button.dataset.opReview, id = button.dataset.opId;
    try {
      if (demo) {
        const updated = demoRows().map(row => row.id === id ? { ...row, payment_status:decision, registration_status:decision === 'confirmed' ? 'confirmed' : 'reserved' } : row);
        saveDemoRows(updated);
        await renderTransactions();
        return;
      }
      const { error } = await supabase.rpc('review_open_play_payment', { p_registration_id:id, p_decision:decision });
      if (error) throw error;
      await renderTransactions();
    } catch (error) {
      alert(error.message || 'Unable to update payment status.');
      button.disabled = false;
    }
  }));
}

async function renderTransactions() {
  const host = ensureTransactionPanel();
  const body = host.querySelector('#opTxnBody') || host.querySelector('div:last-child');
  body.textContent = 'Loading Open Play transactions…';
  const venue = venueContext();
  try {
    const { data: authData, error: authError } = DEMO_VENUE_SLUGS.has(DEMO_REQUEST)
      ? { data: { user: null }, error: null }
      : await supabase.auth.getUser();
    // Demo portal access is strictly local. It never queries or exposes Supabase registrations.
    if (DEMO_VENUE_SLUGS.has(DEMO_REQUEST) || authError || !authData?.user) {
      if (!DEMO_VENUE_SLUGS.has(venue.slug)) {
        body.innerHTML = '<div class="notice" style="color:#b42318">Your owner session is missing. Please log in again. Demo transactions are available only inside the four Courtly demo venues.</div>';
        const note = document.getElementById('opEarnNote');
        if (note) note.textContent = 'Sign in with your owner account to view real Open Play transactions.';
        updateMetrics([], venue.name, false);
        return;
      }
      const rows = demoRows();
      body.innerHTML = '<div class="notice gold" style="margin:8px 0">DEMO MODE · Sample records only. Changes are saved in this browser and do not represent real payments.</div>' + transactionMarkup(rows, true);
      updateMetrics(rows, venue.name, true);
      bindReview(rows, true);
      return;
    }
    const user = authData.user;
    const { data: ownedVenue, error: venueError } = await supabase.from('venues').select('slug,name').eq('owner_id', user.id).maybeSingle();
    if (venueError) throw venueError;
    if (!ownedVenue?.slug) throw new Error('Your account is not linked to a venue. Please contact Courtly support.');
    const { data: rows, error } = await supabase.rpc('get_owner_open_play_transactions', { p_venue_slug: ownedVenue.slug });
    if (error) throw error;
    const safeRows = rows || [];
    body.innerHTML = transactionMarkup(safeRows, false);
    updateMetrics(safeRows, ownedVenue.name, false);
    // Generate short-lived receipt links only for authenticated, venue-scoped records.
    for (const row of safeRows) {
      if (!row.receipt_path) continue;
      const { data: signed } = await supabase.storage.from('courtly-payment-receipts').createSignedUrl(row.receipt_path, 600);
      if (!signed?.signedUrl) continue;
      const article = [...body.querySelectorAll('article')].find(node => node.textContent.includes(row.registration_reference));
      const receiptLabel = [...(article?.querySelectorAll('span') || [])].find(node => node.textContent === 'Receipt uploaded');
      if (receiptLabel) receiptLabel.outerHTML = `<a href="${esc(signed.signedUrl)}" target="_blank" rel="noopener">View receipt</a>`;
    }
    bindReview(safeRows, false);
  } catch (error) {
    body.innerHTML = `<div class="notice" style="color:#b42318">${esc(error.message || 'Could not load Open Play transactions.')}</div>`;
    const note = document.getElementById('opEarnNote');
    if (note) note.textContent = error.message || 'Could not load Open Play earnings.';
    console.warn('Open Play transactions could not be refreshed:', error);
  }
}

async function refreshOpenPlayRegistrationCounts() {
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
    stored.openPlays = events; localStorage.setItem(PORTAL_KEY, JSON.stringify(stored));
  } catch (error) { console.warn('Open Play registration counts could not be refreshed:', error.message || error); }
}

window.refreshOpenPlayRegistrationCounts = refreshOpenPlayRegistrationCounts;
window.loadOpenPlayTransactions = renderTransactions;
renderTransactions();
setInterval(() => { refreshOpenPlayRegistrationCounts(); renderTransactions(); }, 30000);
