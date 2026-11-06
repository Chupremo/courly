import billingEmails from '../api/cron/send-billing-emails.js';
import notifications from '../api/notifications/process.js';
import receiptIssue from '../api/receipts/issue.js';
import receiptDownload from '../api/receipts/download.js';
import communityShare from '../api/community-event-share.js';

// Each successful job makes four subrequests. Eight jobs plus readiness/billing
// setup use at most 34, leaving room below the Workers Free limit of 50.
export const WORKERS_DELIVERY_BATCH_LIMIT = 8;

// Explicit dependencies keep Worker bindings local to each invocation and retain
// the same handler implementations used by the existing Vercel deployment.
export function createApiHandlers(env = {}, overrides = {}) {
  const dependencies = { ...overrides, env, maxDeliveryJobs: WORKERS_DELIVERY_BATCH_LIMIT };
  return Object.freeze({
    '/api/cron/send-billing-emails': billingEmails.createHandler(dependencies),
    '/api/notifications/process': notifications.createHandler(dependencies),
    '/api/receipts/issue': receiptIssue.createHandler(dependencies),
    '/api/receipts/download': receiptDownload.createHandler(dependencies),
    '/api/community-event-share': communityShare.createHandler(dependencies)
  });
}
