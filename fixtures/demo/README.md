# Demo fixtures

The demo case: **"NYC trip for the Nov 13 conference, under $1,500"**, booked with the wrong date (Nov 3), and the
corrected Nov 13 bookings that the redo makes. Owner: Dhwanil.

These are generated, not hand-written. They book through the real mock merchants in `src/merchants/`, so the emails
carry the schema.org markup the merchants really send and the references are the ones they really issue.

```
npx tsx evals/demo-fixtures.ts     # rewrites this folder
```

A test (`tests/evals/demo-fixtures.test.ts`) fails if these files drift from what the generator produces.

## Files

| Path | What it is |
|---|---|
| `intent.json` | The `log_intent` input and the `Intent` it becomes (task `task_nyc`, address `task_nyc@tasks.proxy.example`) |
| `bookings-wrong.json` | What the agent booked: flight, hotel, transfer and a message to the host, all for Nov 3, with seeded times |
| `bookings-correct.json` | What the redo books: the same trip for Nov 13 to 16 |
| `wrong/actions.json`, `correct/actions.json` | The `Action[]` that capture should extract from the emails |
| `wrong/stripe-events.json`, `correct/stripe-events.json` | The `charge.succeeded` events (`StripeEventRecord[]`) |
| `wrong/emails/<id>.html`, `.txt` | The confirmation emails: `flight`, `hotel`, `transfer`, `host_email` |

## The timeline (wrong bookings)

| Booking | Booked | Captured (`received_at`) | Amount |
|---|---|---|---|
| Flight SFO to JFK, Nov 3 | 09:00 | 09:05 | $412 |
| Airport transfer, Nov 3 | 09:15 | 09:20 | $188 |
| Arrival email to the host | 09:25 | 09:30 | $0 |
| Hotel, Nov 3 to 6 | 09:10 | **11:05, late: the agent has left** | $640 |

All on Oct 17, 2026. Total at risk: **$1,240** across four things.

## Using them

- **Sarah (capture):** each `.html` has the schema.org block in `<script type="application/ld+json">`. The
  `actions.json` next to it is the answer your extractor should produce. Types: `FlightReservation`,
  `LodgingReservation`, `TaxiReservation`, and `EmailMessage` for the host message (its reference is `identifier`).
  Prices are dollar strings like `"412.00"`.
- **Karan (orchestrator and scripted agent):** `wrong/actions.json` plus `intent.json` is the whole input to
  `compare`, `trace` and `plan_undo`. The corrected set should make `compare` return nothing.
- **Dates and times are simulated.** The merchants are our mocks, not real airlines or hotels.
