# Orders and Settlements

Create orders with line items, record full or partial payments against them, and track what is still owed.

**Live demo:** _<add your deployed URL here>_
**Demo login:** `demo@example.com` / `demo-password-123` (created by `npm run seed`)

---

## Contents

- [Stack](#stack)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [API overview](#api-overview)
- [Status derivation rules](#status-derivation-rules)
- [Edge cases](#edge-cases)
- [Concurrency](#concurrency)
- [Assumptions and tradeoffs](#assumptions-and-tradeoffs)
- [Testing](#testing)
- [What I would do before production](#what-i-would-do-before-production)

---

## Stack

| Layer    | Choice                                   | Why |
| -------- | ---------------------------------------- | --- |
| Framework| Next.js 16 (App Router, TypeScript)      | One deployable for API and UI |
| Database | MongoDB + Mongoose 9                     | The order is a natural document aggregate — see [Concurrency](#concurrency) |
| Auth     | JWT in an httpOnly cookie (`jose`, `bcryptjs`) | No third-party dependency for a two-endpoint requirement |
| UI       | Tailwind CSS v4                          | — |
| Tests    | Vitest + `mongodb-memory-server`         | Integration tests run against a real MongoDB, no install needed |

---

## Quick start

**Prerequisites:** Node.js 20.9+ (developed on 24). No database install required.

```bash
npm install
cp .env.example .env.local
```

Set `AUTH_SECRET` in `.env.local` to a random 32+ character string:

```bash
openssl rand -base64 32
```

Then, in one terminal, start a throwaway local MongoDB (downloads a real `mongod` on first run — no Docker, no system install):

```bash
npm run dev:db
```

And in a second terminal:

```bash
npm run seed && npm run dev
```

Open http://localhost:3000 and sign in with `demo@example.com` / `demo-password-123`.

> Already have MongoDB running, or using Atlas? Skip `npm run dev:db` and point `MONGODB_URI` at it instead.

### Scripts

| Script | Purpose |
| ------ | ------- |
| `npm run dev` | Start the app |
| `npm run dev:db` | Start a local throwaway MongoDB on port 27018 |
| `npm run seed` | Create the demo user and orders covering every status |
| `npm test` | Run the full test suite |
| `npm run typecheck` | Generate route types and typecheck |
| `npm run build` | Production build |

### Environment variables

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `MONGODB_URI` | yes | Connection string. `mongodb://127.0.0.1:27018` for the local dev database |
| `MONGODB_DB` | no | Database name; defaults to whatever the URI specifies |
| `AUTH_SECRET` | yes | 32+ characters. Rotating it signs everyone out |

---

## Deployment

Deploys to Vercel with no configuration file.

1. **Create a MongoDB Atlas cluster** (the free M0 tier is enough). Under *Network Access*, allow `0.0.0.0/0` — Vercel's functions do not have static egress IPs on the Hobby plan.
2. **Import the repository** into Vercel. It detects Next.js automatically.
3. **Set the environment variables** above in *Project Settings → Environment Variables*. Use a freshly generated `AUTH_SECRET`, not the one from your `.env.local`.
4. **Deploy**, then seed the demo account against the production database:

   ```bash
   MONGODB_URI="<your-atlas-uri>" npm run seed
   ```

The connection helper in [`src/lib/db.ts`](src/lib/db.ts) caches the Mongoose connection promise on `globalThis`, so warm lambdas reuse one pool instead of opening a connection per request — without that, Atlas's connection limit is reached quickly under any real traffic.

---

## API overview

All endpoints are under `/api`. Every order route requires a session cookie and is scoped to the signed-in user.

### Auth

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/auth/signup` | `{ email, password }`, password 8+ chars. Sets the session cookie |
| `POST` | `/api/auth/login` | `{ email, password }` |
| `POST` | `/api/auth/logout` | Clears the cookie |
| `GET`  | `/api/auth/me` | `{ user }` or `{ user: null }` |

### Orders

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET` | `/api/orders` | Query: `status`, `search`, `page`, `pageSize` |
| `POST` | `/api/orders` | `{ customer, dueDate, lineItems[] }` |
| `GET` | `/api/orders/:id` | Full detail: line items + payment history |
| `PATCH` | `/api/orders/:id` | Any subset of the create fields |
| `DELETE` | `/api/orders/:id` | Blocked once payments exist |
| `POST` | `/api/orders/:id/payments` | `{ amount, date?, note? }` |
| `GET` | `/api/orders/export` | CSV download. Query: `from`, `to` (by due date, inclusive) |

### Money on the wire

Every amount is sent **both** as integer cents and as a decimal string:

```json
{ "totalCents": 100000, "total": "1000.00" }
```

Amounts are accepted as either (`"500"`, `"500.00"`, `500`). They are never sent as JSON floats — a client doing `total - paid` on floats would reintroduce exactly the rounding bug the server avoids.

### Error shape

Every failure returns the same envelope:

```json
{
  "error": {
    "code": "over_payment",
    "message": "Payment of $600.01 exceeds the $600.00 still outstanding on this order.",
    "hint": "Record $600.00 or less.",
    "meta": { "maxAllowedCents": 60000, "maxAllowed": "600.00", "amountPaid": "400.00" }
  }
}
```

- `code` — stable and machine-readable
- `message` — safe to show a user as-is
- `hint` — the resolution step
- `meta` — the numbers a client needs to recover; the UI uses `maxAllowedCents` to offer a one-click "Use $600.00 instead" correction
- `details` — per-field messages on validation errors

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `validation_error` | 400 | Malformed body; see `details` |
| `unauthenticated` | 401 | Missing or invalid session |
| `not_found` | 404 | No such order, **or** it belongs to another user |
| `conflict` / `order_locked` | 409 | Email taken; or edit/delete blocked by existing payments |
| `over_payment` | 422 | Would exceed the order total |
| `internal_error` | 500 | Unexpected; details are logged, not returned |

---

## Status derivation rules

**Status is never stored.** It is a pure function of `(amount paid, order total, due date, now)`, computed on every read by [`deriveOrderState`](src/lib/status.ts).

The alternative — storing a status column — is wrong here for one specific reason: an order becomes overdue *by the passage of time*, not by anything happening to it. A stored status would be stale from midnight until something next wrote to that row.

```
paid            amountPaid >= total
overdue         not fully paid AND the due date has fully elapsed
partially_paid  0 < amountPaid < total, not yet overdue
pending         amountPaid == 0, not yet overdue
```

**Precedence matters**, because the brief's four statuses are mutually exclusive but the underlying facts are not. The order above is deliberate:

- **`paid` outranks `overdue`.** An order settled after its due date reads as `paid`. Money is in; being late is now history.
- **`overdue` outranks `partially_paid`.** Something past due needs attention whether or not part of it has been collected.

Because that second rule loses information, the API also returns an **`isOverdue` boolean alongside `status`**. The dashboard uses it to badge a partially-paid order as `late` without hiding that money has come in. `overdue` on its own is not a payment state, so collapsing both facts into one field would have made the Overdue tab and the Partially-paid tab disagree about the same order.

### Keeping the filter honest

Filtering by status means expressing these same rules a second time, as a MongoDB query ([`statusFilter`](src/lib/orderQuery.ts)). Two encodings of one rule set drift apart silently — the dashboard would show an order as overdue while the Overdue tab omitted it.

[`orderQuery.test.ts`](src/lib/orderQuery.test.ts) builds a fixture covering every state and asserts the pure function and the query agree on all of them, and that the four filters partition the set exactly. Change one without the other and the suite fails.

---

## Edge cases

| Case | Behaviour | Reasoning |
| ---- | --------- | --------- |
| **Overdue order later paid in full** | Becomes `paid`, `isOverdue` false | Settlement is permanent; it stays `paid` forever after |
| **Partially paid and past due** | `status: "overdue"`, `isOverdue: true`, amount due reflects the partial payment | Needs chasing, but the collected amount is not hidden |
| **Order due today** | Not overdue until the day has fully elapsed | Due dates are day-granular; an order due today is not late at 9am |
| **Payment of exactly the balance** | Accepted, order becomes `paid` | The boundary is `<=`, not `<` |
| **Payment one cent over** | Rejected with `maxAllowed` | Verified explicitly in the tests |
| **Zero-total order** (all lines free) | `paid` | Nothing to collect, so it is settled rather than perpetually pending |
| **Amount with 3+ decimals** (`10.005`) | Rejected | Ambiguous — silently rounding it loses or invents money |
| **Another user's order id** | `404`, not `403` | A 403 confirms the id exists, leaking the shape of other tenants' data |
| **Negative amount due** | Clamped to `0` in the display | Defensive; over-payment is prevented, but corrupted data must not render a negative balance |

### Timezone caveat

Due dates are **calendar dates**, normalised to UTC midnight on write and rendered in UTC. "Overdue" is therefore evaluated against UTC days, so a user in UTC+13 sees an order flip to overdue up to 13 hours after their own midnight. For a single-tenant tool this is the right tradeoff — it keeps the stored value unambiguous. A real product would store the account's timezone and evaluate against it.

---

## Concurrency

> *"Consider what happens if two payments are submitted at the same time."*

This is handled, not just documented.

The naive implementation has a race:

```ts
const order = await Order.findById(id);            // both read amountPaid = $400
if (order.amountPaid + amount > order.total) throw; // both see $1,000 <= $1,000
order.payments.push(payment);
order.amountPaid += amount;
await order.save();                                 // both write → paid $1,600
```

Two simultaneous $600 payments against a $1,000 order both pass the check and both commit. The order ends up over-paid — the exact thing the brief forbids.

**The fix is to make the balance check part of the write.** The condition lives in the update's filter, so MongoDB evaluates it against the document as it exists at write time:

```ts
await Order.findOneAndUpdate(
  {
    _id, userId,
    $expr: { $lte: [{ $add: ["$amountPaidCents", amountCents] }, "$totalCents"] },
  },
  {
    $push: { payments: payment },
    $inc:  { amountPaidCents: amountCents },
  },
  { returnDocument: "after" },
);
```

MongoDB guarantees **single-document atomicity**. The first writer increments the total; the second re-evaluates `$expr` against the *new* value, fails to match, gets `null` back, and is rejected with a 422. No transaction, no application-level lock, no retry loop.

**This is why payments are embedded in the order document** rather than kept in their own collection. It puts the payment record and the running total inside the same atomicity boundary. Had payments been a separate collection, keeping the two in step would have required a multi-document transaction — which in turn requires a replica set, adding an operational dependency to satisfy a constraint the document model expresses for free.

The tradeoff is MongoDB's 16MB document ceiling. Payments per order are naturally bounded (tens, not millions), so it is safe here. It would stop being safe for something like a metered subscription accruing thousands of micro-charges per order; that case wants a separate collection plus a transaction, or an event-sourced balance.

[`payments.test.ts`](src/lib/payments.test.ts) covers this directly — including twenty parallel $100 payments against a $1,000 order, asserting that exactly ten are accepted and the total lands on $1,000 exactly.

---

## Assumptions and tradeoffs

**Money is stored as integer cents.** Never floats. `0.1 + 0.2 !== 0.3`, and an order a fraction of a cent short of its total would never reach `paid`. Dollars exist only at the edges — parsed on input, formatted on output.

**Are orders editable after the first payment?** Partially, and deliberately:

- **Customer and due date stay editable for the life of the order.** Fixing a typo or renegotiating a due date should not require voiding a document money has been taken against.
- **Line items freeze once the first payment lands** (`409 order_locked`). Editing them changes the total underneath a payment that was validated against the old one, which can leave an order recorded as over-paid with no way to express that.
- **Deletion is blocked once payments exist.** Deleting the order destroys the record of the money. That needs a deliberate refund-then-void flow, not a delete button.

The API returns an `editable` flag so the UI can reflect this without duplicating the rule.

**Totals are always server-computed.** `subtotalCents`, `totalCents` and `lineTotalCents` are recalculated from the line items by a Mongoose `pre("validate")` hook on every save, so a client cannot dictate an order's total. There is a test asserting a client-supplied total is ignored.

**Order total equals subtotal.** No tax or discount, per the brief. `totalCents` is still a distinct field so adding either later does not require migrating every downstream calculation.

**Auth is deliberately minimal.** A JWT in an httpOnly, SameSite=Lax cookie: httpOnly keeps the token away from any XSS, SameSite=Lax covers CSRF for the state-changing routes. Login runs a bcrypt comparison even when the email is unknown, so response timing does not reveal which addresses have accounts. There is no email verification, password reset, or refresh-token rotation — out of scope, and listed below.

**`src/proxy.ts` is not the authorisation boundary.** (In Next.js 16 this file is the former `middleware.ts`, renamed upstream.) It only checks whether a session cookie is *present*, to bounce signed-out visitors before a protected page renders. It does not verify the token. Every API route independently calls `requireUser()` and scopes its query by `userId`; a forged cookie earns a redirect and nothing more.

**Stretch goals:** CSV export is implemented (streamed from a cursor, with CSV-injection guarding on the formula characters Excel would otherwise execute). Refunds and an audit log are not — see below for why the audit log is more subtle than it looks.

---

## Testing

```bash
npm test
```

36 tests, all passing. Integration tests run against a real MongoDB via `mongodb-memory-server` — the over-payment guard is a `$expr` condition the *database* evaluates, so mocking the driver would test nothing that matters.

| File | Covers |
| ---- | ------ |
| [`money.test.ts`](src/lib/money.test.ts) | Cent parsing, float-drift cases (`19.99`), sub-cent rejection, round-tripping |
| [`status.test.ts`](src/lib/status.test.ts) | Every status, precedence, and each documented edge case |
| [`orderQuery.test.ts`](src/lib/orderQuery.test.ts) | The DB filter agrees with the pure function on every state, and the filters partition the set |
| [`payments.test.ts`](src/lib/payments.test.ts) | Totals, the brief's sample scenario end to end, over-payment boundaries, **concurrency**, tenant isolation, status transitions over time |

The brief's sample scenario is encoded as a test (`"walks pending -> partially_paid -> paid and rejects the extra dollar"`) and was also run manually against the live app.

---

## What I would do before production

**Correctness and money**

- **Refunds**, as negative-amount entries of a distinct type rather than deletions, so the payment history remains an append-only record.
- **Idempotency keys** on `POST /payments`. The atomic guard prevents over-payment, but a double-submitted $400 payment on a $1,000 order is two *valid* payments — only the caller knows it was one intent.
- **Currency.** Every amount is implicitly USD. A `currency` field on the order, with payments constrained to match it.

**The audit log, and why it is not here**

The obvious implementation — append a row whenever a payment write changes the derived status — silently misses the `overdue` transition, because nothing writes to the order when it crosses its due date; time simply passes. A log built that way would be quietly incomplete, which is worse than none. Doing it properly means either a scheduled job that sweeps newly-overdue orders and records the transition, or logging payment *events* and reconstructing status history from them plus the due date. The second is the better design and is what I would build.

**Operational**

- Rate limiting on the auth routes.
- Structured logging with request ids; `console.error` is a placeholder.
- Cursor-based pagination on the dashboard. Offset paging degrades on deep pages, though it is fine at the scale this handles today.
- E2E tests (Playwright) over the flows verified by hand here.
- CI running `typecheck`, `lint`, and `test` on every push.
