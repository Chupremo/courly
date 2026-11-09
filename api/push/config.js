const { createBackend, json, fail } = require('../../server/courtly-backend.cjs');
const { vapidMaterial } = require('../../server/courtly-web-push.cjs');

function createHandler(dependencies = {}) {
  return async function pushConfig(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    try {
      const env = dependencies.env || process.env;
      const backend = dependencies.backend || createBackend({ env, fetchImpl: dependencies.fetchImpl });
      const material = await vapidMaterial(backend);
      return json(res, 200, { success: true, publicKey: material.publicKey });
    } catch (error) {
      return fail(res, error, 'Courtly push configuration failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
