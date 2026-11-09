import { createHmac } from 'node:crypto';
import { invokeNodeHandler } from './api-adapter.mjs';
import { createApiHandlers } from './api-routes.mjs';
import { resolvePageRoute, schedules } from './routes.mjs';


function shareMetadata(url) {
  const path = url.pathname.replace(/\/$/, '') || '/';
  const coachSlug = url.searchParams.get('coach') || '';
  const coachName = coachSlug
    ? coachSlug.split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
    : '';
  const defaults = {
    title: 'Courtly Philippines',
    description: 'Find courts, book games, join Open Play, discover coaches and play more with Courtly Philippines.'
  };
  const map = [
    [/^\/coach-booking$/, {
      title: coachName ? 'Book ' + coachName + ' | Courtly' : 'Book a Coaching Session | Courtly',
      description: 'View coach availability, choose a session time and book coaching through Courtly Philippines.'
    }],
    [/^\/coach(?:\/|$)/, {
      title: coachName ? coachName + ' | Courtly' : 'Courtly Coaches',
      description: 'Discover verified coaches, view coaching details and book sessions through Courtly.'
    }],
    [/^\/coaches$/, {
      title: 'Find a Coach | Courtly',
      description: 'Browse coaches by sport, location and availability, then book your session online.'
    }],
    [/^\/players?$/, {
      title: 'Courtly Players',
      description: 'Discover nearby courts, players, games and Open Play sessions with Courtly Philippines.'
    }],
    [/^\/business$/, {
      title: 'List Your Court | Courtly',
      description: 'Manage bookings, availability and payments with Courtly. Start your court owner trial.'
    }],
    [/^\/v\//, {
      title: 'Book a Court | Courtly',
      description: 'View court availability and reserve your next game through Courtly Philippines.'
    }],
    [/^\/community$/, {
      title: 'Courtly Community',
      description: 'See local games, activities and community updates from Courtly players.'
    }],
    [/^\/$/, defaults]
  ];
  const selected = map.find(([pattern]) => pattern.test(path))?.[1] || defaults;
  const canonical = new URL(url.toString());
  canonical.protocol = 'https:';
  canonical.hostname = 'www.courtlyph.com';
  canonical.hash = '';
  return {
    ...selected,
    url: canonical.toString(),
    image: 'https://www.courtlyph.com/assets/courtly-logo.png?v=share-20261109'
  };
}

function addShareMetadata(response, requestUrl) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  const meta = shareMetadata(requestUrl);
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(
          '<meta property="og:site_name" content="Courtly Philippines">' +
          '<meta property="og:type" content="website">' +
          '<meta property="og:title" content="' + meta.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
          '<meta property="og:description" content="' + meta.description.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
          '<meta property="og:url" content="' + meta.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
          '<meta property="og:image" content="' + meta.image + '">' +
          '<meta property="og:image:secure_url" content="' + meta.image + '">' +
          '<meta property="og:image:type" content="image/png">' +
          '<meta name="twitter:card" content="summary">' +
          '<meta name="twitter:title" content="' + meta.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
          '<meta name="twitter:description" content="' + meta.description.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
          '<meta name="twitter:image" content="' + meta.image + '">' +
          '<link rel="canonical" href="' + meta.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">',
          { html: true }
        );
      }
    })
    .transform(response);
}

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
    if (route) {
      const response = await env.ASSETS.fetch(new Request(route.url, request));
      return addShareMetadata(response, url);
    }
  }
  const response = await env.ASSETS.fetch(request);
  return addShareMetadata(response, url);
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
