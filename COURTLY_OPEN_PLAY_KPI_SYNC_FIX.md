# Courtly Open Play KPI Synchronization Fix

## What changed
- Open Play metrics are retained as canonical JavaScript state instead of being read only from temporary dashboard DOM nodes.
- Re-rendering the owner portal no longer resets Open Play confirmed count and revenue to zero when the Open Play earnings tab is not active.
- The Open Play transaction loader is refreshed after portal view renders, including the Overview court-rental view.
- Demo payment review actions continue to update browser-local demo records only; real owner records continue to use authenticated Supabase RPC calls.

## Expected calculation
- Court & Open Play Gross = confirmed court-rental gross + confirmed Open Play fees.
- Transaction Fee = confirmed court-rental hours × ₱10 per hour.
- Owner Net Earnings subtract only owner-paid court rental fees and historical owner-paid Open Play fees. New player-paid Open Play transaction fees are tracked separately as remittance due, not deducted from venue registration revenue.
- Pending and rejected Open Play payments are excluded from confirmed Open Play revenue.

## Deployment
Replace the project files with this ZIP, commit and push to the production branch, then wait for Vercel to finish deployment. Hard-refresh the demo portal after deployment.

## Important
This update fixes client-side state synchronization. It does not migrate court rental records from browser localStorage into Supabase or alter real payment records.
