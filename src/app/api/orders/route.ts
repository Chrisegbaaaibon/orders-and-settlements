import { NextResponse } from "next/server";
import mongoose, { type QueryFilter } from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { Order, type OrderDoc } from "@/models/Order";
import { createOrderSchema, listOrdersQuerySchema } from "@/lib/validation";
import { validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { serializeOrderDetail, serializeOrderSummary } from "@/lib/serialize";
import { statusFilter } from "@/lib/orderQuery";

export const runtime = "nodejs";

/** GET /api/orders — the signed-in user's orders, newest first. */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  const url = new URL(request.url);
  const parsed = listOrdersQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const { status, search, page, pageSize } = parsed.data;

  await connectToDatabase();
  const now = new Date();

  // Every query is scoped by userId — that scoping is the whole of the
  // multi-tenancy story, so it lives here and in findOwnedOrder, nowhere else.
  const filter: QueryFilter<OrderDoc> = { userId: new mongoose.Types.ObjectId(user.id) };
  if (status) Object.assign(filter, statusFilter(status, now));
  if (search) filter.customer = { $regex: escapeRegex(search), $options: "i" };

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Order.countDocuments(filter),
  ]);

  return NextResponse.json({
    orders: orders.map((order) => serializeOrderSummary(order, now)),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

/** POST /api/orders — create an order with its line items. */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  const parsed = createOrderSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const { customer, dueDate, lineItems } = parsed.data;

  await connectToDatabase();

  // subtotalCents / totalCents / lineTotalCents are filled in by the model's
  // pre-validate hook, so the client cannot dictate the total.
  const order = await Order.create({
    userId: new mongoose.Types.ObjectId(user.id),
    customer,
    dueDate,
    lineItems: lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPrice,
      lineTotalCents: item.quantity * item.unitPrice,
    })),
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });

  return NextResponse.json({ order: serializeOrderDetail(order) }, { status: 201 });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
