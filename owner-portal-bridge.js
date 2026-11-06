import { supabase, supabaseConfigError } from './supabase-client.js';

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
  const status = row.status === 'confirmed' ? 'Confirmed' : row.status === 'cancelled' ? 'Cancelled' : row.status === 'rejected' ? 'Rejected' : 'Pending';
  const paymentStatus = row.payment_status === 'confirmed' ? 'Paid'
    : row.payment_status === 'rejected' ? 'Rejected'
      : row.payment_status === 'awaiting_verification' ? 'Awaiting owner verification' : 'Unpaid';
  return {
    id: row.id, reference: row.reference, player: row.customer_name, email: row.customer_email,
    phone: row.customer_phone || '', date: start.date,
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
    { data: eventRows, error: eventError }, { data: blockRows, error: blockError }] = await Promise.all([
    supabase.from('courts').select('*').eq('venue_id', venue.id).order('display_order', { ascending: true }),
    supabase.from('bookings').select('*').eq('venue_id', venue.id).order('created_at', { ascending: false }),
    supabase.from('open_play_events').select('*').eq('venue_id', venue.id).order('starts_at', { ascending: true }),
    supabase.from('court_blocks').select('*').eq('venue_id', venue.id).order('starts_at', { ascending: true })
  ]);
  if (courtError) throw courtError;
  if (bookingError) throw bookingError;
  if (eventError) throw eventError;
  if (blockError) throw blockError;
  const courtMap = new Map((courtRows || []).map((court) => [court.id, court.name]));
  const timezone = venue.timezone || 'Asia/Manila';
  const courts = courtRows || [];
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
  const blocks = (blockRows || []).map((block) => {
    const start = timeParts(block.starts_at, timezone);
    return { id: block.id, date: start.date, time: formatHour(start.hour, start.minute), court: courtMap.get(block.court_id) || 'Court', reason: block.reason };
  });
  const rates = courts.map((court) => Number(court.off_peak_rate ?? court.hourly_rate ?? 0));
  const peakRates = courts.map((court) => Number(court.peak_rate ?? court.off_peak_rate ?? court.hourly_rate ?? 0));
  const db = {
    openPlays: events,
    blocks,
    courts,
    bookings,
    venue: {
      id: venue.id, name: venue.name, owner: venue.owner_name || user.user_metadata?.owner_name || user.email?.split('@')[0] || 'Owner',
      email: venue.admin_email || user.email || '', phone: venue.phone || '', location: venue.address || venue.city || '', city: venue.city || '',
      sport: venue.sport || courts[0]?.sport || 'Multi-sport', description: venue.description || '',
      slug: venue.slug, slugLocked: true, hoursOpen: String(venue.hours_open || '08:00').slice(0, 5),
      hoursClose: String(venue.hours_close || '22:00').slice(0, 5),
      baseRate: rates.length ? Math.min(...rates) : 350, peakRate: peakRates.length ? Math.max(...peakRates) : 350,
      peakHoursStart: venue.peak_hours_start ? String(venue.peak_hours_start).slice(0,5) : '',
      peakHoursEnd: venue.peak_hours_end ? String(venue.peak_hours_end).slice(0,5) : '',
      courtCount: courts.length, amenities: Array.isArray(venue.amenities) ? venue.amenities : [], courtImages: courts.map((court) => ({ data: court.image_url || '', fit: court.image_fit || 'cover', id: court.id })),
      logoData: venue.logo_url || '', coverData: venue.cover_url || '', paymentName: venue.payment_method || 'GCash QR',
      paymentAccount: venue.payment_account || '', paymentInstructions: venue.payment_instructions || '',
      qrData: venue.payment_qr_url || '', notifyEmail: venue.notify_email !== false,
      notifyPending: venue.notify_pending !== false, notifyCancelled: venue.notify_cancelled !== false,
      timezone, currency: venue.currency || 'PHP'
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
async function persistOwnerWorkspace(state) {
  if (!state?.venue?.id) return;
  const v = state.venue;
  await assertCurrentOwnerCanManageVenue(v.id);
  v.logoData = await uploadDataUrlOrKeep(v.logoData, v.id, 'logo');
  v.coverData = await uploadDataUrlOrKeep(v.coverData, v.id, 'cover');
  v.qrData = await uploadDataUrlOrKeep(v.qrData, v.id, 'payment-qr');
  const payload = {
    name: v.name, owner_name: v.owner, admin_email: v.email || null, phone: v.phone, address: v.location,
    city: v.city || null, sport: v.sport, description: v.description, amenities: Array.isArray(v.amenities) ? v.amenities : [],
    logo_url: v.logoData || null, cover_url: v.coverData || null,
    payment_qr_url: v.qrData || null, payment_method: v.paymentName || 'GCash QR',
    payment_account: v.paymentAccount || null, payment_instructions: v.paymentInstructions || null,
    hours_open: v.hoursOpen || '08:00', hours_close: v.hoursClose || '22:00',
    peak_hours_start: v.peakHoursStart || null, peak_hours_end: v.peakHoursEnd || null,
    notify_email: v.notifyEmail !== false, notify_pending: v.notifyPending !== false,
    notify_cancelled: v.notifyCancelled !== false, updated_at: new Date().toISOString()
  };
  const { error: venueError } = await supabase.from('venues').update(payload).eq('id', v.id);
  if (venueError) throw new Error(`Venue profile update was rejected by Supabase: ${venueError.message}`);

  const imageRows = [];
  for (let index = 0; index < Number(v.courtCount || 0); index += 1) {
    const image = v.courtImages?.[index] || {};
    const imageUrl = await uploadDataUrlOrKeep(image.data, v.id, `court-${index + 1}`);
    if (imageUrl) image.data = imageUrl;
    imageRows.push({
      venue_id: v.id, name: `Court ${index + 1}`, sport: v.sport || 'Multi-sport',
      hourly_rate: Math.max(0, Number(v.baseRate ?? 350)),
      off_peak_rate: Math.max(0, Number(v.baseRate ?? 350)),
      peak_rate: Math.max(0, Number(v.peakRate ?? v.baseRate ?? 350)), is_active: true,
      image_url: imageUrl, image_fit: image.fit === 'contain' ? 'contain' : 'cover', display_order: index + 1
    });
  }
  const { data: currentCourts, error: currentCourtError } = await supabase.from('courts').select('id,name').eq('venue_id', v.id);
  if (currentCourtError) throw currentCourtError;
  if (imageRows.length) {
    const { data: savedImageRows, error } = await supabase
      .from('courts')
      .upsert(imageRows, { onConflict: 'venue_id,name' })
      .select('id,name,image_url,image_fit,is_active');
    if (error) throw new Error(`Court records could not be saved after the Storage upload. Check the public.courts INSERT/UPDATE RLS policy: ${error.message}`);
    // Verify each uploaded image URL was actually persisted before the owner
    // portal reports success. This catches storage/RLS/schema issues clearly.
    const savedByName = new Map((savedImageRows || []).map((row) => [row.name, row]));
    for (const expected of imageRows) {
      const saved = savedByName.get(expected.name);
      if (!saved) throw new Error(`${expected.name} was not returned after saving. Please retry.`);
      if (expected.image_url && saved.image_url !== expected.image_url) {
        throw new Error(`${expected.name} image did not synchronize to the database. Please retry.`);
      }
    }
  }
  const activeNames = imageRows.map((row) => row.name);
  const inactiveIds = (currentCourts || []).filter((row) => !activeNames.includes(row.name)).map((row) => row.id);
  if (inactiveIds.length) {
    const { error } = await supabase.from('courts').update({ is_active: false }).in('id', inactiveIds);
    if (error) throw error;
  }

  const { data: savedCourts, error: savedCourtsError } = await supabase.from('courts').select('id,name').eq('venue_id', v.id).eq('is_active', true);
  if (savedCourtsError) throw savedCourtsError;
  const courtIdByName = new Map((savedCourts || []).map((row) => [row.name, row.id]));

  // Open Play is canonical in the database. Upsert edited events and remove only
  // events explicitly removed from this owner's in-memory list.
  const eventPayloads = [];
  for (const event of state.openPlays || []) {
    const image = await uploadDataUrlOrKeep(event.image, v.id, `open-play-${event.id}`);
    if (image) event.image = image;
    eventPayloads.push({
      id: event.id, venue_id: v.id, title: event.title, details: event.details || '',
      banner_url: image, starts_at: localTimeToIso(event.date, event.time, v.timezone),
      location_text: event.where || v.location, fee: Number(event.fee || 0),
      registration_limit: event.limit ? Number(event.limit) : null,
      is_published: event.active !== false, updated_at: new Date().toISOString()
    });
  }
  const { data: currentEvents, error: eventsReadError } = await supabase.from('open_play_events').select('id').eq('venue_id', v.id);
  if (eventsReadError) throw eventsReadError;
  if (eventPayloads.length) {
    const { error } = await supabase.from('open_play_events').upsert(eventPayloads, { onConflict: 'id' });
    if (error) throw error;
  }
  const keptEventIds = new Set(eventPayloads.map((event) => event.id));
  const removeEventIds = (currentEvents || []).map((event) => event.id).filter((id) => !keptEventIds.has(id));
  if (removeEventIds.length) {
    const { error } = await supabase.from('open_play_events').delete().in('id', removeEventIds);
    if (error) throw error;
  }

  // Time blocks are keyed by their UUID. They are not bookings and never affect revenue.
  const { data: currentBlocks, error: blockReadError } = await supabase.from('court_blocks').select('id').eq('venue_id', v.id);
  if (blockReadError) throw blockReadError;
  const blockPayloads = (state.blocks || []).filter((block) => /^[0-9a-f-]{36}$/i.test(String(block.id || ''))).map((block) => {
    const hourMatch = String(block.time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!hourMatch) return null;
    let hour = Number(hourMatch[1]) % 12;
    if (hourMatch[3].toUpperCase() === 'PM') hour += 12;
    const start = localTimeToIso(block.date, `${String(hour).padStart(2, '0')}:${hourMatch[2]}`, v.timezone);
    const endDate = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    const courtId = courtIdByName.get(block.court);
    if (!courtId) return null;
    return { id: block.id, venue_id: v.id, court_id: courtId, starts_at: start, ends_at: endDate, reason: block.reason || 'Unavailable' };
  }).filter(Boolean);
  if (blockPayloads.length) {
    const { error } = await supabase.from('court_blocks').upsert(blockPayloads, { onConflict: 'id' });
    if (error) throw error;
  }
  const keptBlockIds = new Set(blockPayloads.map((block) => block.id));
  const removedBlockIds = (currentBlocks || []).map((block) => block.id).filter((id) => !keptBlockIds.has(id));
  if (removedBlockIds.length) {
    const { error } = await supabase.from('court_blocks').delete().in('id', removedBlockIds);
    if (error) throw error;
  }
}

function queueOwnerWorkspaceSave(state) {
  const nextWrite = pendingWrites.catch(() => {}).then(() => persistOwnerWorkspace(state));
  pendingWrites = nextWrite.catch(() => {});
  return nextWrite;
}
async function reviewBooking(bookingId, decision) {
  const { data, error } = await supabase.rpc('review_court_booking_payment', { p_booking_id: bookingId, p_decision: decision });
  if (error) throw error;
  if (decision === 'confirmed') {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (token) {
      const response = await fetch('/api/receipts/issue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ type: 'court_booking', id: bookingId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) console.error('Courtly payment confirmed, but receipt delivery failed:', result.error || response.status);
      else console.info('Courtly receipt issued:', result.receipt?.receipt_number || 'already processed');
    }
  }
  return data;
}
async function cancelBooking(bookingId) {
  const { data, error } = await supabase.rpc('cancel_owner_booking', { p_booking_id: bookingId });
  if (error) throw error;
  return data;
}

window.courtlyLoadOwnerWorkspace = loadOwnerWorkspace;
window.courtlyPersistOwnerWorkspace = queueOwnerWorkspaceSave;
window.courtlyReviewBooking = reviewBooking;
window.courtlyCancelBooking = cancelBooking;
window.courtlySupabase = supabase;
window.courtlyBridgeReady = Promise.resolve(true);
window.dispatchEvent(new Event('courtly-bridge-ready'));
