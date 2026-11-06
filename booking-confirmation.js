import { supabase, supabaseConfigError } from './supabase-client.js';
import { bookingStatus, browserStorage, readBookingTokens } from './booking-utils.mjs';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const reference = new URLSearchParams(location.search).get('ref') || '';
const content = document.getElementById('content');
const row = (label, value) => '<div class="row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';

function render(booking) {
  const zone = booking.venue_timezone || booking.timezone || 'Asia/Manila';
  const start = new Date(booking.starts_at);
  const end = new Date(booking.ends_at);
  const date = new Intl.DateTimeFormat('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: zone }).format(start);
  const timeOptions = { hour: 'numeric', minute: '2-digit', timeZone: zone };
  const time = new Intl.DateTimeFormat('en-PH', timeOptions).format(start) + ' – ' + new Intl.DateTimeFormat('en-PH', timeOptions).format(end);
  const status = bookingStatus(booking);
  const copy = {
    confirmed: {
      title: 'Your booking is confirmed!',
      description: 'The venue owner has verified your payment. Your court reservation is confirmed.',
      next: 'Keep your booking reference for check-in. You can review the latest booking status at any time.',
      symbol: '✓', colour: '#16834a', background: '#e8f7ee'
    },
    cancelled: {
      title: 'This booking is cancelled',
      description: 'This court reservation is no longer active. Contact the venue about any payment or refund.',
      next: 'If you have already paid, contact the venue with your booking reference before making another payment.',
      symbol: '!', colour: '#b42318', background: '#fff0f0'
    },
    rejected: {
      title: booking.status === 'rejected' ? 'This booking was rejected' : 'Your payment needs attention',
      description: booking.status === 'rejected' ? 'The venue did not accept this reservation. Contact the venue to clarify the booking and payment status.' : 'The venue could not verify the submitted payment receipt.',
      next: 'Contact the venue to clarify the rejected receipt. Do not send another payment until you have spoken with the venue.',
      symbol: '!', colour: '#b42318', background: '#fff0f0'
    },
    expired: {
      title: 'This booking has expired',
      description: 'This reservation hold is no longer active. Check availability before choosing another time.',
      next: 'If you have already paid, contact the venue with this booking reference before making another payment.',
      symbol: '!', colour: '#a86408', background: '#fff4df'
    },
    awaiting: {
      title: 'Payment receipt submitted',
      description: 'Your selected time is reserved while the venue owner verifies your receipt.',
      next: 'The venue will check your payment receipt. Your status will change to Confirmed once it is approved.',
      symbol: '…', colour: '#a86408', background: '#fff4df'
    },
    unpaid: {
      title: 'Booking request created',
      description: 'A payment receipt has not been confirmed as submitted for this request.',
      next: 'Check your account bookings or contact the venue to complete this request. If you have already paid, keep your payment reference and avoid paying again.',
      symbol: '…', colour: '#a86408', background: '#fff4df'
    }
  }[status.state];
  document.title = copy.title + ' | Courtly';
  content.innerHTML = '<div class="status"><div class="check" aria-hidden="true" style="background:' + copy.background + ';color:' + copy.colour + '">' + copy.symbol + '</div>'
    + '<div class="eyebrow">COURTLY BOOKING</div><h1>' + copy.title + '</h1><p>' + copy.description + '</p>'
    + '<span class="pill" style="background:' + copy.background + ';color:' + copy.colour + '">' + escapeHtml(status.label) + '</span></div>'
    + '<div class="ref"><small>YOUR BOOKING REFERENCE</small><strong>' + escapeHtml(booking.reference) + '</strong></div>'
    + '<h2 class="section-title">Booking details</h2><div class="details">'
    + row('Venue', booking.venue_name) + row('Court', booking.court_name) + row('Date', date) + row('Time', time)
    + row('Duration', Number(booking.duration_hours) + ' hour(s)') + row('Player', booking.player_name)
    + row('Payment method', booking.payment_method || 'GCash') + row('Status', status.label)
    + row(status.state === 'confirmed' ? 'Payment verified by venue' : 'Booking total', money(booking.total))
    + '</div><div class="next"><a class="btn primary" href="/player-dashboard.html?view=bookings">View my account bookings</a><a class="btn secondary" href="/players.html">Find more courts</a></div>'
    + '<div class="notice"><strong>What happens next?</strong><br>' + copy.next
    + '<br><br>Your private booking access is saved in this browser. You can remove it with “Forget this browser” on <a href="/my-bookings.html">saved bookings</a>.</div>';
}
async function load() {
  content.setAttribute('aria-busy', 'true');
  try {
    if (!supabase) throw new Error(supabaseConfigError);
    if (!reference) throw new Error('The booking reference is missing from this link.');
    const tokens = readBookingTokens(browserStorage('localStorage'), browserStorage('sessionStorage')).reverse();
    if (!tokens.length) throw new Error('The private access key is not saved in this browser. Sign in to your player account to view your bookings.');
    for (const token of tokens) {
      const { data, error } = await supabase.rpc('get_public_booking_by_reference', { p_reference: reference, p_access_token: token });
      if (error) throw error;
      if (data) { render(data); return; }
    }
    throw new Error('This reference does not match this browser’s saved booking keys. You can also view bookings in your player account.');
  } catch (error) {
    console.error('Could not load Courtly booking:', error);
    content.innerHTML = '<div class="error"><h1>Booking details unavailable</h1><p>' + escapeHtml(error.message || 'Please refresh and try again.')
      + '</p><div class="next"><button class="btn primary" type="button" id="retryBooking">Try again</button><a class="btn secondary" href="/player-dashboard.html?view=bookings">View account bookings</a></div>'
      + '<a class="btn secondary" href="/my-bookings.html" style="margin-top:10px">View saved bookings</a></div>';
    document.getElementById('retryBooking')?.addEventListener('click', () => {
      content.innerHTML = '<div class="error" role="status">Loading your booking details…</div>';
      load();
    });
  } finally {
    content.setAttribute('aria-busy', 'false');
  }
}
load();
