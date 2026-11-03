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
    if (!venue?.slug) throw new Error('No venue is linked to this owner account. Run owner-registration.sql or link the existing venue to this Auth user.');

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
setInterval(refreshOpenPlayRegistrationCounts, 30000);
