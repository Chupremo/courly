import { createHmac } from 'node:crypto';
import { invokeNodeHandler } from './api-adapter.mjs';
import { createApiHandlers } from './api-routes.mjs';
import { resolvePageRoute, schedules } from './routes.mjs';

function jsonError(status, message) {
  return Response.json({ success: false, error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.hostname === 'courtlyph.com') {
    url.protocol = 'https:';
    url.hostname = 'www.courtlyph.com';
    return new Response(null, {
      status: 308,
      headers: {
        Location: url.toString(),
        'Cache-Control': 'no-store'
      }
    });
  }

  const path = url.pathname.replace(/\/$/, '').replace(/\.js$/, '');
  if (path === '/api' || path.startsWith('/api/')) {
    const handler = createApiHandlers(env)[path];
    return handler
      ? invokeNodeHandler(request, handler)
      : jsonError(404, 'API endpoint not found.');
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const route = resolvePageRoute(url);
    if (route?.redirect) {
      // These pages read slug/view from the browser URL, so make the query
      // visible to the client instead of hiding it in a server-only rewrite.
      return new Response(null, { status: 307, headers: { Location: route.url.pathname + route.url.search, 'Cache-Control': 'no-store' } });
    }
    if (route) return env.ASSETS.fetch(new Request(route.url, request));
  }
  return env.ASSETS.fetch(request);
}

export async function runScheduled(event, env, dependencies = {}) {
  // Preview deploys must not start a second copy of production delivery jobs.
  if (env.COURTLY_SCHEDULED_JOBS_ENABLED !== 'true') return;
  const job = schedules.find(row => row.schedule === event.cron);
  if (!job) throw new Error('Unknown Courtly cron schedule.');
  if (!env.CRON_SECRET) throw new Error('Courtly cron secret is not configured.');
  const now = dependencies.now || Date.now;
  const timestamp = String(Math.floor(now() / 1000));
  const signature = createHmac('sha256', env.CRON_SECRET)
    .update(`courtly-cron:${timestamp}:${job.path}`).digest('hex');
  const request = new Request('https://courtly.internal' + job.path, {
    headers: { 'x-courtly-cron-timestamp': timestamp, 'x-courtly-cron-signature': signature }
  });
  const handlers = dependencies.handlers || createApiHandlers(env);
  const response = await invokeNodeHandler(request, handlers[job.path]);
  // Report only status, never provider bodies, customer data, or secrets.
  if (!response.ok) throw new Error(`Courtly scheduled delivery failed (${response.status}).`);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      console.error('Courtly Worker request failed.');
      return jsonError(503, 'Courtly is temporarily unavailable. Please try again.');
    }
  },
  async scheduled(event, env, context) {
    const task = runScheduled(event, env);
    context.waitUntil(task);
    await task;
  }
};
