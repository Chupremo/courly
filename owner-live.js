// Recover missed events after reconnect/resume without overlapping workspace loads.
export function watchOwnerWorkspace({ client, userId, venueId, load, onUpdate, document, window, timers = globalThis }) {
  let stopped = false, running = false, pending = null, last = '', connected = false;
  const refresh = async (kind = 'sync', payload) => {
    pending = { kind, payload };
    if (stopped || running || document.visibilityState === 'hidden') return;
    running = true;
    try {
      while (pending && !stopped && document.visibilityState !== 'hidden') {
        const event = pending; pending = null;
        const workspace = await load();
        if (stopped) break;
        const signature = JSON.stringify(workspace);
        if (signature !== last) { last = signature; onUpdate({ ...event, workspace }); }
      }
    } catch (error) {
      console.warn('Courtly live updates will retry:', error.message);
    } finally { running = false; }
  };
  const channel = client.channel('courtly-owner-live-' + venueId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_notifications', filter: `recipient_user_id=eq.${userId}` }, payload => void refresh('notification', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings', filter: `venue_id=eq.${venueId}` }, payload => void refresh('booking', payload))
    .subscribe(status => {
      connected = status === 'SUBSCRIBED';
      if (connected) void refresh('reconnected');
    });
  const resume = () => { if (document.visibilityState !== 'hidden') void refresh('resume'); };
  const message = event => { if (event.data?.type === 'courtly-notification') void refresh('notification'); };
  let ticks = 0;
  const interval = timers.setInterval(() => {
    ticks += 1;
    // Healthy sockets get a periodic reconciliation too, covering brief gaps.
    if (!connected || ticks % 4 === 0) void refresh('sync');
  }, 15000);
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  window.navigator?.serviceWorker?.addEventListener('message', message);
  void refresh('initial');
  return () => {
    stopped = true; pending = null;
    timers.clearInterval(interval);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume);
    window.navigator?.serviceWorker?.removeEventListener('message', message);
    void client.removeChannel(channel);
  };
}
