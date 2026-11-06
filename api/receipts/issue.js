const { createBackend, ServiceError, json, fail, readBody, sourceReference } = require('../../server/courtly-backend.cjs');
const { processDeliveryJobs } = require('../../server/courtly-delivery.cjs');

function createHandler(dependencies = {}) {
  return async function issueReceipt(req, res) {
    const deadline = (dependencies.now || Date.now)() + 45000;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    const env = dependencies.env || process.env;
    try {
      const source = sourceReference(readBody(req));
      const backend = dependencies.backend || createBackend({ env, fetchImpl: dependencies.fetchImpl });
      const actor = await backend.authenticate(req);
      const booking = await backend.authorizeSource(source, actor);
      if (booking.payment_status !== 'confirmed') throw new ServiceError(409, 'PAYMENT_NOT_CONFIRMED', 'A payment receipt is available after the venue owner or coach confirms payment.');
      await backend.readiness();
      await backend.rpc('courtly_delivery_reconcile_source', { p_source_type: source.type, p_source_id: source.id });
      const rows = await backend.rest(`payment_receipts?source_type=eq.${source.type}&source_id=eq.${source.id}&select=id,receipt_number,email_status`);
      const receipt = rows?.[0];
      if (!receipt) throw new ServiceError(409, 'RECEIPT_UNAVAILABLE', 'No payment receipt is required for a free registration. If this was a paid booking, contact Courtly support.');
      if (receipt.email_status === 'sent') return json(res, 200, { success: true, already_sent: true, delivery: 'sent', receipt });
      await processDeliveryJobs({ ...dependencies, backend, env, source, category: 'booking', limit: 4, deadline });
      const deliveries = await backend.rpc('courtly_delivery_source_status', { p_source_type: source.type, p_source_id: source.id });
      const delivery = deliveries?.find(job => job.kind === 'receipt')?.status || 'pending';
      return json(res, delivery === 'sent' ? 200 : 202, {
        success: true, receipt: { id: receipt.id, receipt_number: receipt.receipt_number },
        delivery, queued: ['pending', 'retry', 'processing'].includes(delivery), needs_review: delivery === 'needs_review'
      });
    } catch (error) {
      return fail(res, error, 'Courtly receipt issue failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
