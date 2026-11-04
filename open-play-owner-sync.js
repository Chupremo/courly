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
let latestOpenPlayMetrics = { registrations: 0, confirmedCount: 0, pendingCount: 0, revenue: 0 };

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
  const safeRows = Array.isArray(rows) ? rows : [];
  const active = safeRows.filter(r => r.registration_status !== 'cancelled');
  const confirmed = active.filter(r => r.payment_status === 'confirmed');
  const pending = active.filter(r => r.payment_status === 'awaiting_verification');
  const revenue = confirmed.reduce((sum, r) => sum + Number(r.fee || 0), 0);

  // Canonical Open Play totals live independently of the rendered DOM.
  // The owner portal's central KPI function combines these with confirmed
  // court-rental transactions so every panel uses one calculation.
  latestOpenPlayMetrics = {
    registrations: active.length,
    confirmedCount: confirmed.length,
    pendingCount: pending.length,
    revenue
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

  const note = document.getElementById('opEarnNote');
  if (note) note.textContent = demo
    ? `${venueName}: sample Open Play transactions for demo purposes only. No real payments or receipts are represented.`
    : `${venueName}: confirmed Open Play payments only. Pending receipts are excluded until verified.`;

  if (typeof window.updateOverviewGrossStats === 'function') {
    window.updateOverviewGrossStats();
  }
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


function renderUnifiedRows(rows, demo = false) {
  const tbody = document.getElementById('unifiedReservationRows');
  if (!tbody) return false;
  tbody.querySelector('#unifiedOpenPlayLoading')?.remove();
  tbody.querySelectorAll('[data-openplay-row="true"]').forEach(node => node.remove());
  const html = (rows || []).map(row => {
    const status = row.payment_status === 'confirmed' ? 'Confirmed' : row.payment_status === 'rejected' ? 'Rejected' : 'Awaiting verification';
    const pill = row.payment_status === 'confirmed' ? 'confirmed' : row.payment_status === 'rejected' ? 'rejected' : 'pending';
    const fee = Number(row.fee || 0);
    return `<tr data-openplay-row="true" data-reservation-status="${esc(status)}">
      <td><span class="pill" style="background:#f3ecdc;color:#8a672b">Open Play</span></td>
      <td><strong>${esc(row.registration_reference || row.id)}</strong><br>${esc(row.player_name)}<br><span class="muted">${esc(row.player_email || '')}</span></td>
      <td>${esc(row.event_date || '')}<br>${esc(row.event_time || '')}</td>
      <td>${esc(row.event_title || 'Open Play session')}</td>
      <td>${fmtMoney(fee)}</td><td>${fmtMoney(0)}</td><td><strong>${fmtMoney(row.payment_status === 'confirmed' ? fee : 0)}</strong></td>
      <td><span class="pill ${pill}">${status}</span>${row.receipt_path && !demo ? '<br><span class="muted small">Receipt uploaded</span>' : demo ? '<br><span class="muted small">Demo receipt</span>' : ''}</td>
      <td><div class="actions">${row.payment_status === 'awaiting_verification' ? `<button class="btn primary sm" data-op-review="confirmed" data-op-id="${esc(row.id)}">${demo ? 'Mark paid (demo)' : 'Confirm paid'}</button><button class="btn danger sm" data-op-review="rejected" data-op-id="${esc(row.id)}">Reject</button>` : ''}</div></td>
    </tr>`;
  }).join('');
  tbody.insertAdjacentHTML('beforeend', html || '<tr data-openplay-row="true"><td colspan="9" class="muted small">No Open Play reservations.</td></tr>');
  tbody.querySelectorAll('[data-op-review]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    const decision = button.dataset.opReview, id = button.dataset.opId;
    try {
      if (demo) {
        saveDemoRows(demoRows().map(row => row.id === id ? { ...row, payment_status: decision, registration_status: decision === 'confirmed' ? 'confirmed' : 'reserved' } : row));
      } else {
        const { error } = await supabase.rpc('review_open_play_payment', { p_registration_id:id, p_decision:decision });
        if (error) throw error;
      }
      await renderTransactions();
    } catch (error) { alert(error.message || 'Unable to update Open Play payment.'); button.disabled = false; }
  }));
  return true;
}

async function renderTransactions() {
  const unifiedMode = !!document.getElementById('unifiedReservationRows');
  const hasTransactionPanel = !!document.getElementById('opRecentTransactions');
  // Do not inject the transaction panel into unrelated views (calendar, venue, etc.).
  // Overview and Earnings render the panel explicitly; Reservations renders unified rows.
  if (!unifiedMode && !hasTransactionPanel) return;
  const host = unifiedMode ? null : ensureTransactionPanel();
  const body = unifiedMode ? null : (host.querySelector('#opTxnBody') || host.querySelector('div:last-child'));
  if (body) body.textContent = 'Loading Open Play transactions…';
  const venue = venueContext();
  try {
    const { data: authData, error: authError } = DEMO_VENUE_SLUGS.has(DEMO_REQUEST)
      ? { data: { user: null }, error: null }
      : await supabase.auth.getUser();
    // Demo portal access is strictly local. It never queries or exposes Supabase registrations.
    if (DEMO_VENUE_SLUGS.has(DEMO_REQUEST) || authError || !authData?.user) {
      if (!DEMO_VENUE_SLUGS.has(venue.slug)) {
        if (unifiedMode) { const loading=document.getElementById('unifiedOpenPlayLoading'); if(loading) loading.innerHTML='<td colspan="9" class="muted small">Owner session missing. Please sign in again to load Open Play reservations.</td>'; return; }
        body.innerHTML = '<div class="notice" style="color:#b42318">Your owner session is missing. Please log in again. Demo transactions are available only inside the four Courtly demo venues.</div>';
        const note = document.getElementById('opEarnNote');
        if (note) note.textContent = 'Sign in with your owner account to view real Open Play transactions.';
        updateMetrics([], venue.name, false);
        return;
      }
      const rows = demoRows();
      if (unifiedMode) { renderUnifiedRows(rows, true); updateMetrics(rows, venue.name, true); return; }
      body.innerHTML = '<div class="notice gold" style="margin:8px 0">DEMO MODE · Sample records only. Changes are saved in this browser and do not represent real payments.</div>' + transactionMarkup(rows, true);
      updateMetrics(rows, venue.name, true);
      bindReview(rows, true);
      return;
    }
    const user = authData.user;
    const { data: ownedVenues, error: venueError } = await supabase.from('venues').select('slug,name').eq('owner_id', user.id).order('created_at', { ascending: true });
    if (venueError) throw venueError;
    const ownedVenue = (ownedVenues || [])[0];
    if (!ownedVenue?.slug) throw new Error('Your account is not linked to a venue. Please contact Courtly support.');
    syncPortalSlug(ownedVenue);
    // Owner-wide list (covers every venue this owner has). Fall back to the older per-slug
    // function only if the newer one has not been deployed yet.
    let { data: rows, error } = await supabase.rpc('get_owner_open_play_transactions');
    if (error && /could not find the function|schema cache|does not exist/i.test(error.message || '')) {
      ({ data: rows, error } = await supabase.rpc('get_owner_open_play_transactions', { p_venue_slug: ownedVenue.slug }));
    }
    if (error) throw error;
    const safeRows = rows || [];
    if (unifiedMode) { renderUnifiedRows(safeRows, false); updateMetrics(safeRows, ownedVenue.name, false); return; }
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
    if (unifiedMode) { const loading=document.getElementById('unifiedOpenPlayLoading'); if(loading) loading.innerHTML=`<td colspan="9" class="muted small">${esc(error.message || 'Could not load Open Play reservations.')}</td>`; console.warn('Open Play reservations could not be refreshed:', error); return; }
    body.innerHTML = `<div class="notice" style="color:#b42318">${esc(error.message || 'Could not load Open Play transactions.')}</div>`;
    const note = document.getElementById('opEarnNote');
    if (note) note.textContent = error.message || 'Could not load Open Play earnings.';
    console.warn('Open Play transactions could not be refreshed:', error);
  }
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
    localStorage.setItem(PORTAL_KEY, JSON.stringify(stored));
    if (typeof db !== 'undefined' && db && db.venue) {
      db.venue.slug = slug;
      db.venue.slugLocked = true;
      if (typeof render === 'function') render();
    }
  } catch (error) { console.warn('Could not sync the public booking slug:', error); }
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

// Refresh as soon as the owner returns to the tab, instead of waiting for the 30-second timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refreshOpenPlayRegistrationCounts(); renderTransactions(); }
});
