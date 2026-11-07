import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [business, portal, bridge, venue, proposed, rollback] = await Promise.all([
  readFile(new URL('business.html', root), 'utf8'),
  readFile(new URL('owner-portal.html', root), 'utf8'),
  readFile(new URL('owner-portal-bridge.js', root), 'utf8'),
  readFile(new URL('venue.html', root), 'utf8'),
  readFile(new URL('supabase/operations/proposed_fee_only_owner_activation.sql', root), 'utf8'),
  readFile(new URL('supabase/operations/rollback_fee_only_owner_activation.sql', root), 'utf8')
]);

test('owner onboarding has no seven-day expiry or trial CTA', () => {
  assert.doesNotMatch(business, /Start 7-day free trial|workspace becomes read-only|trial starts/i);
  assert.match(business, /No monthly subscription and no setup fee/i);
  assert.match(business, /₱10 per completed court-booking transaction/i);
});

test('pending or suspended activation does not freeze the owner workspace', () => {
  assert.doesNotMatch(portal, /trialFrozen|applyTrialLock|function trialBanner/);
  assert.doesNotMatch(bridge, /trialFrozen|7-day Courtly trial has ended/);
  assert.match(portal, /Venue verification pending/);
  assert.match(portal, /manage existing reservations, payment confirmations, availability and billing/i);
  assert.match(bridge, /bookingActivationReady/);
});

test('court-rental fee is flat PHP 10 instead of duration-based', () => {
  assert.match(venue, /function platformFee\(\) \{ return selectedRangeIso\(\) \? 10 : 0; \}/);
  assert.doesNotMatch(venue, /10 \* \(selectedEnd - selectedStart\)/);
  assert.match(proposed, /NEW\.platform_fee := 10;/);
  assert.match(proposed, /BEFORE INSERT ON public\.bookings/);
  assert.match(proposed, /payment_status IN \('unpaid','awaiting_verification'\)/);
});

test('activation gates public booking availability rather than owner management', () => {
  assert.match(proposed, /activation_status SET DEFAULT 'pending'/);
  assert.match(proposed, /is_published SET DEFAULT false/);
  assert.match(proposed, /activation_status IN \('pending','active','suspended'\)/);
  assert.match(proposed, /CREATE POLICY "Owners can update own venues"/);
  assert.match(proposed, /USING \(owner_id=auth\.uid\(\)\)/);
  assert.match(proposed, /Courtly verification controls venue activation and public publishing/);
  assert.match(proposed, /public\.set_courtly_venue_activation/);
  assert.match(proposed, /Courtly administrator access required/);
});

test('transition grandfathers existing owner venues and preserves historical billable fees', () => {
  assert.match(proposed, /WHEN owner_id IS NOT NULL THEN 'active'/);
  assert.match(proposed, /does NOT rewrite confirmed, completed or invoiced history/i);
  assert.doesNotMatch(proposed, /SET platform_fee=10[\s\S]*status='confirmed'/);
});

test('rollback removes activation gate without restoring a timed trial', () => {
  assert.match(rollback, /DROP TRIGGER IF EXISTS courtly_guard_venue_activation_state/);
  assert.match(rollback, /activation_status SET DEFAULT 'active'/);
  assert.match(rollback, /is_published SET DEFAULT true/);
  assert.match(rollback, /does NOT rewrite historical booking fees/i);
  assert.doesNotMatch(rollback, /interval '7 days'/i);
});
