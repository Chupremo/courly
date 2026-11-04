import { supabase, supabaseConfigError } from './supabase-client.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const params = new URLSearchParams(location.search);
const reference = params.get('ref') || '';
const content = document.getElementById('content');
const TOKEN_KEY = 'courtlyBookingAccessTokensV1';

function findTokenForBooking() {
  let tokens = [];
  try { tokens = JSON.parse(localStorage.getItem(TOKEN_KEY) || '[]'); } catch { tokens = []; }
  return Array.isArray(tokens) ? [...new Set(tokens)].reverse() : [];
}
function displayStatus(booking) {
  if (booking.status === 'cancelled') return 'Cancelled';
  if (booking.payment_status === 'confirmed') return 'Confirmed';
  if (booking.payment_status === 'rejected') return 'Payment rejected';
  if (booking.payment_status === 'awaiting_verification') return 'Reserved · Awaiting owner verification';
  return 'Booking request created';
}
function render(booking) {
  const start = new Date(booking.starts_at);
  const end = new Date(booking.ends_at);
  const date = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila'
  }).format(start);
  const time = `${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(start)} – ${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(end)}`;
  const status = displayStatus(booking);
  const isConfirmed = booking.payment_status === 'confirmed';
  const isRejected = booking.payment_status === 'rejected' || booking.status === 'cancelled';
  content.innerHTML = `
    <div class="status">
      <div class="check" style="${isRejected ? 'background:#fff0f0;color:#b42318' : isConfirmed ? '' : 'background:#fff4df;color:#a86408'}">${isRejected ? '!' : isConfirmed ? '✓' : '…'}</div>
      <div class="eyebrow">COURTLY BOOKING</div>
      <h1>${isConfirmed ? 'Your booking is confirmed!' : isRejected ? 'Booking status updated' : 'Payment receipt submitted!'}</h1>
      <p>${isConfirmed ? 'The venue owner has verified your payment. Your court reservation is confirmed.' : isRejected ? 'The venue could not confirm this payment. Please contact the venue before making another payment.' : 'Your selected timeslot is reserved while the venue owner verifies your payment receipt.'}</p>
      <span class="pill">${escapeHtml(status)}</span>
    </div>
    <div class="ref"><small>YOUR BOOKING REFERENCE</small><strong>${escapeHtml(booking.reference)}</strong></div>
    <h2 class="section-title">Booking details</h2>
    <div class="details">
      <div class="row"><span>Venue</span><strong>${escapeHtml(booking.venue_name)}</strong></div>
      <div class="row"><span>Court</span><strong>${escapeHtml(booking.court_name)}</strong></div>
      <div class="row"><span>Date</span><strong>${escapeHtml(date)}</strong></div>
      <div class="row"><span>Time</span><strong>${escapeHtml(time)}</strong></div>
      <div class="row"><span>Duration</span><strong>${Number(booking.duration_hours)} hour(s)</strong></div>
      <div class="row"><span>Player</span><strong>${escapeHtml(booking.player_name)}</strong></div>
      <div class="row"><span>Payment method</span><strong>${escapeHtml(booking.payment_method || 'GCash')}</strong></div>
      <div class="row"><span>Payment status</span><strong>${escapeHtml(status)}</strong></div>
      <div class="row"><span>Total paid to venue</span><strong class="total">${money(booking.total)}</strong></div>
    </div>
    <div class="next"><a class="btn primary" href="/my-bookings.html">View My Bookings</a><a class="btn secondary" href="/players.html">Find more courts</a></div>
    <div class="notice"><strong>What happens next?</strong><br>${isConfirmed ? 'Your payment has been approved. Keep your booking reference for check-in.' : isRejected ? 'Contact the venue to clarify the rejected receipt. Do not send another payment until you have spoken with the venue.' : '1. Your timeslot is held while your receipt is reviewed.<br>2. The venue owner checks the payment receipt.<br>3. Your status changes to Confirmed once approved.'}<br><br>Your booking access is saved in this browser. On a shared device, use “Forget this browser” on the My Bookings page before you leave.</div>`;
}

async function load() {
  if (!supabase) throw new Error(supabaseConfigError);
  if (!reference) throw new Error('The booking reference is missing from this link.');
  const tokens = findTokenForBooking();
  if (!tokens.length) throw new Error('This browser does not have the private access key for this booking. Please return to the device and browser used to submit the reservation.');
  for (const token of tokens) {
    const { data, error } = await supabase.rpc('get_public_booking_by_reference', {
      p_reference: reference,
      p_access_token: token
    });
    if (error) throw error;
    if (data) { render(data); return; }
  }
  throw new Error('We could not find this booking using the saved private access keys. Please check that you are using the same browser where you made the booking.');
}

load().catch((error) => {
  console.error('Could not load Courtly booking:', error);
  content.innerHTML = `<div class="error"><h1>Booking details unavailable</h1><p>${escapeHtml(error.message || 'Please refresh this page or return to My Bookings on the original device.')}</p><a class="btn primary" href="/players.html">Find courts</a></div>`;
});
