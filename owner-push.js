import { bindPushSubscription } from './push-subscription.js';
import { supabase } from './supabase-client.js';
let ownerId = null;
let ready = false;
let setup = null;
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
export async function registerOwnerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
  void registration.update().catch(() => {});
  return navigator.serviceWorker.ready;
}
export async function syncOwnerBadge(count) {
  try {
    if (count > 0) await navigator.setAppBadge?.(count);
    else await navigator.clearAppBadge?.();
  } catch { /* Badge support depends on platform and permission. */ }
}
export function ownerPushCard() {
  if (!('Notification' in window) || !('PushManager' in window)) {
    return installed() ? '' : '<section class="panel"><strong>Booking alerts on your phone</strong><p class="muted small">Add Courtly to your Home Screen, open the app, then enable notifications here.</p></section>';
  }
  if (Notification.permission === 'denied') return '<section class="panel"><strong>Phone notifications are turned off</strong><p class="muted small">Allow notifications for Courtly in your phone settings. Your portal still receives live booking updates.</p></section>';
  if (ready) return '';
  return '<section class="panel" id="ownerPushSetup"><strong>Get new booking alerts</strong><p class="muted small">Receive reservations and payment updates even when Courtly is closed.</p><button class="btn primary" type="button" onclick="courtlyEnableOwnerNotifications(this)">Enable notifications</button><p class="muted small" id="ownerPushStatus" aria-live="polite"></p></section>';
}
export function configureOwnerPush(userId) {
  if (ownerId !== userId) ready = false;
  ownerId = userId;
  void registerOwnerWorker().catch(error => console.warn('Courtly app update unavailable:', error.message));
  if ('Notification' in window && Notification.permission === 'granted') void enableOwnerPush().catch(error => console.warn('Courtly booking alerts unavailable:', error.message));
}
async function enableOwnerPush(permission) {
  if (setup) return setup;
  setup = (async () => {
    if (!ownerId || !('Notification' in window) || !('PushManager' in window)) throw new Error('Open Courtly from your Home Screen to enable phone notifications.');
    const granted = permission ? await permission : Notification.permission;
    if (granted !== 'granted') throw new Error('Allow notifications to receive booking alerts on this phone.');
    const registration = await registerOwnerWorker();
    if (!registration) throw new Error('Phone notifications are unavailable in this browser.');
    await bindPushSubscription({ client: supabase, registration, userId: ownerId, userAgent: navigator.userAgent,
      subscribe: async () => {
        const response = await fetch('/api/push/config', { cache: 'no-store' });
        const config = await response.json();
        if (!response.ok || !config.publicKey) throw new Error('Booking alerts could not connect. Please try again.');
        const raw = atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
        return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, ch => ch.charCodeAt(0)) });
      }
    });
    ready = true;
    document.getElementById('ownerPushSetup')?.remove();
    return true;
  })();
  try { return await setup; } finally { setup = null; }
}
window.courtlyEnableOwnerNotifications = async button => {
  // Request synchronously in the tap handler, before any network/auth awaits (iOS).
  const permission = 'Notification' in window && Notification.permission === 'default' ? Notification.requestPermission() : null;
  button.disabled = true;
  try { await enableOwnerPush(permission); window.courtlyOwnerToast?.('Booking alerts enabled on this device.'); }
  catch (error) { const status = document.getElementById('ownerPushStatus'); if (status) status.textContent = error.message; }
  finally { button.disabled = false; }
};
