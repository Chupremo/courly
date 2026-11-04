# Courtly Earnings – 5-tab and Fit Layout Update

## Changes
- Earnings page now has five tabs: **7 Days**, **30 Days**, **1 Year**, **Court Rental**, and **Open Play Earnings**.
- The default view is **7 Days**, so the most recent period is visible immediately.
- Court Rental retains the confirmed/completed booking totals and ledger for the selected period.
- Open Play Earnings has its own registration, confirmed-payment, awaiting-verification, revenue, and receipt-review area.
- The Open Play review list is loaded again when the owner switches to the Earnings page/tab.
- Owner portal content can use up to 1600px of width.
- Reservation tables no longer force a horizontal scrollbar. At medium/narrow widths, rows with actions switch to compact cards so action buttons remain visible without scrolling sideways.
- Confirmed/completed statuses continue to use the green status styling.

## Notes
- This update changes the owner portal presentation and client-side view behavior. Existing Supabase SQL functions and database records are retained.
- The existing booking demo/localStorage architecture is not replaced by this UI update.
