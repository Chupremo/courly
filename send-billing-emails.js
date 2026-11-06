const { createBackend, json, fail, requireCron } = require('./server/courtly-backend.cjs');
const { emailConfiguration, requireEmailConfiguration, processDeliveryJobs } = require('./server/courtly-delivery.cjs');

function createHandler(dependencies = {}) {
  return async function sendBillingEmails(req, res) {
    const deadline = (dependencies.now || Date.now)() + 45000;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    const env = dependencies.env || process.env;
    try {
      requireCron(req, env, '/api/cron/send-billing-emails' + (String(req.query?.check || '') === '1' ? '?check=1' : ''), dependencies.now);
      const backend = dependencies.backend || createBackend({ env, fetchImpl: dependencies.fetchImpl });
      const schema = await backend.readiness();
      if (String(req.query?.check || '') === '1') return json(res, 200, { schema, email: emailConfiguration(env) });
      requireEmailConfiguration(env);
      // Existing Supabase jobs still generate invoices and enforce overdue balances.
      await backend.rpc('queue_courtly_billing_email_notices');
      const result = await processDeliveryJobs({ ...dependencies, backend, env, category: 'billing', limit: 20, deadline });
      return json(res, 200, { success: true, ...result });
    } catch (error) {
      return fail(res, error, 'Courtly billing delivery failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
