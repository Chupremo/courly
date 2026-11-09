const { createBackend, json, fail, requireCron, readBody, sourceReference } = require('../../server/courtly-backend.cjs');
const { emailConfiguration, processDeliveryJobs } = require('../../server/courtly-delivery.cjs');
const { pushConfirmedBooking } = require('../../server/courtly-web-push.cjs');

function createHandler(dependencies = {}) {
  return async function processNotifications(req, res) {
    const deadline = (dependencies.now || Date.now)() + 45000;
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    const env = dependencies.env || process.env;
    try {
      if (req.method === 'GET') requireCron(req, env, '/api/notifications/process' + (String(req.query?.check || '') === '1' ? '?check=1' : ''), dependencies.now);
      const backend = dependencies.backend || createBackend({ env, fetchImpl: dependencies.fetchImpl });
      let source = null;
      let sourceRow = null;
      if (req.method === 'POST') {
        source = sourceReference(readBody(req));
        const actor = await backend.authenticate(req);
        sourceRow = await backend.authorizeSource(source, actor);
      }
      const schema = await backend.readiness();
      // Protected, read-only deployment check: never claims a job or sends mail.
      if (req.method === 'GET' && String(req.query?.check || '') === '1') {
        return json(res, 200, { schema, email: emailConfiguration(env) });
      }
      if (source) await backend.rpc('courtly_delivery_reconcile_source', { p_source_type: source.type, p_source_id: source.id });
      const result = await processDeliveryJobs({ ...dependencies, backend, env, source, category: 'booking', limit: source ? 4 : 20, deadline });
      const deliveries = source ? await backend.rpc('courtly_delivery_source_status', { p_source_type: source.type, p_source_id: source.id }) : undefined;
      if (source && sourceRow) {
        try {
          await pushConfirmedBooking({ backend, fetchImpl: dependencies.fetchImpl || globalThis.fetch, source, sourceRow });
        } catch (pushError) {
          console.warn('Courtly push dispatch failed:', pushError?.message || 'unknown error');
        }
      }
      const pending = (deliveries || []).some(job => ['pending', 'processing', 'retry', 'needs_review'].includes(job.status));
      return json(res, pending ? 202 : 200, { success: true, ...result, ...(source ? { deliveries } : {}) });
    } catch (error) {
      return fail(res, error, 'Courtly notification processing failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
