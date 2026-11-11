import vercel from '../vercel.json' with { type: 'json' };

// Keep the existing route list as the single source of truth for both hosts.
const routes = vercel.rewrites.map(({ source, destination }) => {
  const names = [];
  const pattern = source.split('/').map(segment => {
    if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return {
    expression: new RegExp(`^${pattern}/?$`),
    names,
    destination: source === '/book/:slug' ? '/venue.html?slug=:slug' : destination,
    keepCleanUrl: source === '/book/:slug'
  };
});

export function resolvePageRoute(input) {
  const original = input instanceof URL ? input : new URL(input);
  for (const route of routes) {
    const match = route.expression.exec(original.pathname);
    if (!match) continue;
    let values;
    try {
      values = Object.fromEntries(
        route.names.map((name, index) => [
          name,
          encodeURIComponent(decodeURIComponent(match[index + 1]))
        ])
      );
    } catch {
      return null;
    }

    const destination = route.destination.replace(
      /:([A-Za-z_][\w]*)/g,
      (_, name) => values[name]
    );
    const target = new URL(destination, original.origin);
    const destinationQuery = new URLSearchParams(target.search);

    target.search = original.search;
    for (const [key, value] of destinationQuery) {
      if (route.names.length || !target.searchParams.has(key)) {
        target.searchParams.set(key, value);
      }
    }

    // ASSETS uses extensionless canonical URLs. Fetching a .html alias would
    // otherwise emit another redirect instead of serving the requested page.
    target.pathname = target.pathname.replace(/\.html$/, '');

    return {
      url: target,
      redirect: destinationQuery.size > 0 && !route.keepCleanUrl
    };
  }
  return null;
}

export const schedules = vercel.crons;
