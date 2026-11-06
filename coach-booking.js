import { supabase, supabaseConfigError } from './supabase-client.js';
import { CONVENIENCE_FEE_LABEL, requestSequence, submissionGuard, validateReceipt } from './booking-utils.mjs';
import { dispatchBookingNotifications } from './notification-client.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const slug = new URLSearchParams(location.search).get('coach');
const slotRequests = requestSequence();
const reservationSubmission = submissionGuard();
const paymentSubmission = submissionGuard();
const receiptTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
let coach = null;
let selected = null;
let selectionKey = '';
let booking = null;
let paymentSubmitted = false;
let expiryTimer = null;

function todayManila(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}
function showMessage(message = '', success = false) {
  const node = $('bookingMessage');
  node.textContent = message;
  node.className = 'coach-msg' + (success ? ' success' : '');
  node.setAttribute('role', success ? 'status' : 'alert');
}
function formSelection() {
  const date = $('bookingDate').value;
  const duration = Number($('duration').value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayManila()) throw new Error('Choose today or a future date.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 8) throw new Error('Choose between 1 and 8 hours.');
  return { date, duration, key: date + ':' + duration };
}
function summaryRow(label, value) {
  return '<div class="coach-summary-row"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
}
function renderSummary() {
  if (!coach) return;
  const duration = booking ? Number(booking.duration_hours) : Number($('duration').value || 1);
  const rate = Number(booking?.hourly_rate ?? coach.hourly_rate);
  const total = Number(booking?.player_total ?? rate * duration);
  const start = booking?.starts_at || selected?.slot_start;
  let html = summaryRow('Coach', coach.coach_name);
  if (start) {
    html += summaryRow('Date & time', new Date(start).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }));
  }
  html += summaryRow('Rate', money(rate) + '/hour')
    + summaryRow('Duration', duration + ' hour' + (duration === 1 ? '' : 's'))
    + summaryRow('Coaching session', money(total))
    + '<div class="coach-summary-row total"><span>Total payable</span><strong>' + money(total) + '</strong></div>'
    + '<p class="coach-note" style="margin:12px 0 0"><strong>' + CONVENIENCE_FEE_LABEL + ': ₱50</strong> — paid by the coach per successful booking. It is not added to your total.</p>';
  $('summary').innerHTML = html;
}
function setSelectionLocked(locked) {
  $('bookingDate').disabled = locked;
  $('duration').disabled = locked;
  $('slotList').querySelectorAll('[data-slot]').forEach((button) => { button.disabled = locked; });
}
async function ensurePlayer() {
  if (!supabase) throw new Error(supabaseConfigError || 'Courtly could not connect. Please try again.');
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError && authError.name !== 'AuthSessionMissingError') throw authError;
  const returnTo = encodeURIComponent(location.pathname + location.search);
  if (!user) {
    location.assign('/player-login.html?returnTo=' + returnTo);
    return null;
  }
  const { data: profile, error } = await supabase.from('player_profiles').select('id').eq('id', user.id).maybeSingle();
  if (error) throw error;
  if (!profile) {
    $('bookingMessage').className = 'coach-msg';
    $('bookingMessage').innerHTML = 'Coaching bookings require a player account. <a href="/player-login.html?switchAccount=1&returnTo=' + returnTo + '">Switch to a player account</a> to continue.';
    return null;
  }
  return user;
}
async function loadSlots({ keepMessage = false } = {}) {
  if (!coach || booking) return;
  const request = slotRequests.next();
  selected = null;
  selectionKey = '';
  $('reserveSlot').disabled = true;
  $('slotList').setAttribute('aria-busy', 'true');
  $('slotList').innerHTML = '<p class="coach-note" role="status">Checking available times…</p>';
  if (!keepMessage) showMessage();
  renderSummary();
  try {
    const selection = formSelection();
    const { data, error } = await supabase.rpc('get_coach_available_slots', {
      p_coach_id: coach.coach_id, p_date: selection.date, p_duration_hours: selection.duration
    });
    if (!slotRequests.isCurrent(request) || booking) return;
    if (error) throw error;
    if (formSelection().key !== selection.key) return;
    const slots = data || [];
    if (!slots.length) {
      $('slotList').innerHTML = '<div class="coach-empty" style="grid-column:1/-1">No available times for this date and duration. Try another day or a shorter session.</div>';
      return;
    }
    $('slotList').innerHTML = slots.map((slot, index) => '<button type="button" class="coach-slot" data-slot="' + index + '" aria-pressed="false">'
      + esc(new Date(slot.slot_start).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })) + '</button>').join('');
    $('slotList').querySelectorAll('[data-slot]').forEach((button, index) => {
      button.addEventListener('click', () => {
        if (booking || reservationSubmission.busy || !slotRequests.isCurrent(request)) return;
        selected = slots[index];
        selectionKey = selection.key;
        $('slotList').querySelectorAll('[data-slot]').forEach((item) => {
          item.classList.toggle('selected', item === button);
          item.setAttribute('aria-pressed', String(item === button));
        });
        $('reserveSlot').disabled = false;
        renderSummary();
      });
    });
  } catch (error) {
    if (!slotRequests.isCurrent(request)) return;
    $('slotList').innerHTML = '<div class="coach-empty" style="grid-column:1/-1">Availability could not be loaded.<br><button type="button" class="coach-btn outline" id="retryCoachSlots" style="margin-top:12px">Try again</button></div>';
    $('retryCoachSlots')?.addEventListener('click', () => { loadSlots(); });
    showMessage(error.message || 'Availability could not be loaded. Please try again.');
  } finally {
    if (slotRequests.isCurrent(request)) $('slotList').setAttribute('aria-busy', 'false');
  }
}
function holdExpired() {
  return booking?.expires_at && Date.parse(booking.expires_at) <= Date.now();
}
function refreshHoldStatus() {
  if (!booking || paymentSubmitted || paymentSubmission.busy) return;
  if (!holdExpired()) return;
  $('submitPayment').disabled = true;
  showMessage('This reservation hold has expired. If you have already paid, contact the coach with reference ' + booking.booking_reference + ' before making another payment.');
  if (!$('chooseAnotherTime')) {
    const button = document.createElement('button');
    button.id = 'chooseAnotherTime';
    button.type = 'button';
    button.className = 'coach-btn outline';
    button.textContent = 'Choose another time';
    button.style.marginTop = '12px';
    button.addEventListener('click', () => {
      if (paymentSubmission.busy || !holdExpired()) return;
      clearInterval(expiryTimer);
      booking = null;
      selected = null;
      paymentSubmitted = false;
      $('paymentPanel').style.display = 'none';
      button.remove();
      $('reserveSlot').style.display = '';
      $('reserveSlot').textContent = 'Continue to payment';
      $('paymentForm').reset();
      setSelectionLocked(false);
      loadSlots();
    });
    $('paymentPanel').appendChild(button);
  }
}
async function createBooking() {
  if (booking || !reservationSubmission.start()) return;
  const button = $('reserveSlot');
  button.disabled = true;
  button.textContent = 'Reserving your selected time…';
  setSelectionLocked(true);
  try {
    const selection = formSelection();
    if (!selected || selectionKey !== selection.key) throw new Error('Choose an available time first.');
    const slot = { ...selected };
    const user = await ensurePlayer();
    if (!user) return;
    const { data, error } = await supabase.rpc('create_coaching_booking', {
      p_coach_id: coach.coach_id, p_starts_at: slot.slot_start, p_duration_hours: selection.duration
    });
    if (error) throw error;
    if (!data?.booking_id || !data?.booking_reference || !Number.isFinite(Number(data.player_total))) {
      throw new Error('The booking response was incomplete. Check your account bookings before trying again.');
    }
    booking = { ...data, starts_at: slot.slot_start, ends_at: slot.slot_end };
    const qr = booking.payment_qr_path ? supabase.storage.from('courtly-coach-media').getPublicUrl(booking.payment_qr_path).data.publicUrl : '';
    $('paymentInstructions').innerHTML = '<div class="coach-summary">'
      + summaryRow('Booking reference', booking.booking_reference)
      + summaryRow('Amount to pay', money(booking.player_total))
      + '<p class="coach-note">Pay the coach using the account below. Include the booking reference when your payment app allows it.</p>'
      + '<div style="margin-top:12px"><strong>' + esc(booking.payment_provider || 'Payment account') + '</strong>'
      + '<p class="coach-note">' + esc(booking.payment_account_name || '') + '</p><strong>' + esc(booking.payment_account_number || '') + '</strong>'
      + (qr ? '<img class="coach-upload-preview" style="max-width:220px;display:block;margin:12px auto" src="' + esc(qr) + '" alt="Coach payment QR">' : '')
      + '<p class="coach-note">' + esc(booking.payment_instructions || '') + '</p></div></div>';
    $('submitPayment').disabled = false;
    $('submitPayment').textContent = 'Submit payment details';
    $('paymentPanel').style.display = 'block';
    button.style.display = 'none';
    renderSummary();
    const expires = booking.expires_at
      ? new Date(booking.expires_at).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }) + ' (Philippines time)'
      : '20 minutes from now';
    showMessage('This time is held until ' + expires + '. Submit your payment reference before the hold expires. Your date and duration are now reserved.', true);
    clearInterval(expiryTimer);
    expiryTimer = setInterval(refreshHoldStatus, 15000);
    $('paymentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('paymentReference').focus({ preventScroll: true });
  } catch (error) {
    if (!booking) await loadSlots({ keepMessage: true });
    showMessage(error.message || 'This time could not be reserved. Please choose another time.');
  } finally {
    reservationSubmission.finish();
    setSelectionLocked(Boolean(booking));
    if (!booking) {
      button.disabled = !selected;
      button.textContent = 'Continue to payment';
    }
  }
}
async function submitPayment(event) {
  event.preventDefault();
  if (!paymentSubmission.start()) return;
  const button = $('submitPayment');
  const form = $('paymentForm');
  try {
    if (!booking) throw new Error('Reserve an available time before submitting payment.');
    if (paymentSubmitted) return;
    if (holdExpired()) throw new Error('This reservation hold has expired. Contact the coach if you have already paid.');
    const reference = $('paymentReference').value.trim();
    $('paymentReference').setCustomValidity(reference ? '' : 'Enter your payment reference number.');
    if (!form.reportValidity()) return;
    const file = $('receipt').files?.[0];
    if (file) validateReceipt(file, 10, receiptTypes);
    const note = $('playerNote').value.trim();
    button.disabled = true;
    button.textContent = 'Submitting…';
    form.setAttribute('aria-busy', 'true');
    const activeBooking = booking;
    const user = await ensurePlayer();
    if (!user) return;
    let receiptPath = null;
    if (file) {
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[file.type];
      receiptPath = user.id + '/' + activeBooking.booking_id + '/' + Date.now() + '-' + crypto.randomUUID() + '.' + extension;
      const { error } = await supabase.storage.from('courtly-coach-payment-receipts').upload(receiptPath, file, { contentType: file.type, upsert: false });
      if (error) throw error;
    }
    const { data, error } = await supabase.rpc('submit_coaching_booking_payment', {
      p_booking_id: activeBooking.booking_id, p_payment_reference: reference, p_receipt_path: receiptPath, p_player_note: note || null
    });
    if (error) throw error;
    if (data?.success !== true || !data?.booking_reference) throw new Error('Payment submission could not be confirmed. Check your account bookings before submitting again.');
    paymentSubmitted = true;
    void dispatchBookingNotifications(supabase, { type: 'coaching_booking', id: activeBooking.booking_id }).catch(() => {});
    clearInterval(expiryTimer);
    showMessage('Your payment details have been received. The coach will confirm the session after verification.', true);
    $('paymentPanel').innerHTML = '<div style="text-align:center;padding:20px"><h2 style="font:700 20px Poppins;color:#001a47">Payment details submitted</h2>'
      + '<p class="coach-note">The coach will verify your payment. Your session is confirmed once approved.</p><span class="coach-pill pending">Awaiting verification</span>'
      + '<p><strong>' + esc(data.booking_reference) + '</strong></p><a class="coach-btn lime" href="/player-dashboard.html?view=bookings">View my bookings</a></div>';
  } catch (error) {
    showMessage(error.message || 'Could not submit payment details. Please try again.');
  } finally {
    paymentSubmission.finish();
    form.setAttribute('aria-busy', 'false');
    if (!paymentSubmitted) {
      button.disabled = Boolean(holdExpired());
      button.textContent = 'Submit payment details';
      refreshHoldStatus();
    }
  }
}

$('reserveSlot').addEventListener('click', createBooking);
$('duration').addEventListener('change', () => { loadSlots(); });
$('bookingDate').addEventListener('change', () => { loadSlots(); });
$('paymentForm').addEventListener('submit', submitPayment);
$('paymentReference').addEventListener('input', () => { $('paymentReference').setCustomValidity(''); });

async function init() {
  setSelectionLocked(true);
  if (!supabase) throw new Error(supabaseConfigError || 'Courtly could not connect. Please try again.');
  if (!slug) throw new Error('Choose a coach from the coach directory before booking.');
  const { data, error } = await supabase.rpc('get_public_coach_profile', { p_slug: slug });
  if (error) throw error;
  coach = data?.[0];
  if (!coach || !Number.isFinite(Number(coach.hourly_rate)) || Number(coach.hourly_rate) <= 0) throw new Error('This coach is not currently accepting bookings.');
  document.title = 'Book ' + coach.coach_name + ' | Courtly';
  $('backCoach').href = '/coach.html?slug=' + encodeURIComponent(slug);
  $('coachBookingIdentity').innerHTML = '<div style="font:700 17px Poppins;color:#001a47">' + esc(coach.coach_name) + (coach.is_verified ? ' · Verified' : '') + '</div>'
    + '<div class="coach-note">' + esc(coach.sport) + ' · ' + esc(coach.city) + ' · ' + money(coach.hourly_rate) + '/hour</div>';
  $('bookingDate').min = todayManila();
  $('bookingDate').value = todayManila(new Date(Date.now() + 86400000));
  setSelectionLocked(false);
  await loadSlots();
}
init().catch((error) => {
  showMessage(error.message || 'This coaching booking page could not load.');
  $('coachBookingIdentity').textContent = 'Coach booking unavailable';
  $('slotList').innerHTML = '<a class="coach-btn outline" href="/coaches.html">Browse available coaches</a>';
});
