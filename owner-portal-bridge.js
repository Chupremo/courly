import { supabase, supabaseConfigError } from './supabase-client.js';
import { dispatchBookingNotifications } from './notification-client.js';

const DEMO_SLUGS = new Set([
  'demo-batangas-racquet-club', 'demo-lipa-pickleball-hub',
  'demo-santos-pickleball-club', 'demo-southside-sports-center'
]);
let pendingWrites = Promise.resolve();

function timeParts(iso, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(iso));
  const get = (name) => parts.find((part) => part.type === name)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}
function formatHour(hour, minute = 0) {
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function localTimeToIso(dateText, timeText, timezone) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const [hour, minute] = String(timeText || '08:00').split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute || 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(guess));
    const get = (name) => Number(parts.find((part) => part.type === name)?.value || 0);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}
function mapBooking(row, courtMap, timezone) {
  const start = timeParts(row.starts_at, timezone);
  const end = timeParts(row.ends_at, timezone);
  const status = ({ confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected', expired: 'Expired' })[row.status] || 'Pending';
  const paymentStatus = row.payment_status === 'confirmed' ? 'Paid'
    : row.payment_status === 'rejected' ? 'Rejected'
      : row.payment_status === 'awaiting_verification' ? 'Awaiting owner verification' : 'Unpaid';
  return {
    id: row.id, reference: row.reference, player: row.customer_name, email: row.customer_email,
    phone: row.customer_phone || '', date: start.date,
    startsAt: row.starts_at, endsAt: row.ends_at,
    startMinutes: start.hour * 60 + start.minute, endDate: end.date, endMinutes: end.hour * 60 + end.minute,
    time: `${formatHour(start.hour, start.minute)} – ${formatHour(end.hour, end.minute)}`,
    duration: row.duration_hours, court: courtMap.get(row.court_id) || 'Court', courtId: row.court_id,
    price: Number(row.subtotal || 0), subtotal: Number(row.subtotal || 0),
    total: Number(row.total || 0), platformFee: Number(row.platform_fee || 0),
    status, paymentStatus, paymentMethod: row.payment_method || 'GCash',
    paymentScreenshotPath: row.payment_receipt_path || '',
    createdAt: row.created_at, confirmedAt: row.confirmed_at || row.paid_at || null,
    rawStatus: row.status
  };
}
async function currentOwnerVenue() {
  if (!supabase) throw new Error(supabaseConfigError);
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!auth?.user) throw new Error('Your owner session has expired. Please log in again.');
  const { data: venueId, error: ensureError } = await supabase.rpc('courtly_ensure_owner_venue');
  if (ensureError) throw ensureError;
  const { error: expiryError } = await supabase.rpc('expire_owner_courtly_booking_holds');
  if (expiryError) throw expiryError;
  const { data: venue, error } = await supabase.from('venues').select('*').eq('id', venueId).maybeSingle();
  if (error) throw error;
  if (!venue) throw new Error('Courtly could not link a venue to this owner account. Please contact support.');
  return { user: auth.user, venue };
}

export async function loadOwnerWorkspace() {
  const { user, venue } = await currentOwnerVenue();
  const [{ data: courtRows, error: courtError }, { data: bookingRows, error: bookingError },
    { data: eventRows, error: eventError }, { data: blockRows, error: blockError },
    { data: activityRegistrationRows, error: activityRegistrationError }] = await Promise.all([
    supabase.from('courts').select('*').eq('venue_id', venue.id).order('display_order', { ascending: true }),
    supabase.from('bookings').select('*').eq('venue_id', venue.id).order('created_at', { ascending: false }),
    supabase.from('open_play_events').select('*').eq('venue_id', venue.id).order('starts_at', { ascending: true }),
    supabase.from('court_blocks').select('*').eq('venue_id', venue.id).order('starts_at', { ascending: true }),
    supabase.rpc('get_owner_community_activity_registrations')
  ]);
  if (courtError) throw courtError;
  if (bookingError) throw bookingError;
  if (eventError) throw eventError;
  if (blockError) throw blockError;
  if (activityRegistrationError && !['PGRST202','42883'].includes(activityRegistrationError.code)) throw activityRegistrationError;
  const courtMap = new Map((courtRows || []).map((court) => [court.id, court.name]));
  const timezone = venue.timezone || 'Asia/Manila';
  // Inactive courts remain in the lookup for historical reservations, but do
  // not become active again when an owner saves unrelated venue settings.
  const courts = (courtRows || []).filter((court) => court.is_active !== false);
  const events = (eventRows || []).map((event) => {
    const parts = timeParts(event.starts_at, timezone);
    return {
      id: event.id, title: event.title, details: event.details, image: event.banner_url || '',
      date: parts.date, time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
      where: event.location_text, fee: Number(event.fee || 0), limit: event.registration_limit,
      registeredCount: 0, active: event.is_published, createdAt: event.created_at
    };
  });
  const bookings = await Promise.all((bookingRows || []).map(async (row) => {
    const booking = mapBooking(row, courtMap, timezone);
    if (row.payment_receipt_path) {
      const { data: signed } = await supabase.storage.from('courtly-payment-receipts').createSignedUrl(row.payment_receipt_path, 600);
      booking.paymentScreenshotUrl = signed?.signedUrl || '';
    }
    return booking;
  }));
  const communityActivityPayments = await Promise.all((activityRegistrationRows || []).map(async (row) => {
    let receiptUrl = '';
    if (row.receipt_path) {
      const { data: signed } = await supabase.storage.from('courtly-payment-receipts').createSignedUrl(row.receipt_path, 600);
      receiptUrl = signed?.signedUrl || '';
    }
    return {
      ...row, receiptUrl, amount: Number(row.amount || 0),
      player: row.player_name || 'Courtly Player',
      event: row.event_title || 'Community activity'
    };
  }));
  const blocks = (blockRows || []).map((block) => {
    const start = timeParts(block.starts_at, timezone);
    const end = timeParts(block.ends_at, timezone);
    return {
      id: block.id, date: start.date, time: formatHour(start.hour, start.minute),
      court: courtMap.get(block.court_id) || 'Court', courtId: block.court_id, reason: block.reason,
      startsAt: block.starts_at, endsAt: block.ends_at,
      startMinutes: start.hour * 60 + start.minute, endDate: end.date, endMinutes: end.hour * 60 + end.minute,
      duration: (new Date(block.ends_at) - new Date(block.starts_at)) / 3600000
    };
  });
  const rates = courts.map((court) => Number(court.off_peak_rate ?? court.hourly_rate ?? 0));
  const peakRates = courts.map((court) => Number(court.peak_rate ?? court.off_peak_rate ?? court.hourly_rate ?? 0));
  const db = {
    openPlays: events,
    blocks,
    courts,
    bookings,
    communityActivityPayments,
    venue: {
      id: venue.id, name: venue.name, owner: venue.owner_name || user.user_metadata?.owner_name || user.email?.split('@')[0] || 'Owner',
      email: venue.admin_email || user.email || '', phone: venue.phone || '', location: venue.address || venue.city || '', city: venue.city || '',
      sport: venue.sport || courts[0]?.sport || 'Multi-sport', description: venue.description || '',
      slug: venue.slug, slugLocked: true, hoursOpen: String(venue.hours_open || '08:00').slice(0, 5),
      hoursClose: String(venue.hours_close || '22:00').slice(0, 5),
      baseRate: rates.length ? Math.min(...rates) : 350, peakRate: peakRates.length ? Math.max(...peakRates) : 350,
      peakHoursStart: venue.peak_hours_start ? String(venue.peak_hours_start).slice(0,5) : '',
      peakHoursEnd: venue.peak_hours_end ? String(venue.peak_hours_end).slice(0,5) : '',
      courtCount: courts.length, amenities: Array.isArray(venue.amenities) ? venue.amenities : [], courtImages: courts.map((court) => ({ data: court.image_url || '', fit: court.image_fit || 'cover', id: court.id, name: court.name })),
      logoData: venue.logo_url || '', coverData: venue.cover_url || '', paymentName: venue.payment_method || 'GCash QR',
      paymentAccount: venue.payment_account || '', paymentInstructions: venue.payment_instructions || '',
      qrData: venue.payment_qr_url || '', notifyEmail: venue.notify_email !== false,
      notifyPending: venue.notify_pending !== false, notifyCancelled: venue.notify_cancelled !== false,
      timezone, currency: venue.currency || 'PHP',
      trialStartedAt: venue.trial_started_at || null,
      trialEndsAt: venue.trial_ends_at || null,
      activationStatus: (venue.activation_status === 'trial' && venue.trial_ends_at && new Date(venue.trial_ends_at).getTime() <= Date.now()) ? 'on_hold' : (venue.activation_status || 'trial'),
      trialDaysRemaining: venue.trial_ends_at ? Math.max(0, Math.ceil((new Date(venue.trial_ends_at).getTime() - Date.now()) / 86400000)) : null,
      trialExpired: venue.activation_status === 'on_hold' || (venue.activation_status === 'trial' && venue.trial_ends_at && new Date(venue.trial_ends_at).getTime() <= Date.now()),
      bookingActivationReady: ['trial','active'].includes(venue.activation_status || 'trial') && (!venue.trial_ends_at || new Date(venue.trial_ends_at).getTime() > Date.now() || venue.activation_status === 'active') && venue.is_published !== false
    }
  };
  return db;
}

async function uploadDataUrlOrKeep(value, venueId, key) {
  if (!value || !String(value).startsWith('data:')) return value || null;
  const response = await fetch(value);
  if (!response.ok) throw new Error(`Could not prepare ${key} image (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`${key} is not a valid image file.`);
  if (key === 'logo' && blob.type !== 'image/png') {
    throw new Error('Venue logos must be transparent PNG files. Please upload a PNG with its background removed.');
  }
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${venueId}/${key}-${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('courtly-venue-media').upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw new Error(`Storage upload denied for ${key} (bucket courtly-venue-media, venue folder ${venueId}): ${error.message}`);
  const publicUrl = supabase.storage.from('courtly-venue-media').getPublicUrl(path).data.publicUrl;
  if (!publicUrl) throw new Error(`Storage accepted ${key}, but did not return a public image URL.`);
  return publicUrl;
}
async function assertCurrentOwnerCanManageVenue(venueId) {
  const { data: allowed, error } = await supabase.rpc('courtly_owns_venue', { p_venue_id: String(venueId) });
  if (error) throw new Error(`Could not verify venue ownership before saving images: ${error.message}. Apply migration 004_owner_court_image_rls_fix.sql.`);
  if (allowed !== true) throw new Error(`Your signed-in account does not own venue ${venueId}. Sign in with the venue owner account or contact Courtly support to link the venue.`);
}
async function updateVenueFields(venueId, payload) {
  const { error } = await supabase.from('venues')
    .update({ ...payload, updated_at: new Date().toISOString() }).eq('id', venueId);
  if (error) throw new Error(`Your venue changes could not be saved: ${error.message}`);
}

async function saveCourtSettings(state) {
  const v = state.venue;
  const count = Number(v.courtCount);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('Choose between 1 and 16 courts.');
  const rates = [Number(v.baseRate), Number(v.peakRate)];
  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('Enter valid non-negative court prices.');
  if (!v.hoursOpen || !v.hoursClose || v.hoursClose <= v.hoursOpen) throw new Error('Closing time must be later than opening time.');
  const { data: currentRows, error: readError } = await supabase.from('courts').select('*').eq('venue_id', v.id);
  if (readError) throw readError;
  const currentById = new Map((currentRows || []).map((court) => [court.id, court]));
  const loadedCourts = state.courts || [];
  const usedNames = new Set((currentRows || []).map((court) => court.name));
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    const loaded = loadedCourts[index];
    let court = loaded ? currentById.get(loaded.id) : null;
    if (loaded && (!court || court.is_active === false)) {
      throw new Error('A court changed since this page loaded. Refresh the workspace before saving.');
    }
    if (!court) {
      let number = index + 1;
      while (usedNames.has(`Court ${number}`)) number += 1;
      court = { id: crypto.randomUUID(), name: `Court ${number}`, sport: v.sport || 'Multi-sport' };
      usedNames.add(court.name);
    }
    // Preserve existing identities, names, sports and photos. Saving a rate
    // must not silently create a replacement for a named court.
    selected.push({
      id: court.id, venue_id: v.id, name: court.name, sport: court.sport || v.sport || 'Multi-sport',
      hourly_rate: rates[0], off_peak_rate: rates[0], peak_rate: rates[1],
      image_url: court.image_url || null, image_fit: court.image_fit || 'cover',
      display_order: index + 1, is_active: true
    });
  }
  await updateVenueFields(v.id, {
    hours_open: v.hoursOpen, hours_close: v.hoursClose,
    peak_hours_start: v.peakHoursStart || null, peak_hours_end: v.peakHoursEnd || null
  });
  const { data: saved, error: saveError } = await supabase.from('courts')
    .upsert(selected, { onConflict: 'id' }).select('*');
  if (saveError) throw new Error(`Court settings could not be saved: ${saveError.message}`);
  if ((saved || []).length !== selected.length) throw new Error('Some court settings were not returned after saving. Refresh to check their status.');
  // Only deactivate courts explicitly removed from the loaded list. Courts
  // created in another tab after this workspace loaded are not removed.
  const removedIds = loadedCourts.slice(count).map((court) => court.id);
  if (removedIds.length) {
    const { error } = await supabase.from('courts').update({ is_active: false }).eq('venue_id', v.id).in('id', removedIds);
    if (error) throw error;
  }
  const savedById = new Map(saved.map((court) => [court.id, court]));
  state.courts = selected.map((court) => savedById.get(court.id));
  v.courtImages = state.courts.map((court) => ({ id: court.id, name: court.name, data: court.image_url || '', fit: court.image_fit || 'cover' }));
}

async function saveCourtImage(state, index) {
  const v = state.venue;
  const court = state.courts?.[index];
  const image = v.courtImages?.[index];
  if (!court?.id || !image) throw new Error('Save the court count before adding a photo for this court.');
  const imageUrl = await uploadDataUrlOrKeep(image.data, v.id, `court-${court.id}`);
  const fit = image.fit === 'contain' ? 'contain' : 'cover';
  const { data: saved, error } = await supabase.from('courts')
    .update({ image_url: imageUrl, image_fit: fit }).eq('venue_id', v.id).eq('id', court.id)
    .select('id,image_url,image_fit').single();
  if (error) throw new Error(`Court photo could not be saved: ${error.message}`);
  if (!saved || (saved.image_url || null) !== (imageUrl || null)) throw new Error('The court photo was not saved. Please refresh and try again.');
  v.courtImages[index] = { ...image, id: court.id, name: court.name, data: saved.image_url || '', fit: saved.image_fit };
  state.courts[index] = { ...court, image_url: saved.image_url, image_fit: saved.image_fit };
}

async function persistOwnerWorkspace(state, change = {}) {
  if (!state?.venue?.id) throw new Error('Your venue has not finished loading. Please try again.');
  const v = state.venue;
  await assertCurrentOwnerCanManageVenue(v.id);
  if (change.scope === 'profile') {
    v.logoData = await uploadDataUrlOrKeep(v.logoData, v.id, 'logo');
    v.coverData = await uploadDataUrlOrKeep(v.coverData, v.id, 'cover');
    await updateVenueFields(v.id, {
      name: v.name, owner_name: v.owner, admin_email: v.email || null, phone: v.phone,
      address: v.location, city: v.city || null, sport: v.sport, description: v.description,
      amenities: Array.isArray(v.amenities) ? v.amenities : [], logo_url: v.logoData || null, cover_url: v.coverData || null
    });
  } else if (change.scope === 'payments') {
    v.qrData = await uploadDataUrlOrKeep(v.qrData, v.id, 'payment-qr');
    await updateVenueFields(v.id, {
      payment_qr_url: v.qrData || null, payment_method: v.paymentName || 'GCash QR',
      payment_account: v.paymentAccount || null, payment_instructions: v.paymentInstructions || null
    });
  } else if (change.scope === 'notifications') {
    await updateVenueFields(v.id, { notify_email: v.notifyEmail !== false, notify_pending: v.notifyPending !== false, notify_cancelled: v.notifyCancelled !== false });
  } else if (change.scope === 'courts') {
    await saveCourtSettings(state);
  } else if (change.scope === 'courtImage') {
    await saveCourtImage(state, change.index);
  } else if (change.scope === 'openPlay') {
    if (change.remove) {
      const { error } = await supabase.from('open_play_events').delete().eq('venue_id', v.id).eq('id', change.id);
      if (error) throw error;
    } else {
      const event = state.openPlays?.find((item) => item.id === change.id);
      if (!event) throw new Error('This Open Play event is no longer available. Refresh and try again.');
      const image = await uploadDataUrlOrKeep(event.image, v.id, `open-play-${event.id}`);
      const { error } = await supabase.from('open_play_events').upsert({
        id: event.id, venue_id: v.id, title: event.title, details: event.details || '',
        banner_url: image, starts_at: localTimeToIso(event.date, event.time, v.timezone),
        location_text: event.where || v.location, fee: Number(event.fee || 0),
        registration_limit: event.limit ? Number(event.limit) : null,
        is_published: event.active !== false, updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (error) throw error;
      event.image = image || '';
    }
  } else if (change.scope === 'block') {
    if (change.remove) {
      const { error } = await supabase.from('court_blocks').delete().eq('venue_id', v.id).eq('id', change.id);
      if (error) throw error;
    } else {
      const block = state.blocks?.find((item) => item.id === change.id);
      if (!block) throw new Error('This time block is no longer available.');
      const court = (state.courts || []).find((item) => item.id === block.courtId || item.name === block.court);
      if (!court?.id) throw new Error('The selected court is no longer active. Refresh and try again.');
      const match = String(block.time || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) throw new Error('Choose a valid time to block.');
      const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
      const start = block.startsAt || localTimeToIso(block.date, `${String(hour).padStart(2, '0')}:${match[2]}`, v.timezone);
      const end = block.endsAt || new Date(new Date(start).getTime() + Number(block.duration || 1) * 3600000).toISOString();
      // Recheck occupancy immediately before saving a new block. The booking
      // backend remains authoritative when a player is reserving concurrently.
      const { data: overlaps, error: overlapError } = await supabase.from('bookings').select('id')
        .eq('venue_id', v.id).eq('court_id', court.id).in('status', ['pending', 'confirmed'])
        .lt('starts_at', end).gt('ends_at', start);
      if (overlapError) throw overlapError;
      if (overlaps?.length) throw new Error('This time now has a reservation. Refresh the calendar before blocking it.');
      const { error } = await supabase.from('court_blocks').upsert({
        id: block.id, venue_id: v.id, court_id: court.id, starts_at: start, ends_at: end, reason: block.reason || 'Unavailable'
      }, { onConflict: 'id' });
      if (error) throw error;
      block.courtId = court.id;
      block.startsAt = start;
      block.endsAt = end;
    }
  } else {
    throw new Error('Choose the settings or calendar item to save.');
  }
  return state;
}

function queueOwnerWorkspaceSave(state, change) {
  // Capture this action now, rather than reading mutable form state after a
  // previous upload finishes. Each write touches only its requested section.
  const snapshot = structuredClone(state);
  const before = structuredClone(snapshot);
  const nextWrite = pendingWrites.catch(() => {}).then(() => persistOwnerWorkspace(snapshot, change));
  pendingWrites = nextWrite.catch(() => {});
  return nextWrite.then(() => {
    for (const key of ['logoData', 'coverData', 'qrData']) {
      if (state.venue[key] === before.venue[key]) state.venue[key] = snapshot.venue[key];
    }
    if (change.scope === 'courts') {
      state.courts = snapshot.courts;
      state.venue.courtImages = snapshot.venue.courtImages;
    } else if (change.scope === 'courtImage') {
      state.courts[change.index] = snapshot.courts[change.index];
      state.venue.courtImages[change.index] = snapshot.venue.courtImages[change.index];
    } else if (change.scope === 'openPlay' && !change.remove) {
      const event = state.openPlays?.find((item) => item.id === change.id);
      const saved = snapshot.openPlays?.find((item) => item.id === change.id);
      if (event && saved && event.image === before.openPlays?.find((item) => item.id === change.id)?.image) event.image = saved.image;
    } else if (change.scope === 'block' && !change.remove) {
      const block = state.blocks?.find((item) => item.id === change.id);
      const saved = snapshot.blocks?.find((item) => item.id === change.id);
      if (block && saved) Object.assign(block, saved);
    }
    return true;
  });
}
async function reviewBooking(bookingId, decision) {
  const { data, error } = await supabase.rpc('review_court_booking_payment', { p_booking_id: bookingId, p_decision: decision });
  if (error) throw error;
  // Payment is committed; dispatch must not delay or reverse the visible result.
  void dispatchBookingNotifications(supabase, { type: 'court_booking', id: bookingId }).catch(() => {});
  return data;
}
async function cancelBooking(bookingId) {
  const { data, error } = await supabase.rpc('cancel_owner_booking', { p_booking_id: bookingId });
  if (error) throw error;
  void dispatchBookingNotifications(supabase, { type: 'court_booking', id: bookingId }).catch(() => {});
  return data;
}
async function reviewCommunityActivityPayment(registrationId, decision) {
  const { data, error } = await supabase.rpc('review_community_activity_payment', {
    p_registration_id: registrationId, p_decision: decision
  });
  if (error) throw error;
  return data;
}

window.courtlyLoadOwnerWorkspace = loadOwnerWorkspace;
window.courtlyPersistOwnerWorkspace = queueOwnerWorkspaceSave;
window.courtlyReviewBooking = reviewBooking;
window.courtlyCancelBooking = cancelBooking;
window.courtlyReviewCommunityActivityPayment = reviewCommunityActivityPayment;
window.courtlySupabase = supabase;
window.courtlyBridgeReady = Promise.resolve(true);
window.dispatchEvent(new Event('courtly-bridge-ready'));
