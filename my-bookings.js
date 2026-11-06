import { supabase, supabaseConfigError } from './supabase-client.js';
import { BOOKING_TOKEN_KEY, bookingStatus, browserStorage, readBookingTokens, requestSequence } from './booking-utils.mjs';

const list = document.getElementById('bookings');
const refreshButton = document.getElementById('refresh');
const forgetButton = document.getElementById('forget');
const requests = requestSequence();
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tokenStores = () => [browserStorage('localStorage'), browserStorage('sessionStorage')];

function render(rows) {
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><h2>No saved bookings in this browser</h2><p>Sign in to see bookings linked to your player account, or use the browser where you made the reservation.</p>'
      + '<a href="/player-dashboard.html?view=bookings">View account bookings</a><a href="/players.html" style="margin-left:8px">Find a court</a></div>';
    return;
  }
  list.innerHTML = rows.map((booking) => {
    const zone = booking.venue_timezone || booking.timezone || 'Asia/Manila';
    const start = new Date(booking.starts_at);
    const end = new Date(booking.ends_at);
    const date = new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: zone }).format(start);
    const timeOptions = { hour: 'numeric', minute: '2-digit', timeZone: zone };
    const time = new Intl.DateTimeFormat('en-PH', timeOptions).format(start) + ' – ' + new Intl.DateTimeFormat('en-PH', timeOptions).format(end);
    const status = bookingStatus(booking);
    return '<article class="booking"><div><h3>' + escapeHtml(booking.venue_name || 'Courtly venue') + '</h3>'
      + '<div class="meta">' + escapeHtml(booking.court_name || 'Court') + '<br>' + escapeHtml(date) + ' · ' + escapeHtml(time)
      + ' · ' + Number(booking.duration_hours) + ' hour(s)<br>' + escapeHtml(booking.payment_method || 'GCash') + '</div>'
      + '<div class="ref">Reference: ' + escapeHtml(booking.reference) + '</div></div><div class="right"><strong class="amount">' + money(booking.total) + '</strong>'
      + '<span class="status ' + status.state + '">' + escapeHtml(status.label) + '</span>'
      + '<a href="/booking-confirmation.html?ref=' + encodeURIComponent(booking.reference) + '" class="booking-details-link">View details</a></div></article>';
  }).join('');
}
function finishLoading() {
  if (refreshButton) { refreshButton.disabled = false; refreshButton.textContent = 'Refresh'; }
  list.setAttribute('aria-busy', 'false');
}
async function loadBookings() {
  const request = requests.next();
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Refreshing…'; }
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<div class="empty" role="status">Loading your saved booking records…</div>';
  try {
    if (!supabase) throw new Error(supabaseConfigError);
    const tokens = readBookingTokens(...tokenStores());
    if (!tokens.length) { if (requests.isCurrent(request)) render([]); return; }
    const { data, error } = await supabase.rpc('get_public_bookings_for_tokens', { p_access_tokens: tokens });
    if (!requests.isCurrent(request)) return;
    if (error) throw error;
    render(data || []);
  } catch (error) {
    if (!requests.isCurrent(request)) return;
    console.error('Unable to load Courtly bookings:', error);
    list.innerHTML = '<div class="empty"><h2>Could not load bookings</h2><p>' + escapeHtml(error.message || 'Please refresh and try again.')
      + '</p><a href="/player-dashboard.html?view=bookings">View account bookings</a></div>';
  } finally {
    if (requests.isCurrent(request)) finishLoading();
  }
}
refreshButton?.addEventListener('click', loadBookings);
forgetButton?.addEventListener('click', () => {
  if (!confirm('Remove the private booking access keys saved in this browser? Bookings linked to your signed-in player account remain available in your account.')) return;
  // An outstanding refresh must not put private records back after removal.
  requests.next();
  for (const storage of tokenStores()) {
    try { storage?.removeItem(BOOKING_TOKEN_KEY); } catch { /* Verify below whether any saved keys remain. */ }
  }
  finishLoading();
  if (readBookingTokens(...tokenStores()).length) {
    list.innerHTML = '<div class="empty" role="alert"><h2>Saved access could not be cleared</h2><p>Your browser blocked the change. Clear this site’s browsing data to remove saved booking access.</p></div>';
    return;
  }
  render([]);
});
loadBookings();
