# Booking notifications and receipt delivery

## What this release changes

Migration `202611060006_notification_delivery.sql` adds a private database outbox. Court bookings, coaching bookings and Open Play registrations create notification events in the same transaction as payment-proof submission, payment confirmation, rejection, cancellation or refund status changes. Unpaid checkout holds and their expiry do not generate reservation emails.

Paid confirmations create one immutable payment receipt per source. Court receipts use the stored player total, coaching receipts use the session subtotal, and Open Play receipts use `player_total` including a player-paid Convenience Fee. Free registrations get a confirmation message without a payment receipt. A receipt remains downloadable even if email delivery is paused or unavailable.

Venue preferences affect owner alerts: `notify_email` is the master switch, `notify_pending` controls payment-proof review alerts, and `notify_cancelled` controls cancellation/refund alerts. Transactional player acknowledgements and receipts are independent of owner preferences.

No application migration sends an email. Only an activated server worker sends through the configured provider. Existing Supabase invoice-generation and overdue-enforcement jobs remain responsible for billing policy; the repaired billing HTTP route queues and delivers notices, and suppresses settled or obsolete reminders.

## Required server configuration

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` or existing `VITE_SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Private server database access. Never use a `VITE_` prefix. |
| `SUPABASE_ANON_KEY` or existing `VITE_SUPABASE_ANON_KEY` | Verify the caller’s Supabase session. |
| `RESEND_API_KEY` | Private mail-provider credential. |
| `COURTLY_FROM_EMAIL` | Verified sending identity, such as the configured Courtly identity on its verified domain. There is no invented fallback sender. |
| `COURTLY_RECEIPT_FROM` | Optional separate verified receipt sender; otherwise uses `COURTLY_FROM_EMAIL`. |
| `COURTLY_EMAIL_ENABLED` | Must equal `true` to send. Omit or set `false` to pause all provider requests while preserving queued work. |
| `CRON_SECRET` | A new random secret, at least 32 characters, shared between Vercel and the dedicated Vault entry. |
| `COURTLY_APP_URL` or `VITE_APP_URL` | Optional canonical origin for email links; default is `https://www.courtlyph.com`. |

Changing a Vercel environment variable requires deployment of the corresponding environment. Preview/staging should use its own database/provider configuration or leave mail disabled. Never run customer delivery tests by pointing a local test process at production credentials.

## Activation sequence

1. Finish the deployment and database rehearsal with mail disabled. Apply the payment-receipt prerequisite and notification migration to the intended database, after the existing booking, player-account and billing migrations. The new migration does not require the hold migration to compile; checkout readiness should separately require both feature readiness checks.
2. Confirm `courtly_notification_readiness()` returns `version: 1` and `ready: true`. This is a schema check, not a claim that a sender or scheduler is configured.
3. Configure the verified sender, provider key, server database keys and newly generated `CRON_SECRET`. Inspect existing queued work before activating delivery. Legacy `processing` or failed email attempts had no provider idempotency key and are intentionally marked `needs_review`; migration does not resend them blindly.
4. Deploy the new handlers. Avoid running the old receipt sender against the new outbox during rollout: it did not use provider idempotency keys. Both new handlers default to paused unless explicitly enabled.
5. Run the protected read-only checks below. They return schema/configuration state without claiming work, generating notices, or sending email.
6. Store the new cron secret in Supabase Vault as `courtly_delivery_cron_secret`, then apply the separately reviewed operator template `supabase/operations/enable-delivery-cron.sql`. Its manual function defaults to health-check mode. Its two scheduled jobs explicitly select processing mode.
7. Enable `COURTLY_EMAIL_ENABLED=true` in the intended deployed environment when delivery is approved. Check worker HTTP results and queue outcomes. No test should send to an actual customer without coordination.

## Routes and immediate dispatch

| Route | Method and authorization | Behavior |
| --- | --- | --- |
| `/api/notifications/process` | `POST`, Supabase user bearer token | Authorizes the player, venue owner or coach for the supplied source; reconciles its outbox; processes only that source. |
| `/api/notifications/process` | `GET`, cron authorization | Processes due booking notification and receipt jobs. |
| `/api/cron/send-billing-emails` | `GET`, cron authorization | Queues billing notices and processes due billing jobs. Does not generate invoices a second time. |
| Either cron route with `?check=1` | `GET`, cron authorization | Read-only schema and email configuration check. |
| `/api/receipts/issue` | `POST`, Supabase user bearer token | Compatible receipt endpoint, including paid Open Play; returns the existing receipt and its actual delivery state. |
| `/api/receipts/download?id=…` | `GET`, receipt owner’s Supabase bearer token | Downloads the saved receipt PDF with private/no-store caching. |

The source body is `{ "type": "court_booking", "id": "SOURCE_UUID" }`. Other supported types are `open_play_registration` and `coaching_booking`. Recipients, amounts and message content come from saved database records; the API does not accept client-supplied email content or addresses.

Call immediate dispatch after the booking/payment RPC commits. A mail error must not undo the saved payment or invite a second booking. The shared browser helper bounds the request, catches failures and distinguishes sent, queued, paused and needs-review states. An HTTP 202 response means work remains. Provider acceptance is recorded as `sent`; it is not a guarantee that the message reached the recipient’s inbox.

## Scheduled retries

The Vercel Hobby-compatible daily schedules are fallbacks: billing at `0 2 * * *` and notifications at `0 3 * * *`, both UTC. A daily job alone is insufficient for predictable retry recovery within the provider’s 24-hour deduplication window.

The optional Supabase operator template uses the existing `pg_cron`, `pg_net` and Vault capabilities for booking delivery every 10 minutes and billing delivery every 15 minutes. It leaves all invoice and enforcement schedules intact. No subscription upgrade or extra always-on server is required by the implementation.

Vercel invocations use `Authorization: Bearer CRON_SECRET`. Supabase invocations use a five-minute HMAC-SHA256 signature over the timestamp and exact worker path, including health-check mode. Only the signature enters `pg_net` request headers. The Vault secret is never embedded in `cron.job.command`, a URL, the repository or a queued HTTP header. The SQL function has fixed destination paths and is executable only by its administrative owner.

Supabase documents that database login roles can read `pg_net` request headers, and its default grants cannot reliably be revoked by a project. Keep `net` and `vault` out of the exposed Data API schemas and restrict database login roles to trusted services. A queued short-lived signature can be replayed only within its validity window and only to its signed route; database claims and provider idempotency still prevent a second email.

## Claims, retries and ambiguous outcomes

Each worker claims one job at a time with `FOR UPDATE SKIP LOCKED`, a unique lease token and a two-minute lease. A crashed invocation can be reclaimed after expiry. An old worker cannot acknowledge a newer worker’s lease.

Before the provider request, the full email payload, including any PDF attachment, is persisted. Retries use that identical payload and the stable `courtly-delivery/JOB_UUID` idempotency key. This also handles the case where the provider accepted an email but the database acknowledgement was lost. Retries use increasing delays, with a maximum of eight claims. The scheduler executes those due retries; timestamps alone do not run a worker.

The provider retains idempotency keys for 24 hours. Automatic sends stop after 23 hours from the first prepared attempt, leaving a safety margin. Permanent provider errors, exhausted attempts and ambiguous legacy deliveries become `needs_review`. Do not reset these jobs or invent a new idempotency key to bypass the review state.

For a needs-review job, an operator should first inspect its private database record and the provider’s delivery log using the receipt number, message ID if available and event timestamp. If the provider confirms acceptance, reconcile the job and associated receipt/billing event as sent in one transaction. Only if the provider confirms no message was accepted should an operator deliberately reopen the job for a new attempt. Correct an invalid recipient/sender before that action. Do not treat an empty client response as proof that no email was sent.

## Read-only operating checks

Use an authorized environment for the following checks. Do not print secrets or queue request headers.

```sql
select public.courtly_notification_readiness();

select category,status,count(*) as jobs,min(created_at) as oldest
from public.courtly_delivery_jobs
group by category,status order by category,status;

select jobname,schedule,active
from cron.job
where jobname in ('courtly-notification-delivery','courtly-billing-email-delivery');

select r.kind,r.health_check,r.queued_at,h.status_code,h.timed_out,h.error_msg,h.content
from public.courtly_delivery_cron_runs r
left join net._http_response h on h.id=r.request_id
order by r.queued_at desc limit 20;
```

Worker 401 responses indicate a secret/signature or clock problem; 503 responses distinguish missing migration, paused mail and missing configuration. A successful invocation can still report retries or needs-review jobs. Monitor both HTTP status and queue counts. `pg_net` HTTP responses are retained for a limited period, so inspect failures promptly; the application keeps its small request-ID ledger for seven days.

## Local verification

The runtime tests use mocked database/provider calls and never send email:

```sh
node --test tests/notification-delivery.test.cjs
```

The SQL tests use an optional isolated PostgreSQL runtime installed outside production dependencies:

```sh
COURTLY_TEST_PGLITE_PATH=/absolute/path/to/@electric-sql/pglite \
  node --test tests/notification-schema.test.cjs tests/notification-cron.test.cjs
```

They apply and reapply the real migration, exercise atomic triggers, confirm paid/free Open Play totals, owner preference semantics, role restrictions, stale leases, immutable provider payloads and expired deduplication protection. The scheduler test executes the real signing function with PostgreSQL `pgcrypto` and a capture-only HTTP stub; it makes no network request.

## References

- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Vercel cron operation and authorization](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Supabase scheduling functions with Vault](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
- [Supabase pg_net queued-header permissions](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)
