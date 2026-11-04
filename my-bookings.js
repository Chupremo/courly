import { supabase, supabaseConfigError } from './supabase-client.js';

const TOKEN_KEY = 'courtlyBookingAccessTokensV1';
const list = document.getElementById('bookings');
const refreshButton = document.getElementById('refresh');
const forgetButton = document.getElementById('forget');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

function readTokens() {
  try {
    const value = JSON.parse(localStorage.getItem(TOKEN_KEY) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(Boolean))] : [];
  } catch { return []; }
}
function statusFor(row) {
  if (row.status === 'cancelled') return { text: 'Cancelled', className: 'cancelled' };
  if (row.payment_status === 'confirmed') return { text: 'Confirmed', className: 'confirmed' };
  if (row.payment_status === 'rejected') return { text: 'Payment rejected', className: 'rejected' };
  if (row.payment_status === 'awaiting_verification') return { text: 'Awaiting owner verification', className: 'pending' };
  return { text: 'Booking request created', className: 'pending' };
}
function render(rows) {
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><h2>No bookings found on this browser</h2><p>Bookings are protected by private access keys saved when you make a reservation. Use the same browser where you submitted your booking.</p><a href="/players.html">Find a court</a></div>`;
    return;
  }
  list.innerHTML = rows.map((row) => {
    const start = new Date(row.starts_at);
    const end = new Date(row.ends_at);
    const date = new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }).format(start);
    const time = `${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(start)} – ${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(end)}`;
    const status = statusFor(row);
    return `<article class="booking">
      <div><h3>${escapeHtml(row.venue_name || 'Courtly venue')}</h3>
      <div class="meta">${escapeHtml(row.court_name || 'Court')}<br>${escapeHtml(date)} · ${escapeHtml(time)} · ${Number(row.duration_hours)} hour(s)<br>${escapeHtml(row.payment_method || 'GCash')}</div>
      <div class="ref">Reference: ${escapeHtml(row.reference)}</div></div>
      <div class="right"><strong class="amount">${money(row.total)}</strong>
      <span class="status ${status.className}">${escapeHtml(status.text)}</span>
      <a href="/booking-confirmation.html?ref=${encodeURIComponent(row.reference)}" style="font-size:11px;color:#1747ad;text-decoration:none">View details →</a></div>
    </article>`;
  }).join('');
}
async function loadBookings() {
  if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Refreshing…'; }
  list.innerHTML = '<div class="empty">Loading your private booking records…</div>';
  try {
    if (!supabase) throw new Error(supabaseConfigError);
    const tokens = readTokens();
    if (!tokens.length) { render([]); return; }
    const { data, error } = await supabase.rpc('get_public_bookings_for_tokens', { p_access_tokens: tokens });
    if (error) throw error;
    render(data || []);
  } catch (error) {
    console.error('Unable to load Courtly bookings:', error);
    list.innerHTML = `<div class="empty"><h2>Could not load bookings</h2><p>${escapeHtml(error.message || 'Please refresh and try again.')}</p></div>`;
  } finally {
    if (refreshButton) { refreshButton.disabled = false; refreshButton.textContent = 'Refresh'; }
  }
}
refreshButton?.addEventListener('click', loadBookings);
forgetButton?.addEventListener('click', () => {
  if (!confirm('Remove saved booking access from this browser? You will no longer be able to view these bookings here.')) return;
  localStorage.removeItem(TOKEN_KEY);
  render([]);
});
loadBookings();
