import { supabase } from './supabase-client.js';

// Refresh aggregate Open Play counts without exposing player personal information.
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

  // Earnings are available only to the authenticated owner of this venue.
  const revenue = document.getElementById('opEarnRevenue');
  if (revenue) {
    const note = document.getElementById('opEarnNote');
    try {
      const stored = JSON.parse(localStorage.getItem('courtlyOwnerPortalV1') || '{}');
      const slug = stored.venue && stored.venue.slug;
      if (!slug) throw new Error('Venue slug is missing from the owner profile.');
      const { data, error } = await supabase.rpc('get_owner_open_play_earnings', { p_venue_slug: slug });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const fmt = value => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById('opEarnRegistrations').textContent = Number(row?.registration_count || 0).toLocaleString('en-PH');
      document.getElementById('opEarnPaidCount').textContent = Number(row?.paid_count || 0).toLocaleString('en-PH');
      document.getElementById('opEarnPendingCount').textContent = Number(row?.awaiting_count || 0).toLocaleString('en-PH');
      revenue.textContent = fmt(row?.confirmed_revenue);
      if (note) note.textContent = 'Revenue includes confirmed Open Play payments only. Pending receipts are excluded until verified.';
    } catch (error) {
      if (note) note.textContent = 'Could not load Open Play earnings. Run supabase/open-play-earnings.sql and make sure the venue owner is signed in.';
      console.warn('Open Play earnings could not be refreshed:', error.message || error);
    }
  }
}

window.refreshOpenPlayRegistrationCounts = refreshOpenPlayRegistrationCounts;
refreshOpenPlayRegistrationCounts();
setInterval(refreshOpenPlayRegistrationCounts, 30000);
