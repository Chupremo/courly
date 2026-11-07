# Courtly on Cloudflare Workers

Courtly is a Vite multi-page site with Supabase and five Node-style API entrypoints. This configuration deploys the existing `dist` output as Workers Static Assets and adapts the existing API handlers to the Workers request/response interface.

## Why the original deployment failed

The first `npm run build` succeeded. With no Wrangler configuration in the repository, `npx wrangler deploy` attempted automatic framework setup, added `@cloudflare/vite-plugin` to `vite.config.js`, and rebuilt. The injected ESM-only plugin failed to load through Vite's CommonJS configuration loader. The automatic setup also selected single-page routing for this multi-page site.

The explicit `wrangler.jsonc` prevents that automatic setup. Keep the existing Vite build and CommonJS API exports. No Cloudflare Vite plugin or repository-wide `"type": "module"` change is required.

## Git build settings

In Cloudflare, open **Workers & Pages → courtly → Settings → Builds**.

| Setting | Value |
| --- | --- |
| Repository | `Chupremo/courly` |
| Root directory | `/` |
| Build command | `npm run build` |
| Production deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` |
| Worker name | `courtly` — must match `wrangler.jsonc` |

Test the migration branch using a preview before merging it into the production branch. Enable Preview URLs in the Worker's **Domains** tab. The repository pins Wrangler so CI uses a known version.

The `previews` block is required for `npx wrangler preview`. This repository includes it with email delivery and scheduling disabled. Asset and Node compatibility settings remain at the top level and apply to previews too.

If the dashboard's retry action retries an old commit, start a build for the updated branch/commit instead.

## Build variables

Under **Settings → Builds → Variables and secrets**, add the appropriate values to both Production and Previews Base:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | The existing Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | The existing public anon/publishable key |
| `VITE_APP_URL` | The intended public site URL, where needed |

Vite embeds `VITE_` variables into the public browser bundle. Use only the public Supabase key here. Changes require a rebuild. Prefer a separate Supabase test project for write tests; if the preview uses the production public key, it accesses the existing production data under the same Supabase policies.

## Runtime variables and secrets

Build variables do not automatically become Worker runtime bindings. Configure backend values separately under **Settings → Runtime variables and secrets**. Use the correct Production or Previews Base scope.

| Runtime name | Type | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Text | Same project's URL |
| `SUPABASE_ANON_KEY` | Text | Public key used to verify signed-in users |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Server-only database operations |
| `RESEND_API_KEY` | Secret | Email delivery |
| `CRON_SECRET` | Secret | Existing bearer/HMAC cron authentication |
| `COURTLY_FROM_EMAIL` | Text | Verified sender address, matching the current production configuration |
| `COURTLY_APP_URL` | Text | Public URL used in generated links |
| `COURTLY_EMAIL_ENABLED` | Text | `false` during preview validation; enable when email delivery is ready |
| `COURTLY_SCHEDULED_JOBS_ENABLED` | Text | Defaults to disabled; only the exact value `true` enables scheduled execution |

The API also retains its existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` runtime fallbacks, but explicit `SUPABASE_*` bindings make the distinction clear. `COURTLY_RECEIPT_FROM` and `VITE_APP_URL` remain supported fallbacks where the existing handlers use them.

Secret values cannot be recovered from Vercel variables stored as Sensitive/Secret. Obtain them from their original provider or your credential store and enter them directly into Cloudflare. Do not put them in the repository or public build variables.

`keep_vars: true` preserves dashboard-managed plain runtime variables on deploy; secrets are managed separately by Cloudflare. For local development, use an ignored `.dev.vars` file for Worker bindings and an ignored `.env.local` for Vite build variables.

Preview runtime variables have their own configuration: put plain values in `previews.vars` and keep the generated dashboard configuration in sync with that block. New previews receive secrets from Previews Base when created. Updating Base secrets later does not update an existing preview; update that preview's secrets directly when needed. Production runtime settings are not inherited by previews.

## Routing and APIs

The existing `vercel.json` rewrite list remains the routing source of truth. Most static HTML, JavaScript, CSS and images are served directly as assets. The Worker handles the API prefix and aliases such as `/player/login`, `/coach/dashboard` and `/club/dashboard`.

Dynamic aliases preserve their parameters with a temporary redirect:

| Request | Browser destination |
| --- | --- |
| `/v/example-venue` | `/venue?slug=example-venue` |
| `/coach/example-coach` | `/coach?slug=example-coach` |
| `/player/dashboard/bookings` | `/player-dashboard?view=bookings` |
| `/player/dashboard` | `/player-dashboard?view=home` |

Checkout and other query parameters are retained. The destination query is visible to the existing page scripts. Unknown pages return 404 rather than falling back to the home page.

The Worker adapts these existing handlers:

- `/api/community-event-share`
- `/api/cron/send-billing-emails`
- `/api/notifications/process`
- `/api/receipts/issue`
- `/api/receipts/download`

Authentication, ownership checks, idempotent delivery and PDF byte responses stay in the existing backend modules. Runtime bindings are passed to each handler without changing `process.env`. The adapter accepts request bodies up to 1 MiB; court/media uploads continue through the existing direct Supabase upload flow.

## Scheduled jobs and the Free plan

There are two independent switches for scheduled delivery: `triggers.crons` is empty in the committed configuration, and the scheduled handler returns immediately unless `COURTLY_SCHEDULED_JOBS_ENABLED=true`.

For production cutover, first disable the old Vercel cron jobs so there is only one active scheduler. After verifying the new backend, add the existing UTC schedules to `wrangler.jsonc` and set the runtime flag:

```json
"triggers": {
  "crons": ["0 2 * * *", "0 3 * * *"]
}
```

| UTC schedule | Manila time | Handler |
| --- | --- | --- |
| `0 2 * * *` | 10:00 am daily | Billing email delivery |
| `0 3 * * *` | 11:00 am daily | Booking notifications |

The scheduled handler signs an internal request using the existing path-bound HMAC format. Public HTTP cron endpoints continue to require authentication.

Workers Free permits 50 external subrequests and 10 ms CPU time per invocation. Cloudflare's adapter caps delivery at **8 jobs per invocation**; a successful full notification batch uses 33 requests and billing uses 34. Existing Vercel handlers retain their 20-job default, and source-specific runs retain their lower four-job limit. Pending jobs remain pending for a later run. Monitor delivery backlog and choose an appropriate schedule before cutover; reducing the batch also reduces maximum deliveries per run.

The cap addresses the subrequest limit, not CPU usage. Measure receipt PDF generation and full delivery batches in Workers logs with safe test data before relying on the Free plan for production. Network waiting time is separate from CPU time. If the workload exceeds the CPU budget, reduce work per invocation or move that work to a suitable runtime.

## Verification

```sh
npm ci
npm test
npm run check
npm run check:cloudflare
npm run preview:cloudflare
```

`check:cloudflare` builds assets and packages the Worker without publishing. Local tests use synthetic data and do not prove production CPU usage, provider credentials, Supabase policies or email delivery.

On the preview URL, check the home page, public venue/coach pages, player/owner/club sign-in routes, dashboard views and retained checkout parameters. Confirm an unknown page is 404 and unknown `/api/*` paths return JSON 404. With dedicated test credentials/data, verify sign-in redirects, authorised receipt access/PDF downloads and delivery behaviour; do not use a cron endpoint as a harmless health check because an authenticated call can deliver queued mail.

Add the intended preview auth callback URLs to Supabase's redirect allowlist before testing OAuth or email login links. Keep the production Supabase Site URL set to the live domain until cutover.

## Domain cutover and rollback

Connect `courtlyph.com` and `www.courtlyph.com` only after the preview and backend checks pass. In Cloudflare, add each desired hostname as a Worker Custom Domain and review the corresponding DNS change. Resolve any conflicting existing CNAME as part of that deliberate cutover. Do not delete unrelated email DNS records.

Keep the prior Vercel deployment and its domain/DNS configuration available until Cloudflare is verified. If rollback is needed, restore the previous domain destination and ensure only the intended scheduler is enabled. The deployment configuration itself does not move either custom domain.

## References

- [Workers Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
