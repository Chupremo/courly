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
const media=p=>p?(/^https?:/i.test(p)?p:supabase.storage.from('courtly-coach-media').getPublicUrl(p).data.publicUrl):'';
let coach = null;
let coachPrograms = [];
let activeProgramEnrollment = null;
let selected = null;
let selectionKey = '';
let booking = null;
let paymentSubmitted = false;
let expiryTimer = null;
let calendarView = new Date();

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
function dateParts(value) {
  const [year,month,day]=String(value).split('-').map(Number);
  return {year,month,day};
}
function calendarDateString(year, monthIndex, day) {
  return String(year)+'-'+String(monthIndex+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
}
function renderCoachCalendar() {
  const grid=$('coachCalendarDays'),label=$('coachMonthLabel');
  if(!grid||!label)return;
  const year=calendarView.getFullYear(),month=calendarView.getMonth();
  label.textContent=new Date(year,month,1).toLocaleDateString('en-PH',{month:'long',year:'numeric'});
  grid.innerHTML='';
  const first=new Date(year,month,1).getDay();
  const days=new Date(year,month+1,0).getDate();
  const today=todayManila();
  const chosen=$('bookingDate').value;
  for(let i=0;i<first;i++){const blank=document.createElement('span');blank.className='coach-calendar-empty';grid.appendChild(blank);}
  for(let day=1;day<=days;day++){
    const value=calendarDateString(year,month,day);
    const button=document.createElement('button');
    button.type='button';
    button.className='coach-calendar-day'+(value===chosen?' selected':'')+(value===today?' today':'');
    button.textContent=String(day);
    button.disabled=value<today||Boolean(booking);
    button.setAttribute('aria-label',new Date(year,month,day).toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric'}));
    button.setAttribute('aria-pressed',String(value===chosen));
    button.addEventListener('click',async()=>{
      if(booking)return;
      $('bookingDate').value=value;
      selected=null;selectionKey='';
      renderCoachCalendar();
      await loadSlots();
    });
    grid.appendChild(button);
  }
}

function formSelection() {
  const date = $('bookingDate').value;
  const duration = Number($('duration').value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayManila()) throw new Error('Choose today or a future date.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 8) throw new Error('Choose between 1 and 8 hours.');
  return { date, duration, key: date + ':' + duration };
}

function renderCoachBookingHero() {
  const host=$('coachBookingHero');
  if(!host||!coach)return;
  const avatar=media(coach.profile_image_path);
  const cover=media(coach.cover_image_path);
  const location=[coach.city,coach.location_text].filter(Boolean).join(' · ');
  host.innerHTML=
    '<div class="coach-booking-cover">'+(cover?'<img src="'+esc(cover)+'" alt="'+esc(coach.coach_name)+' banner">':'<div class="coach-booking-cover-fallback"></div>')+'</div>'
    +'<div class="coach-booking-profile">'
      +'<div class="coach-booking-avatar-wrap">'+(avatar?'<img class="coach-booking-avatar" src="'+esc(avatar)+'" alt="'+esc(coach.coach_name)+' profile photo">':'<div class="coach-booking-avatar coach-booking-avatar-fallback">'+esc((coach.coach_name||'C').slice(0,1))+'</div>')+'</div>'
      +'<div class="coach-booking-profile-copy">'
        +'<div class="coach-booking-name-row"><h2>'+esc(coach.coach_name)+'</h2>'+(coach.is_verified?'<span class="coach-booking-verified">✓ Verified coach</span>':'')+'</div>'
        +'<div class="coach-booking-meta"><span>'+esc(coach.sport||'Coach')+'</span>'+(location?'<span>'+esc(location)+'</span>':'')+'<span>'+Number(coach.follower_count||0)+' followers</span></div>'
        +(coach.coaching_bio?'<p class="coach-booking-bio">'+esc(coach.coaching_bio)+'</p>':'')
        +'<div class="coach-booking-facts"><div><small>Experience</small><strong>'+Number(coach.experience_years||0)+' years</strong></div><div><small>Coaching rate</small><strong>'+money(coach.hourly_rate)+'/hr</strong></div></div>'
      +'</div>'
    +'</div>';
}


function renderCoachPrograms() {
  const section=$('coachProgramsSection'),grid=$('coachProgramsGrid');
  if(!section||!grid)return;
  if(!coachPrograms.length){section.style.display='none';grid.innerHTML='';return;}
  section.style.display='block';
  grid.innerHTML=coachPrograms.map(program=>{
    const full=Number(program.spots_remaining||0)<=0;
    const start=program.starts_at?new Date(program.starts_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}):'Start date to be confirmed';
    return '<article class="coach-program-public-card">'
      +'<div class="coach-program-public-top"><div><span class="coach-pill">Program</span><h3>'+esc(program.title)+'</h3></div><strong>'+money(program.price_per_enrollee)+'</strong></div>'
      +(program.description?'<p>'+esc(program.description)+'</p>':'')
      +'<div class="coach-program-public-meta"><span><b>'+Number(program.total_hours)+'</b> total hours</span><span><b>'+Number(program.confirmed_enrollees||0)+'</b>/'+Number(program.capacity)+' enrolled</span><span>'+esc(start)+'</span></div>'
      +'<div class="coach-note" style="margin-top:10px">'+esc(program.schedule_text||'Schedule to be arranged')+' · '+esc(program.location_text||coach.location_text||'Location to be confirmed')+'</div>'
      +'<div class="coach-summary" style="margin-top:14px">'+summaryRow('Program price',money(program.price_per_enrollee))+summaryRow(CONVENIENCE_FEE_LABEL,money(25))+'<div class="coach-summary-row total"><span>Total payable</span><strong>'+money(Number(program.price_per_enrollee)+25)+'</strong></div></div>'
      +'<button type="button" class="coach-btn lime" data-enroll-program="'+esc(program.id)+'" style="width:100%;margin-top:14px" '+(full?'disabled':'')+'>'+(full?'Program full':'Enroll now')+'</button>'
      +'</article>';
  }).join('');
  grid.querySelectorAll('[data-enroll-program]').forEach(button=>button.addEventListener('click',()=>beginProgramEnrollment(button.dataset.enrollProgram)));
}
async function beginProgramEnrollment(programId){
  if(activeProgramEnrollment)return;
  const program=coachPrograms.find(item=>item.id===programId);
  if(!program)return;
  try{
    const user=await ensurePlayer();
    if(!user)return;
    const {data,error}=await supabase.rpc('create_coach_program_enrollment',{p_program_id:programId});
    if(error)throw error;
    if(!data?.enrollment_id)throw new Error('Courtly could not create the program enrollment.');
    activeProgramEnrollment=data;
    const qr=data.payment_qr_path?supabase.storage.from('courtly-coach-media').getPublicUrl(data.payment_qr_path).data.publicUrl:'';
    $('programEnrollmentSummary').innerHTML='<h2 style="font:700 18px Poppins;color:#001a47;margin:0 0 12px">Complete your enrollment</h2>'
      +'<div class="coach-summary">'+summaryRow('Program',data.program_title)+summaryRow('Total hours',data.total_hours+' hours')+summaryRow('Program price',money(data.price_per_enrollee))+summaryRow(CONVENIENCE_FEE_LABEL,money(data.booker_convenience_fee||25))+'<div class="coach-summary-row total"><span>Total payable</span><strong>'+money(data.player_total)+'</strong></div></div>'
      +'<div class="coach-summary" style="margin-top:12px"><strong>'+esc(data.payment_provider||'Payment account')+'</strong><p class="coach-note">'+esc(data.payment_account_name||'')+'</p><strong>'+esc(data.payment_account_number||'')+'</strong>'
      +(qr?'<img class="coach-upload-preview" style="max-width:220px;display:block;margin:12px auto" src="'+esc(qr)+'" alt="Coach payment QR">':'')
      +'<p class="coach-note">'+esc(data.payment_instructions||'')+'</p></div>';
    $('programEnrollmentPanel').style.display='block';
    $('programEnrollmentPanel').scrollIntoView({behavior:'smooth',block:'start'});
    showMessage('Your program spot is temporarily held while you submit payment details.',true);
  }catch(error){showMessage(error.message||'Could not start program enrollment.');}
}
async function submitProgramEnrollment(event){
  event.preventDefault();
  const button=$('submitProgramEnrollment');
  try{
    if(!activeProgramEnrollment)throw new Error('Choose a coaching program first.');
    const reference=$('programPaymentReference').value.trim();
    if(!reference)throw new Error('Enter your payment reference number.');
    const file=$('programReceipt').files?.[0];
    if(file)validateReceipt(file,10,receiptTypes);
    const user=await ensurePlayer();
    if(!user)return;
    button.disabled=true;button.textContent='Submitting…';
    let receiptPath=null;
    if(file){
      const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'}[file.type];
      receiptPath=user.id+'/program-'+activeProgramEnrollment.enrollment_id+'/'+Date.now()+'-'+crypto.randomUUID()+'.'+extension;
      const {error}=await supabase.storage.from('courtly-coach-payment-receipts').upload(receiptPath,file,{contentType:file.type,upsert:false});
      if(error)throw error;
    }
    const {data,error}=await supabase.rpc('submit_coach_program_enrollment_payment',{
      p_enrollment_id:activeProgramEnrollment.enrollment_id,
      p_payment_reference:reference,
      p_receipt_path:receiptPath,
      p_player_note:$('programPlayerNote').value.trim()||null
    });
    if(error)throw error;
    if(data?.success!==true)throw new Error('Enrollment payment could not be confirmed.');
    $('programEnrollmentPanel').innerHTML='<div style="text-align:center;padding:20px"><h2 style="font:700 20px Poppins;color:#001a47">Enrollment submitted</h2><p class="coach-note">The coach will verify your payment. Your program enrollment becomes confirmed once approved.</p><span class="coach-pill pending">Awaiting verification</span><p><strong>'+esc(data.enrollment_reference||activeProgramEnrollment.enrollment_reference)+'</strong></p></div>';
    activeProgramEnrollment=null;
    showMessage('Your program enrollment payment was submitted for coach verification.',true);
  }catch(error){showMessage(error.message||'Could not submit the program enrollment payment.');}
  finally{if(button&&button.isConnected){button.disabled=false;button.textContent='Submit enrollment payment';}}
}

function summaryRow(label, value) {
  return '<div class="coach-summary-row"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
}
function renderSummary() {
  if (!coach) return;
  const duration = booking ? Number(booking.duration_hours) : Number($('duration').value || 1);
  const rate = Number(booking?.hourly_rate ?? coach.hourly_rate);
  const subtotal = Number(booking?.subtotal ?? rate * duration);
  const convenienceFee = Number(booking?.booker_convenience_fee ?? 25);
  const total = Number(booking?.player_total ?? subtotal + convenienceFee);
  const start = booking?.starts_at || selected?.slot_start;
  let html = summaryRow('Coach', coach.coach_name);
  if (start) {
    html += summaryRow('Date & time', new Date(start).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }));
  }
  html += summaryRow('Rate', money(rate) + '/hour')
    + summaryRow('Duration', duration + ' hour' + (duration === 1 ? '' : 's'))
    + summaryRow('Coaching session', money(subtotal))
    + summaryRow(CONVENIENCE_FEE_LABEL, money(convenienceFee))
    + '<div class="coach-summary-row total"><span>Total payable</span><strong>' + money(total) + '</strong></div>'
    + '<p class="coach-note" style="margin:12px 0 0">The ₱25 ' + CONVENIENCE_FEE_LABEL + ' is paid by the booker once per successful coaching booking. It is not deducted from the coach\'s coaching rate.</p>';
  $('summary').innerHTML = html;
}
function setSelectionLocked(locked) {
  $('bookingDate').disabled = locked;
  $('duration').disabled = locked;
  $('prevCoachMonth').disabled = locked;
  $('nextCoachMonth').disabled = locked;
  renderCoachCalendar();
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
    const { data, error } = await supabase.rpc('get_coach_calendar_slots', {
      p_coach_id: coach.coach_id, p_date: selection.date, p_duration_hours: selection.duration
    });
    if (!slotRequests.isCurrent(request) || booking) return;
    if (error) throw error;
    if (formSelection().key !== selection.key) return;
    const slots = data || [];
    if (!slots.length) {
      $('slotList').innerHTML = '<div class="coach-empty" style="grid-column:1/-1">The coach has no scheduled hours on this date. Choose another day.</div>';
      return;
    }
    $('slotList').innerHTML = slots.map((slot, index) => {
      const status=slot.slot_status||'available';
      const time=esc(new Date(slot.slot_start).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'}));
      const label=status==='booked'?'Booked':status==='past'?'Past':'Available';
      return '<button type="button" class="coach-slot '+esc(status)+'" data-slot="'+index+'" aria-pressed="false" '+(status==='available'?'':'disabled')+'>'
        +'<span class="coach-slot-time">'+time+'</span><span class="coach-slot-status">'+label+'</span></button>';
    }).join('');
    $('slotList').querySelectorAll('[data-slot]').forEach((button,index)=>{
      const slot=slots[index];
      if((slot.slot_status||'available')!=='available')return;
      button.addEventListener('click',()=>{
        if(booking||reservationSubmission.busy||!slotRequests.isCurrent(request))return;
        selected=slot;
        selectionKey=selection.key;
        $('slotList').querySelectorAll('[data-slot]').forEach((item)=>{
          const active=item===button;
          item.classList.toggle('selected',active);
          item.setAttribute('aria-pressed',String(active));
        });
        $('reserveSlot').disabled=false;
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
      : '5 minutes from now';
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
$('prevCoachMonth').addEventListener('click',()=>{calendarView=new Date(calendarView.getFullYear(),calendarView.getMonth()-1,1);renderCoachCalendar();});
$('nextCoachMonth').addEventListener('click',()=>{calendarView=new Date(calendarView.getFullYear(),calendarView.getMonth()+1,1);renderCoachCalendar();});
$('paymentForm').addEventListener('submit', submitPayment);
$('programEnrollmentForm')?.addEventListener('submit', submitProgramEnrollment);
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
  renderCoachBookingHero();
  const {data:programRows,error:programError}=await supabase.rpc('get_public_coach_programs',{p_coach_id:coach.coach_id});
  if(programError)console.warn('Could not load coach programs:',programError.message);
  coachPrograms=programRows||[];
  renderCoachPrograms();
  $('coachBookingIdentity').innerHTML = '<div class="coach-booking-calendar-title"><strong>Choose your session</strong><span>' + esc(coach.coach_name) + ' · ' + money(coach.hourly_rate) + '/hour</span></div>';
  const initialDate=todayManila(new Date(Date.now()+86400000));
  $('bookingDate').value=initialDate;
  const initialParts=dateParts(initialDate);
  calendarView=new Date(initialParts.year,initialParts.month-1,1);
  setSelectionLocked(false);
  renderCoachCalendar();
  await loadSlots();
}
init().catch((error) => {
  showMessage(error.message || 'This coaching booking page could not load.');
  $('coachBookingIdentity').textContent = 'Coach booking unavailable';
  $('slotList').innerHTML = '<a class="coach-btn outline" href="/coaches.html">Browse available coaches</a>';
});
