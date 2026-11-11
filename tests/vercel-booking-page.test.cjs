const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBookingPage } = require('../api/booking-page.js');

test('booking links render crawler metadata while retaining the booking app', () => {
  const html = renderBookingPage('<html><head><title>Venue</title><meta property="og:url" content="old"></head><body><script src="/assets/venue.js"></script></body></html>', 'pickle-bonn');
  assert.match(html, /Book Pickle Bonn \| Courtly/);
  assert.match(html, /content="https:\/\/www.courtlyph.com\/book\/pickle-bonn"/);
  assert.equal((html.match(/property="og:url"/g) || []).length, 1);
  assert.match(html, /src="\/assets\/venue.js"/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});
