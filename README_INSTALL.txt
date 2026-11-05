COURTLY PLAYER NETWORK + COMMUNITY PATCH

IMPORTANT: This is a targeted patch, not a full repository replacement.
It preserves your existing recent billing, booking, venue-image and brand fixes.

1) Back up the current Supabase project.
2) Apply supabase/migrations/011_player_network_and_community.sql once in Supabase SQL Editor.
3) Copy the listed root-level files into the existing GitHub courly repository:
   - player-register.html
   - player-dashboard.html
   - player-dashboard.js
   - player-social.css
   - community.html
   - community.js
   - community.css
   - owner-portal.html
   - vite.config.js
   - vercel.json
4) Preserve the supabase/migrations folder and add migration 011.
5) Commit and push to main; let Vercel deploy.
6) Complete the tests in COURTLY_PLAYER_NETWORK_COMMUNITY_SETUP.md.

No new environment variables are required. This patch does not modify booking,
Open Play fee, invoice or owner billing tables. The SQL migration has not been
executed against your live Supabase database. Full Vite production build has
not been run in this environment because node_modules are not installed and
npm network access was not available.
