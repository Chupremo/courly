# Courtly Hybrid Fee Policy — Implementation & Operations

## Official fee rules

- **Court rental:** PHP 10 per successful court-booking transaction, regardless of booking duration. The venue owner pays this fee. It is billed/remitted separately and is not added to the player’s court checkout.
- **Paid Open Play:** PHP 10 transaction fee per paid registration. It is added on top of the event’s registration amount and paid by the player.
- **Free Open Play:** PHP 0 transaction fee. No receipt is required and the registration is confirmed immediately.
- No monthly subscription, setup fee, or upfront platform charge.

## Important payment-collection detail

Courtly currently instructs players to pay through the venue’s own GCash QR. For paid Open Play, the player therefore sends the full amount (event registration + PHP 10 transaction fee) to the venue. The venue collects the PHP 10 on Courtly’s behalf. The system records this as a separate remittance balance; it does **not** automatically transfer funds to Courtly. The venue must remit this amount using the agreed billing process.

Court rental platform fees are different: they are the venue owner’s own obligation and are deducted from court-rental earnings. The owner dashboard’s **Courtly Fees to Remit** combines (a) owner-paid court-rental fees and (b) player-paid Open Play transaction fees collected via the venue QR, plus any historical owner-paid Open Play fees retained from before this policy.

## Checkout examples

### Paid Open Play

| Description | Amount |
|---|---:|
| Event registration | PHP 150.00 |
| Transaction fee (paid by player) | PHP 10.00 |
| **Player pays via venue QR** | **PHP 160.00** |
| Venue registration revenue | PHP 150.00 |
| Player transaction fee held for Courtly | PHP 10.00 |

### Free Open Play

| Description | Amount |
|---|---:|
| Event registration | PHP 0.00 |
| Transaction fee | PHP 0.00 |
| **Player pays** | **PHP 0.00** |

### Court rental

| Description | Amount |
|---|---:|
| Court rate | PHP 350/hour |
| Booking duration | 2 hours |
| Player pays venue | PHP 700.00 |
| Venue owner’s Courtly Convenience Fee | PHP 10.00 |
| **Owner net before other expenses** | **PHP 690.00** |

## Database behavior

Migration `005_hybrid_courtly_fee_policy.sql` adds `transaction_fee_payer` and a generated `player_total`. Existing registrations default to `venue_owner` to preserve historical treatment. New paid registrations are recorded as `player`; new free registrations are recorded as `none`. The server-side registration RPC determines the event price and fee—it does not trust a client-supplied price. Free registrations do not require a receipt.

The migration also updates owner reporting RPCs. It does not replace the payment-review RPC, disable RLS, or modify the existing court-rental platform-fee calculation.

## Deployment order

1. Back up the existing Supabase database.
2. Run `supabase/migrations/005_hybrid_courtly_fee_policy.sql` once in Supabase SQL Editor.
3. Deploy the updated website source to Vercel.
4. Test a paid Open Play event priced at PHP 150: checkout must show PHP 150 + PHP 10 = PHP 160.
5. Test a free Open Play event: PHP 0 total, no receipt field, immediate confirmation.
6. Confirm an Open Play payment as the venue owner; verify registration revenue remains PHP 150, player transaction fees show PHP 10 to remit, and venue Open Play net remains PHP 150.
7. Test a two-hour court rental at PHP 350/hour: player pays PHP 700 and the owner Convenience Fee is PHP 10.
8. Verify repeated payment confirmation does not create a second fee or transaction.

## Important limitation

The current GCash QR flow is a manual payment-verification model. It does not automatically split the player’s transfer between the venue and Courtly. The dashboard can calculate the remittance due, but actual settlement must follow the agreed invoice/remittance process.
