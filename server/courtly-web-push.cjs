const {
  createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign
} = require('node:crypto');

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}
function fromB64url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}
function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}
function hkdfExpand(prk, info, length) {
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, length);
}
async function vapidMaterial(backend) {
  const scalar = await backend.rpc('courtly_get_vapid_private_key');
  if (!scalar || typeof scalar !== 'string') throw new Error('Courtly Web Push key is unavailable.');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(scalar));
  const publicRaw = ecdh.getPublicKey(null, 'uncompressed');
  const x = b64url(publicRaw.subarray(1, 33));
  const y = b64url(publicRaw.subarray(33, 65));
  const privateKey = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x, y, d: scalar },
    format: 'jwk'
  });
  return { privateKey, publicRaw, publicKey: b64url(publicRaw) };
}
function vapidAuthorization(endpoint, material) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: 'mailto:receipts@courtlyph.com'
  }));
  const unsigned = header + '.' + claims;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: material.privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return 'vapid t=' + unsigned + '.' + b64url(signature) + ', k=' + material.publicKey;
}
function encryptedBody(subscription, payload) {
  const userPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth_secret);
  if (userPublic.length !== 65 || authSecret.length === 0) throw new Error('Invalid push subscription keys.');

  const serverECDH = createECDH('prime256v1');
  const serverPublic = serverECDH.generateKeys();
  const sharedSecret = serverECDH.computeSecret(userPublic);

  const prkKey = hmac(authSecret, sharedSecret);
  const ikmInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, serverPublic]);
  const ikm = hkdfExpand(prkKey, ikmInfo, 32);
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfExpand(prk, 'Content-Encoding: nonce\0', 12);

  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
}
async function sendSubscription(fetchImpl, subscription, payload, material) {
  const body = encryptedBody(subscription, payload);
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidAuthorization(subscription.endpoint, material)
    },
    body
  });
  return response;
}
async function pushBookingNotifications({ backend, fetchImpl = globalThis.fetch, source, sourceRow }) {
  if (source?.type !== 'court_booking' || !sourceRow) return { attempted: false, sent: 0 };
  // The caller authenticates and authorizes the booking before entering here.
  // Rows come from the database trigger, never from a client-supplied recipient.
  const notifications = await backend.rest(
    'user_notifications?booking_id=eq.' + encodeURIComponent(source.id) +
    '&push_sent_at=is.null&read_at=is.null&select=id,title,body,href,recipient_user_id,audience,type&order=created_at.asc'
  );
  let sent = 0;
  let material;
  for (const notification of notifications || []) {
    if (!notification.recipient_user_id) continue;
    const userFilter = encodeURIComponent(notification.recipient_user_id);
    const subscriptions = await backend.rest('push_subscriptions?user_id=eq.' + userFilter + '&select=id,endpoint,p256dh,auth_secret');
    // An owner who has not enabled alerts must still be able to receive them
    // after enrolling a device. Do not mark undelivered notifications as sent.
    if (!subscriptions?.length) continue;
    const unreadRows = await backend.rest('user_notifications?recipient_user_id=eq.' + userFilter + '&read_at=is.null&select=id');
    material ||= await vapidMaterial(backend);
    const payload = {
      title: notification.title || 'Courtly booking update',
      body: notification.body || 'You have a new booking update.',
      url: notification.href || (notification.audience === 'owner' ? '/owner-portal.html?view=bookings' : '/player-dashboard.html?view=bookings'),
      badge: Math.max(1, unreadRows?.length || 0),
      tag: 'courtly-' + notification.id
    };
    let delivered = 0;
    for (const subscription of subscriptions) {
      try {
        const response = await sendSubscription(fetchImpl, subscription, payload, material);
        if (response.ok) { sent += 1; delivered += 1; }
        else if ([404, 410].includes(response.status)) {
          await backend.rest('push_subscriptions?id=eq.' + encodeURIComponent(subscription.id), { method: 'DELETE' });
        }
      } catch (error) {
        console.warn('Courtly Web Push delivery failed:', error?.message || 'unknown error');
      }
    }
    if (delivered) await backend.rest('user_notifications?id=eq.' + encodeURIComponent(notification.id), {
      method: 'PATCH', body: JSON.stringify({ push_sent_at: new Date().toISOString() })
    });
  }
  return { attempted: true, sent };
}

module.exports = { vapidMaterial, pushBookingNotifications, pushConfirmedBooking: pushBookingNotifications };
