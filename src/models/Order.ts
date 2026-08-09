import mongoose, {
  Schema,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";
import { computeLineTotalCents, sumLineTotalsCents } from "@/lib/money";

/**
 * The Order aggregate.
 *
 * Payments are embedded rather than kept in their own collection. That is the
 * whole trick behind this app's concurrency story: because a payment and the
 * running `amountPaidCents` total live in the same document, recording a
 * payment is one atomic conditional update, and MongoDB guarantees
 * single-document atomicity. Two simultaneous payments cannot both pass the
 * "would this exceed the total?" check. See README "Concurrency".
 *
 * The tradeoff is the 16MB document ceiling. Payments per order are naturally
 * bounded (tens, not millions), so this is safe here; the README documents when
 * it would stop being safe.
 */

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    // Denormalised so historical lines stay correct even if we ever change how
    // line totals are computed (e.g. per-line discounts).
    lineTotalCents: { type: Number, required: true, min: 0 },
  },
  { _id: true },
);

const paymentSchema = new Schema(
  {
    amountCents: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    createdAt: { type: Date, required: true, default: () => new Date() },
    // Client-supplied retry key (e.g. an `Idempotency-Key` header). Lets
    // `recordPayment` recognise "the client resent the same request" and
    // replay the original result instead of risking a second real payment —
    // see payments.ts.
    idempotencyKey: { type: String, trim: true, maxlength: 200 },
  },
  { _id: true },
);

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customer: { type: String, required: true, trim: true, maxlength: 200 },
    dueDate: { type: Date, required: true },
    lineItems: {
      type: [lineItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: "An order needs at least one line item",
      },
    },
    payments: { type: [paymentSchema], default: [] },

    subtotalCents: { type: Number, required: true, min: 0 },
    // Equal to subtotal for this assignment (no order-level tax or discount),
    // kept as its own field so adding either later does not require a migration
    // of every downstream calculation.
    totalCents: { type: Number, required: true, min: 0 },

    /**
     * Running sum of `payments[].amountCents`, maintained by the same atomic
     * update that pushes the payment. Never write one without the other.
     */
    amountPaidCents: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Dashboard reads are always "my orders, newest first"; the compound index keeps
// that a covered range scan instead of a per-user collection scan.
orderSchema.index({ userId: 1, createdAt: -1 });
// Supports the date-range CSV export and any future due-date reporting.
orderSchema.index({ userId: 1, dueDate: 1 });

/**
 * Recompute derived money fields from the line items.
 *
 * This runs on every save, so `subtotalCents` / `totalCents` / `lineTotalCents`
 * cannot be set by a client — they are always a function of the line items.
 *
 * The API layer rejects quantity/price combinations that would overflow a
 * safe integer before this ever runs (see `lineItemsArraySchema` in
 * validation.ts); the same checks are repeated here via `computeLineTotalCents`
 * / `sumLineTotalsCents` as a backstop for any write that reaches the model
 * without going through that schema.
 */
orderSchema.pre("validate", function recomputeTotals() {
  if (!Array.isArray(this.lineItems)) return;

  for (const item of this.lineItems) {
    item.lineTotalCents = computeLineTotalCents(item.quantity, item.unitPriceCents);
  }
  this.subtotalCents = sumLineTotalsCents(this.lineItems.map((item) => item.lineTotalCents));
  this.totalCents = this.subtotalCents;
});

/** The plain shape stored in MongoDB (no Document methods). */
export type OrderDoc = InferSchemaType<typeof orderSchema> & { _id: mongoose.Types.ObjectId };

/** What `Order.findOne()` / `Order.create()` actually return — has `.save()` etc. */
export type OrderHydrated = HydratedDocument<OrderDoc>;

export type LineItemDoc = OrderDoc["lineItems"][number];
export type PaymentDoc = OrderDoc["payments"][number];

export const Order: Model<OrderDoc> =
  (mongoose.models.Order as Model<OrderDoc>) ?? mongoose.model<OrderDoc>("Order", orderSchema);
