import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runScheduled, shareMetadata } from '../cloudflare/worker.mjs';
import backend from '../server/courtly-backend.cjs';

const NOW = Date.parse('2026-11-07T02:00:00Z');
const ENV = {
  COURTLY_SCHEDULED_JOBS_ENABLED: 'true',
  CRON_SECRET: 'fictional-scheduler-secret-do-not-log'
};
const jobs = [
  { cron: '0 2 * * *', path: '/api/cron/send-billing-emails' },
  { cron: '0 3 * * *', path: '/api/notifications/process' }
];

test('scheduled delivery stays disabled unless explicitly enabled as a string', async () => {
  for (const flag of [undefined, 'false', false, true, '']) {
    const env = flag === undefined ? {} : { COURTLY_SCHEDULED_JOBS_ENABLED: flag };
    const dependencies = {
      now: () => assert.fail('Disabled jobs must not start work.'),
      get handlers() { return assert.fail('Disabled jobs must not construct or invoke handlers.'); }
    };
    await runScheduled({ cron: jobs[0].cron }, env, dependencies);
    // A disabled preview must also ignore an old or unknown trigger safely.
    await runScheduled({ cron: 'unknown-preview-trigger' }, env, dependencies);
  }
});

test('each configured schedule dispatches only its matching handler with a valid path-bound signature', async () => {
  for (const expected of jobs) {
    const calls = [];
    const handlers = Object.fromEntries(jobs.map(job => [job.path, async (req, res) => {
      calls.push(job.path);
      assert.equal(job.path, expected.path);
      assert.equal(req.method, 'GET');
      assert.equal(req.url, expected.path);
      assert.equal(Object.keys(req.query).length, 0);
      const timestamp = String(Math.floor(NOW / 1000));
      const signature = createHmac('sha256', ENV.CRON_SECRET)
        .update(`courtly-cron:${timestamp}:${expected.path}`).digest('hex');
      assert.equal(req.headers['x-courtly-cron-timestamp'], timestamp);
      assert.equal(req.headers['x-courtly-cron-signature'], signature);
      assert.equal(req.headers.authorization, undefined);
      assert.ok(!JSON.stringify(req.headers).includes(ENV.CRON_SECRET));
      // Validate the generated request with the existing API authentication code.
      assert.doesNotThrow(() => backend.requireCron(req, ENV, expected.path, () => NOW));
      const other = jobs.find(candidate => candidate.path !== expected.path);
      assert.throws(() => backend.requireCron(req, ENV, other.path, () => NOW), { code: 'UNAUTHORIZED' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
    }]));
    await runScheduled({ cron: expected.cron }, ENV, { now: () => NOW, handlers });
    assert.deepEqual(calls, [expected.path]);
  }
});

test('enabled schedules reject an unknown cron before dispatch', async () => {
  await assert.rejects(runScheduled({ cron: '* * * * *' }, ENV, {
    get handlers() { return assert.fail('Unknown schedules must not access a handler.'); }
  }), { message: 'Unknown Courtly cron schedule.' });
});

test('enabled schedules require a cron secret before dispatch', async () => {
  await assert.rejects(runScheduled({ cron: jobs[0].cron }, {
    COURTLY_SCHEDULED_JOBS_ENABLED: 'true'
  }, {
    get handlers() { return assert.fail('Missing credentials must not access a handler.'); }
  }), { message: 'Courtly cron secret is not configured.' });
});

test('failed scheduled responses report only status and do not expose provider content', async () => {
  const privateBody = `Provider failure for customer@example.test using ${ENV.CRON_SECRET}`;
  await assert.rejects(runScheduled({ cron: jobs[0].cron }, ENV, {
    now: () => NOW,
    handlers: {
      [jobs[0].path]: async (_req, res) => {
        res.statusCode = 503;
        res.end(privateBody);
      }
    }
  }), error => {
    assert.equal(error.message, 'Courtly scheduled delivery failed (503).');
    assert.ok(!error.message.includes(ENV.CRON_SECRET));
    assert.ok(!error.message.includes('customer@example.test'));
    return true;
  });
});

test('unexpected handler errors fail the schedule without logging sensitive exception contents', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  await assert.rejects(runScheduled({ cron: jobs[1].cron }, ENV, {
    now: () => NOW,
    handlers: {
      [jobs[1].path]: async () => {
        throw new Error(`Provider exception containing ${ENV.CRON_SECRET}`);
      }
    }
  }), { message: 'Courtly scheduled delivery failed (500).' });
  assert.ok(!JSON.stringify(logs).includes(ENV.CRON_SECRET));
  assert.ok(!JSON.stringify(logs).includes('Provider exception'));
});


test('Facebook canonical URLs remove tracking but keep the selected coach or event', () => {
  const coach = shareMetadata(new URL('https://www.courtlyph.com/coach-booking.html?coach=coach-jayar&fbclid=tracking&utm_source=facebook#booking'));
  assert.equal(coach.url, 'https://www.courtlyph.com/coach-booking?coach=coach-jayar');
  assert.equal(coach.title, 'Book Coach Jayar | Courtly');
  const event = shareMetadata(new URL('https://www.courtlyph.com/community-event?id=event-123&utm_campaign=share'));
  assert.equal(event.url, 'https://www.courtlyph.com/community-event?id=event-123');
  assert.equal(shareMetadata(new URL('https://www.courtlyph.com/index.html')).url, 'https://www.courtlyph.com/');
});
