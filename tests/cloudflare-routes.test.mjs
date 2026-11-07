import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageRoute } from '../cloudflare/routes.mjs';

test('nested login and dashboard routes serve the correct assets without redirect loops', () => {
  for (const [source, target] of [
    ['/player/login', '/player-login'],
    ['/club/dashboard', '/club-dashboard'],
    ['/coach/dashboard', '/coach-portal'],
    ['/coach-terms', '/coach-owner-terms']
  ]) {
    const route = resolvePageRoute('https://courtly.test' + source + '?next=booking');
    assert.equal(route.url.pathname, target);
    assert.equal(route.url.searchParams.get('next'), 'booking');
    assert.equal(route.redirect, false);
  }
});

test('dynamic aliases expose route parameters to the browser while preserving booking query data', () => {
  const venue = resolvePageRoute('https://courtly.test/v/my-court?checkout=hold-123');
  assert.equal(venue.url.pathname, '/venue');
  assert.equal(venue.url.searchParams.get('slug'), 'my-court');
  assert.equal(venue.url.searchParams.get('checkout'), 'hold-123');
  assert.equal(venue.redirect, true);
  const coach = resolvePageRoute('https://courtly.test/coach/jane');
  assert.equal(coach.url.searchParams.get('slug'), 'jane');
  const view = resolvePageRoute('https://courtly.test/player/dashboard/discover?mode=openplay&view=home');
  assert.equal(view.url.searchParams.get('view'), 'discover');
  assert.equal(view.url.searchParams.get('mode'), 'openplay');
});

test('dashboard default does not replace an explicitly selected view', () => {
  assert.equal(resolvePageRoute('https://courtly.test/player/dashboard').url.searchParams.get('view'), 'home');
  assert.equal(resolvePageRoute('https://courtly.test/player/dashboard?view=profile').url.searchParams.get('view'), 'profile');
});

test('route parameters cannot inject extra query parameters', () => {
  const route = resolvePageRoute('https://courtly.test/v/my-court&checkout=other');
  assert.equal(route.url.searchParams.get('slug'), 'my-court&checkout=other');
  assert.equal(route.url.searchParams.has('checkout'), false);
  assert.equal(resolvePageRoute('https://courtly.test/v/%E0%A4%A'), null);
});

test('unknown routes and API paths are not rewritten to the home page', () => {
  for (const path of ['/missing-page', '/api/receipts/issue', '/v/', '/coach/jane/extra']) {
    assert.equal(resolvePageRoute('https://courtly.test' + path), null);
  }
});
