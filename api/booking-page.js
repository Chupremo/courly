const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderBookingPage(template, slug) {
  const name = slug.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
  const title = `Book ${name} | Courtly`;
  const description = `Check availability and book a court at ${name} through Courtly Philippines.`;
  const canonical = 'https://www.courtlyph.com/book/' + encodeURIComponent(slug);
  const image = 'https://www.courtlyph.com/assets/courtly-logo.png';
  const tags = `<meta property="og:site_name" content="Courtly Philippines">
<meta property="og:type" content="website"><meta property="og:locale" content="en_PH">
<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${image}">
<link rel="canonical" href="${escapeHtml(canonical)}">`;
  return template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta\b[^>]*(?:property=["']og:|name=["']twitter:)[^>]*>/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace('</head>', tags + '\n</head>');
}

module.exports = function bookingPage(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD'); res.statusCode = 405; return res.end();
  }
  const slug = typeof req.query?.slug === 'string' ? req.query.slug : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug) || slug.length > 200) {
    res.statusCode = 404; return res.end('Venue not found.');
  }
  try {
    const html = renderBookingPage(readFileSync(join(process.cwd(), 'dist/venue.html'), 'utf8'), slug);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.statusCode = 200;
    return res.end(req.method === 'HEAD' ? undefined : html);
  } catch {
    res.statusCode = 503; return res.end('Courtly booking page is temporarily unavailable.');
  }
};
module.exports.renderBookingPage = renderBookingPage;
