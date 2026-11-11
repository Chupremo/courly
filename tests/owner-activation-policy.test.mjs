import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [business, portal, bridge, venue, adminHtml, adminJs, proposed, rollback] = await Promise.all([
  readFile(new URL('business.html', root), 'utf8'),
  readFile(new URL('owner-portal.html', root), 'utf8'),
  readFile(new URL('owner-portal-bridge.js', root), 'utf8'),
  readFile(new URL('venue.html', root), 'utf8'),
  readFile(new URL('admin-billing.html', root), 'utf8'),
  readFile(new URL('admin-billing.js', root), 'utf8'),
  readFile(new URL('supabase/operations/proposed_fee_only_owner_activation.sql', root), 'utf8'),
  readFile(new URL('supabase/operations/rollback_fee_only_owner_activation.sql', root), 'utf8')
]);

test('owner onboarding clearly presents a seven-day fee-free trial', () => {
  assert.match(business, /Start 7-day free trial/i);
  assert.match(business, /no Courtly ₱10-per-hour owner fee during the trial/i);
  assert.match(business, /After 7 days the account goes On Hold/i);
  assert.match(business, /No monthly subscription and no setup fee/i);
});

test('owner portal distinguishes trial, active, on-hold, suspended and banned states', () => {
  assert.match(portal, /7-day Courtly trial/);
  assert.match(portal, /ACCOUNT ON HOLD/);
  assert.match(portal, /Fully activated/);
  assert.match(portal, /Account suspended/);
  assert.match(portal, /ACCOUNT BANNED/);
  assert.match(portal, /Existing reservations remain available for management/);
  assert.match(bridge, /trialDaysRemaining/);
  assert.match(bridge, /activationStatus/);
});

test('trial court bookings are free and active court bookings are PHP 10 per booked hour', () => {
  assert.match(proposed, /IF v_status='trial' THEN\s+NEW\.platform_fee := 0;/);
  assert.match(proposed, /NEW\.platform_fee := 10 \* greatest\(coalesce\(NEW\.duration_hours,1\),1\)/);
  assert.match(proposed, /Bookings created during trial remain fee-free even if confirmed after activation/i);
  assert.match(venue, /10 \* \(selectedEnd - selectedStart\)/);
});

test('expired trials become on hold and cannot create new bookings', () => {
  assert.match(proposed, /activation_status='on_hold'/);
  assert.match(proposed, /courtly_expire_owner_trials/);
  assert.match(proposed, /courtly-expire-owner-trials/);
  assert.match(proposed, /This venue trial is on hold/);
  assert.match(proposed, /v_status NOT IN \('trial','active'\)/);
});

test('trial bookings bypass paid billing terms but active bookings retain them', () => {
  assert.match(proposed, /Trial is intentionally fee-free and does not require the paid billing terms/);
  assert.match(proposed, /IF v_activation_status='trial' THEN[\s\S]*?v_trial_ends_at<=clock_timestamp\(\)[\s\S]*?RETURN NEW;/);
  assert.match(proposed, /courtly_venue_terms_acceptance/);
});

test('admin console contains owner lifecycle dashboard and controls', () => {
  assert.match(adminHtml, /Owner Trials & Activation/);
  for (const status of ['Trial','On Hold','Active','Suspended','Banned']) assert.match(adminHtml, new RegExp(status));
  for (const action of ['Activate','Unsuspend','On Hold','Suspend','Return to Trial','Ban']) assert.match(adminJs, new RegExp(action));
  assert.match(adminJs, /set_courtly_owner_account_status/);
  assert.match(adminJs, /get_courtly_admin_owner_accounts/);
});

test('only Courtly admins can change lifecycle status', () => {
  assert.match(proposed, /public\.is_courtly_admin\(\)/);
  assert.match(proposed, /Courtly administrator access required/);
  assert.match(proposed, /Courtly Administration controls venue activation and account status/);
  assert.match(proposed, /set_courtly_owner_account_status/);
});

test('rollback restores original PR 27 trial states and per-hour fee path', () => {
  assert.match(rollback, /activation_status IN \('trial','active','frozen'\)/);
  assert.match(rollback, /courtly_owner_trial_open/);
  assert.match(rollback, /courtly_require_owner_terms_before_transaction/);
  assert.match(rollback, /PHP 10 per booked court-hour under the pre-proposal implementation/);
  assert.match(rollback, /Historical bookings, invoices and fee-ledger rows are not rewritten/);
});
