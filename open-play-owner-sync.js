import { supabase } from './supabase-client.js';

// Refresh only aggregate counts; player contact details remain private in the database.
async function refreshOpenPlayRegistrationCounts() {
  const nodes = [...document.querySelectorAll('[data-op-count]')];
  if (!nodes.length) return;
  const ids = nodes.map(node => node.getAttribute('data-op-count')).filter(Boolean);
  if (!ids.length) return;
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
window.refreshOpenPlayRegistrationCounts = refreshOpenPlayRegistrationCounts;
// The owner portal is a single-page view; poll while it is open so registrations appear promptly.
refreshOpenPlayRegistrationCounts();
setInterval(refreshOpenPlayRegistrationCounts, 30000);
