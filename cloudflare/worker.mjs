import { createHmac } from 'node:crypto';
import { invokeNodeHandler } from './api-adapter.mjs';
import { createApiHandlers } from './api-routes.mjs';
import { resolvePageRoute, schedules } from './routes.mjs';


export function shareMetadata(url) {
  const path = url.pathname.replace(/\/$/, '').replace(/\.html$/, '') || '/';
  const coachSlug = url.searchParams.get('coach') || '';
  const coachName = coachSlug
    ? coachSlug.split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
    : '';

  const audience = (
    /^\/business(?:\/|$)/.test(path) ||
    /^\/court-owner(?:\/|$)/.test(path) ||
    /^\/owner(?:-|\/|$)/.test(path)
  ) ? 'owners' : (
    /^\/coaches?(?:-|\/|$)/.test(path) ||
    /^\/coach-booking(?:\/|$)/.test(path) ||
    /^\/my-coaching-sessions(?:\/|$)/.test(path)
  ) ? 'coaches' : 'players';

  const images = {
    players: 'https://www.courtlyph.com/assets/courtly-logo.png',
    coaches: 'https://www.courtlyph.com/assets/courtly-logo.png',
    owners: 'https://www.courtlyph.com/assets/courtly-logo.png'
  };

  const defaults = {
    title: 'Courtly Philippines',
    description: 'Find courts, book games, join Open Play, discover coaches and play more with Courtly Philippines.'
  };

  const map = [
    [/^\/coach-booking(?:\/|$)/, {
      title: coachName ? 'Book ' + coachName + ' | Courtly' : 'Book a Coaching Session | Courtly',
      description: 'View coach availability, choose a session time and book coaching through Courtly Philippines.'
    }],
    [/^\/coach-register(?:\/|$)/, {
      title: 'Grow Your Coaching Bookings | Courtly',
      description: 'Create your coaching profile, share your booking link and accept online session bookings.'
    }],
    [/^\/coaches?(?:\/|$)/, {
      title: coachName ? coachName + ' | Courtly' : 'Find a Coach | Courtly',
      description: 'Discover coaches, view coaching details and book sessions through Courtly Philippines.'
    }],
    [/^\/court-owner(?:\/|$)/, {
      title: 'Register Your Court | Courtly Philippines',
      description: 'List your venue, manage availability and accept court bookings with Courtly Philippines.'
    }],
    [/^\/business(?:\/|$)/, {
      title: 'Manage Your Court Bookings Online | Courtly',
      description: 'List your venue, manage calendars and confirm payments with Courtly Philippines.'
    }],
    [/^\/owner(?:-|\/|$)/, {
      title: 'Courtly for Court Owners',
      description: 'Manage venue listings, bookings, calendars and payments with Courtly Philippines.'
    }],
    [/^\/v\//, {
      title: 'Book a Court | Courtly',
      description: 'View court availability and reserve your next game through Courtly Philippines.'
    }],
    [/^\/player-register(?:\/|$)/, {
      title: 'Join Courtly Philippines',
      description: 'Create your player profile, discover nearby courts and book your next game.'
    }],
    [/^\/players?(?:\/|$)/, {
      title: 'Find Courts. Book Games. Play More. | Courtly',
      description: 'Discover nearby courts, coaches and open play with Courtly Philippines.'
    }],
    [/^\/community(?:\/|$)/, {
      title: 'Courtly Community',
      description: 'See local games, activities and community updates from Courtly players.'
    }],
    [/^\/$/, {
      title: 'Find Courts. Book Games. Play More. | Courtly',
      description: 'Discover nearby courts, coaches and open play with Courtly Philippines.'
    }]
  ];

  const selected = map.find(([pattern]) => pattern.test(path))?.[1] || defaults;
  const canonical = new URL(url.toString());
  canonical.protocol = 'https:';
  canonical.hostname = 'www.courtlyph.com';
  canonical.hash = '';
  canonical.pathname = path === '/index' ? '/' : path;
  // Tracking IDs must not create separate Facebook objects for the same page.
  // Keep identity parameters such as coach, slug and id for public profiles.
  for (const key of [...canonical.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|msclkid$)/i.test(key)) canonical.searchParams.delete(key);
  }

  return {
    ...selected,
    audience,
    url: canonical.toString(),
    image: images[audience],
    imageAlt: audience === 'owners'
      ? 'Courtly Philippines for court and venue owners'
      : audience === 'coaches'
        ? 'Courtly Philippines for coaches'
        : 'Courtly Philippines for players'
  };
}

function addShareMetadata(response, requestUrl) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const meta = shareMetadata(requestUrl);
  const escAttr = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

  return new HTMLRewriter()
    .on('meta[property^="og:"]', { element(element) { element.remove(); } })
    .on('meta[name^="twitter:"]', { element(element) { element.remove(); } })
    .on('link[rel="canonical"]', { element(element) { element.remove(); } })
    .on('head', {
      element(element) {
        element.append(
          '<meta property="og:site_name" content="Courtly Philippines">' +
          '<meta property="og:locale" content="en_PH">' +
          '<meta property="og:type" content="website">' +
          '<meta property="og:title" content="' + escAttr(meta.title) + '">' +
          '<meta property="og:description" content="' + escAttr(meta.description) + '">' +
          '<meta property="og:url" content="' + escAttr(meta.url) + '">' +
          '<meta property="og:image" content="' + escAttr(meta.image) + '">' +
          '<meta property="og:image:secure_url" content="' + escAttr(meta.image) + '">' +
          '<meta property="og:image:type" content="image/png">' +
          '<meta property="og:image:alt" content="' + escAttr(meta.imageAlt) + '">' +
          '<meta name="twitter:card" content="summary_large_image">' +
          '<meta name="twitter:title" content="' + escAttr(meta.title) + '">' +
          '<meta name="twitter:description" content="' + escAttr(meta.description) + '">' +
          '<meta name="twitter:image" content="' + escAttr(meta.image) + '">' +
          '<link rel="icon" type="image/png" href="/apple-touch-icon.png?v=20261109-repaired">' +
          '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=20261109-repaired">' +
          '<link rel="apple-touch-icon-precomposed" sizes="180x180" href="/apple-touch-icon-precomposed.png?v=20261109-repaired">' +
          '<link rel="canonical" href="' + escAttr(meta.url) + '">',
          { html: true }
        );
      }
    })
    .transform(response);
}

function withPerformanceHeaders(response, requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const headers = new Headers(response.headers);
  const type = headers.get('content-type') || '';
  const path = url.pathname;
  if (type.includes('text/html')) {
    headers.set('Cache-Control','no-cache');
  } else if (/\.(?:png|jpe?g|webp|avif|svg|ico|woff2?|ttf|otf)$/i.test(path)) {
    headers.set('Cache-Control','public, max-age=604800, stale-while-revalidate=2592000');
  } else if (/\.(?:css|js|mjs)$/i.test(path)) {
    headers.set('Cache-Control','public, max-age=3600, stale-while-revalidate=86400');
  }
  headers.set('X-Content-Type-Options','nosniff');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
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
      return withPerformanceHeaders(addShareMetadata(response, url), url);
    }
  }
  const response = await env.ASSETS.fetch(request);
  return withPerformanceHeaders(addShareMetadata(response, url), url);
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
