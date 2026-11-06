const { createBackend, ServiceError, UUID, json, fail } = require('../../server/courtly-backend.cjs');
const { makeReceiptPdf } = require('../../server/courtly-receipt-pdf.cjs');

function createHandler(dependencies = {}) {
  return async function downloadReceipt(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    try {
      const id = req.query?.id;
      if (!UUID.test(String(id || '')) || Array.isArray(id)) throw new ServiceError(400, 'INVALID_RECEIPT', 'Choose a valid receipt.');
      const backend = dependencies.backend || createBackend(dependencies);
      const actor = await backend.authenticate(req);
      // Email configuration does not affect an authenticated player's download.
      const rows = await backend.rest(`payment_receipts?id=eq.${id}&player_id=eq.${actor.id}&select=*`);
      const receipt = rows?.[0];
      if (!receipt || receipt.player_id !== actor.id) throw new ServiceError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
      const pdf = makeReceiptPdf(receipt);
      const filename = String(receipt.receipt_number).replace(/[^a-z0-9_-]/gi, '').slice(0, 120) || 'courtly-receipt';
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.end(pdf);
    } catch (error) {
      return fail(res, error, 'Courtly receipt download failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
