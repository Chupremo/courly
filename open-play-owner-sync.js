import { supabase } from './supabase-client.js';

// Refresh public event registration counts and authenticated owner's earnings.
async function refreshOpenPlayRegistrationCounts() {
  const nodes = [...document.querySelectorAll('[data-op-count]')];
  if (nodes.length) {
    const ids = nodes.map(node => node.getAttribute('data-op-count')).filter(Boolean);
    try {
      const { data, error } = await supabase.rpc('get_open_play_registration_counts', { p_event_ids: ids });
      if (error) throw error;
      const counts = new Map((data || []).map(row => [String(row.event_id), Number(row.registered_count || 0)]));
      const stored = JSON.parse(localStorage.getItem('courtlyOwnerPortalV1') || '{}');
      const events = stored.openPlays || [];
      nodes.forEach(node => {
        const id = node.getAttribute('data-op-count');
        const event = events.find(item => String(item.id) === id);
        if (!event) return;
        const count = counts.get(id) || 0;
        const limit = Number(event.limit || 20);
        event.registeredCount = count;
        node.textContent = `${count} / ${limit}`;
        const spots = document.querySelector(`[data-op-spots="${CSS.escape(id)}"]`);
        if (spots) spots.textContent = `${Math.max(0, limit - count)} spots available`;
      });
      stored.openPlays = events;
      localStorage.setItem('courtlyOwnerPortalV1', JSON.stringify(stored));
    } catch (error) {
      console.warn('Open Play registration counts could not be refreshed:', error.message || error);
    }
  }

  const revenue = document.getElementById('opEarnRevenue');
  if (!revenue) return;
  const note = document.getElementById('opEarnNote');
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    const user = authData?.user;
    if (!user) throw new Error('You are not signed in with Supabase Auth. Please log out and sign in again.');

    // Resolve the venue from the authenticated owner ID; do not trust a browser-stored slug.
    const { data: venue, error: venueError } = await supabase
      .from('venues')
      .select('slug,name')
      .eq('owner_id', user.id)
      .maybeSingle();
    if (venueError) throw venueError;
    if (!venue?.slug) throw new Error('No venue is linked to this owner account. Run supabase/owner-registration.sql or link the existing venue to this Auth user.');

    const { data, error } = await supabase.rpc('get_owner_open_play_earnings', { p_venue_slug: venue.slug });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const fmt = value => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('opEarnRegistrations').textContent = Number(row?.registration_count || 0).toLocaleString('en-PH');
    document.getElementById('opEarnPaidCount').textContent = Number(row?.paid_count || 0).toLocaleString('en-PH');
    document.getElementById('opEarnPendingCount').textContent = Number(row?.awaiting_count || 0).toLocaleString('en-PH');
    revenue.textContent = fmt(row?.confirmed_revenue);
    if (note) note.textContent = `${venue.name}: confirmed Open Play payments only. Pending receipts are excluded until verified.`;
  } catch (error) {
    if (note) note.textContent = error.message || 'Could not load Open Play earnings. Check Supabase Auth, venue ownership, and the earnings SQL migration.';
    console.warn('Open Play earnings could not be refreshed:', error.message || error);
  }
}
window.refreshOpenPlayRegistrationCounts = refreshOpenPlayRegistrationCounts;
refreshOpenPlayRegistrationCounts();
loadOpenPlayTransactions();
setInterval(() => { refreshOpenPlayRegistrationCounts(); loadOpenPlayTransactions(); }, 30000);

async function loadOpenPlayTransactions() {
  const revenue = document.getElementById('opEarnRevenue');
  const note = document.getElementById('opEarnNote');
  let host = document.getElementById('opRecentTransactions');
  if (!host) {
    host = document.createElement('section');
    host.id = 'opRecentTransactions';
    host.className = 'panel';
    host.style.marginTop = '16px';
    host.innerHTML = '<div class="panelhead"><h3>Recent Open Play transactions</h3><span class="pill">Payment review</span></div><div id="opTxnBody" class="muted small">Loading registrations…</div>';
    const overviewPanel = [...document.querySelectorAll('.panel')].find(panel => panel.querySelector('.panelhead h3')?.textContent?.trim() === 'Recent reservations');
    const earningsPanel = revenue?.closest('.panel');
    (overviewPanel || earningsPanel || document.querySelector('main') || document.body)?.insertAdjacentElement('afterend', host);
  }
  if (!host.isConnected) {
    const overviewPanel = [...document.querySelectorAll('.panel')].find(panel => panel.querySelector('.panelhead h3')?.textContent?.trim() === 'Recent reservations');
    const earningsPanel = revenue?.closest('.panel');
    (overviewPanel || earningsPanel || document.querySelector('main') || document.body)?.insertAdjacentElement('afterend', host);
  }
  const body = document.getElementById('opTxnBody');
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    if (!authData?.user) throw new Error('Please sign in again using your owner account.');
    const { data: venue, error: venueError } = await supabase.from('venues').select('slug').eq('owner_id', authData.user.id).maybeSingle();
    if (venueError) throw venueError;
    if (!venue?.slug) throw new Error('No venue is linked to this owner account.');
    const { data: rows, error } = await supabase.rpc('get_owner_open_play_transactions', { p_venue_slug: venue.slug });
    if (error) throw error;
    if (!rows?.length) { body.textContent = 'No Open Play registrations have been submitted yet.'; return; }
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = n => '₱' + Number(n || 0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
    const rendered = await Promise.all(rows.map(async row => {
      let receipt = '';
      if (row.receipt_path) {
        const { data: signed } = await supabase.storage.from('courtly-payment-receipts').createSignedUrl(row.receipt_path, 600);
        if (signed?.signedUrl) receipt = `<a href="${esc(signed.signedUrl)}" target="_blank" rel="noopener">View receipt</a>`;
      }
      const pending = row.payment_status === 'awaiting_verification';
      const status = row.payment_status === 'confirmed' ? 'Confirmed' : row.payment_status === 'rejected' ? 'Rejected' : 'Awaiting verification';
      return `<article style="border:1px solid #e5e9f1;border-radius:12px;padding:14px;margin:10px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center">
       <div><strong>${esc(row.player_name)}</strong> <span class="muted small">· ${esc(row.registration_reference)}</span>
       <div class="muted small">${esc(row.event_title)} · ${esc(row.event_date)} · ${esc(row.event_time)}</div>
       <div class="muted small">${esc(row.player_email)}${row.player_phone?' · '+esc(row.player_phone):''}</div>
       <div style="margin-top:6px">${money(row.fee)} · <strong>${status}</strong> · ${receipt||'Receipt unavailable'}</div></div>
       <div style="display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end">${pending?`<button class="btn" data-op-review="confirmed" data-op-id="${esc(row.id)}">Verify payment</button><button class="btn" data-op-review="rejected" data-op-id="${esc(row.id)}" style="background:#fff;color:#b42318;border:1px solid #f0c8c8">Reject</button>`:''}</div>
      </article>`;
    }));
    body.innerHTML = rendered.join('');
    host.querySelectorAll('[data-op-review]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      const decision = button.dataset.opReview, id = button.dataset.opId;
      try {
        const { error: reviewError } = await supabase.rpc('review_open_play_payment', { p_registration_id:id, p_decision:decision });
        if (reviewError) throw reviewError;
        await refreshOpenPlayRegistrationCounts();
        await loadOpenPlayTransactions();
      } catch (err) {
        alert(err.message || 'Unable to update payment status.');
        button.disabled = false;
      }
    }));
  } catch (err) {
    body.textContent = err.message || 'Could not load Open Play transactions.';
    if (note) note.textContent = err.message || note.textContent;
  }
}
window.loadOpenPlayTransactions = loadOpenPlayTransactions;

