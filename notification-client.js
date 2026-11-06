// Best-effort delivery dispatch after a booking mutation has committed.
// This helper always resolves: email/network failures cannot undo that mutation.
const SOURCE_TYPES = new Set(['court_booking', 'open_play_registration', 'coaching_booking']);

export function deliveryState(deliveries) {
  if (!Array.isArray(deliveries) || !deliveries.length) return 'unavailable';
  const jobs = deliveries.filter(job => job.status !== 'superseded');
  if (!jobs.length) return 'none';
  if (jobs.some(job => job.status === 'needs_review')) return 'needs_review';
  if (jobs.some(job => ['pending', 'processing', 'retry'].includes(job.status))) return 'queued';
  return jobs.every(job => job.status === 'sent') ? 'sent' : 'unavailable';
}

export async function dispatchBookingNotifications(client, source, options = {}) {
  let timer;
  const unavailable = () => ({ status: 'unavailable', deliveries: [] });
  try {
    if (!SOURCE_TYPES.has(source?.type) || !source?.id || !client?.auth) return unavailable();
    const controller = new AbortController();
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(unavailable()); }, options.timeoutMs || 12_000);
    });
    const send = async () => {
      try {
        const { data, error } = await client.auth.getSession();
        const token = data?.session?.access_token;
        if (error || !token || controller.signal.aborted) return unavailable();
        const fetcher = options.fetchImpl || globalThis.fetch;
        const response = await fetcher('/api/notifications/process', {
          method: 'POST', signal: controller.signal, keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type: source.type, id: source.id })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success !== true) {
          // Reconciliation saves the queue before email configuration is checked.
          return { status: ['EMAIL_DELIVERY_PAUSED', 'EMAIL_NOT_CONFIGURED', 'SENDER_INVALID'].includes(result.code) ? 'paused' : 'unavailable', deliveries: [] };
        }
        const deliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
        const receipt = deliveries.filter(job => job.kind === 'receipt');
        return { status: deliveryState(deliveries), receiptStatus: receipt.length ? deliveryState(receipt) : null, deliveries };
      } catch { return unavailable(); }
    };
    // Bound auth lookup as well as fetch. The server may still finish after
    // timeout; its durable idempotency keys make a later dispatch safe.
    return await Promise.race([send(), timeout]);
  } catch { return unavailable(); }
  finally { clearTimeout(timer); }
}

export function notificationDeliveryMessage(result, { receipt = false } = {}) {
  const state = receipt && result?.receiptStatus ? result.receiptStatus : result?.status;
  const label = receipt && result?.receiptStatus ? 'Payment receipt email' : 'Email update';
  if (state === 'sent') return `${label} sent.`;
  if (state === 'queued') return `${label} queued for delivery.`;
  if (state === 'paused') return 'Email updates are saved; delivery is awaiting configuration.';
  if (state === 'needs_review') return `${label} needs delivery review. The saved booking status is unchanged.`;
  if (state === 'none') return '';
  return 'Email delivery status is unavailable. The saved booking status is unchanged.';
}
