/**
 * Seed a demo account with orders in every status.
 *
 *   npm run seed
 *
 * Idempotent: re-running wipes the demo user's orders and rebuilds them, so the
 * dataset is always the same regardless of how many times it has run.
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const MONGODB_URI = process.env.MONGODB_URI;
const DEMO_EMAIL = process.env.SEED_EMAIL || "demo@example.com";
const DEMO_PASSWORD = process.env.SEED_PASSWORD || "demo-password-123";

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

await mongoose.connect(MONGODB_URI, { dbName: process.env.MONGODB_DB || undefined });

// Minimal inline schemas — the seed script talks to the same collections as the
// app but does not import its TypeScript models.
const db = mongoose.connection.db;
const users = db.collection("users");
const orders = db.collection("orders");

const now = new Date();
const daysFromNow = (n) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + n);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
await users.updateOne(
  { email: DEMO_EMAIL },
  { $set: { email: DEMO_EMAIL, passwordHash, updatedAt: now }, $setOnInsert: { createdAt: now } },
  { upsert: true },
);
const user = await users.findOne({ email: DEMO_EMAIL });

await orders.deleteMany({ userId: user._id });

/** Build an order document, deriving every money field from the line items. */
function order({ customer, dueDate, lines, payments = [] }) {
  const lineItems = lines.map(([description, quantity, unitPriceCents]) => ({
    _id: new mongoose.Types.ObjectId(),
    description,
    quantity,
    unitPriceCents,
    lineTotalCents: quantity * unitPriceCents,
  }));

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const paymentDocs = payments.map(([amountCents, dayOffset, note]) => ({
    _id: new mongoose.Types.ObjectId(),
    amountCents,
    date: daysFromNow(dayOffset),
    ...(note ? { note } : {}),
    createdAt: now,
  }));

  return {
    userId: user._id,
    customer,
    dueDate,
    lineItems,
    payments: paymentDocs,
    subtotalCents,
    totalCents: subtotalCents,
    amountPaidCents: paymentDocs.reduce((sum, p) => sum + p.amountCents, 0),
    createdAt: now,
    updatedAt: now,
  };
}

const fixtures = [
  // The brief's sample scenario, mid-flight.
  order({
    customer: "Acme Corp",
    dueDate: daysFromNow(7),
    lines: [["Consulting", 2, 50_000]],
    payments: [[40_000, -1, "Wire ref 88213"]],
  }),
  // pending — nothing paid, not yet due
  order({
    customer: "Globex",
    dueDate: daysFromNow(21),
    lines: [
      ["Implementation", 1, 250_000],
      ["Training", 4, 25_000],
    ],
  }),
  // paid — settled in full
  order({
    customer: "Initech",
    dueDate: daysFromNow(3),
    lines: [["Annual licence", 1, 120_000]],
    payments: [[120_000, -5, "ACH"]],
  }),
  // overdue — unpaid and past due
  order({
    customer: "Hooli",
    dueDate: daysFromNow(-12),
    lines: [["Migration work", 15, 12_500]],
  }),
  // overdue and partially paid
  order({
    customer: "Soylent Industries",
    dueDate: daysFromNow(-4),
    lines: [["Support retainer", 6, 15_000]],
    payments: [[30_000, -20, "Deposit"]],
  }),
  // paid, but settled *after* it went overdue — the documented edge case
  order({
    customer: "Umbrella Health",
    dueDate: daysFromNow(-30),
    lines: [["Audit", 1, 87_550]],
    payments: [
      [40_000, -25, "Part payment"],
      [47_550, -2, "Balance, late"],
    ],
  }),
];

await orders.insertMany(fixtures);

console.log(`\n  Seeded ${fixtures.length} orders for ${DEMO_EMAIL}`);
console.log(`  Sign in with:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);

await mongoose.disconnect();
