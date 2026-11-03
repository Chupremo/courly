# Courtly demo venues and courts

The player directory reads venue and court records from Supabase. This project includes fictional demo listings so you can test the directory before real businesses register.

## Add the demo listings

1. Open your Courtly Supabase project.
2. Go to **SQL Editor** and choose **New query**.
3. Open `supabase/demo-seed.sql` from this project and copy its full contents.
4. Paste the SQL into the editor and click **Run**.
5. Open `/players.html` on your deployed Courtly site and refresh. You should see three demo venues and six active courts.

The demo venues are labelled `DEMO` in their names. They are fictional examples in Lipa City, Batangas, and are not actual businesses or confirmed bookable facilities. The listed hourly rates are sample values only.

## Demo listings included

| Demo venue | Sample courts | Sample rates |
|---|---|---:|
| DEMO · Lipa Pickleball Hub | Pickleball Court 1 and 2 | ₱350/hr each |
| DEMO · Batangas Racquet Club | Badminton Court 1 and 2 | ₱250/hr each |
| DEMO · Southside Sports Center | Covered Basketball Court; Multi-purpose Court (Volleyball) | ₱800/hr; ₱500/hr |

## Remove demo data

At the bottom of `supabase/demo-seed.sql`, there is a commented-out `DELETE` statement. If you later want to remove the sample venues, copy that statement into Supabase SQL Editor, remove the leading `--` comment markers, and run it. Deleting a venue also deletes its courts because of the schema's `ON DELETE CASCADE` relationship.

The seed script does not create owner accounts, bookings, payments, or real availability. It only creates sample venue and court records for directory display.
