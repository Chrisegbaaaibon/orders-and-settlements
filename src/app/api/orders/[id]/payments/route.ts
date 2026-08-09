import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { createPaymentSchema } from "@/lib/validation";
import { ApiError, validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { recordPayment } from "@/lib/payments";
import { serializeOrderDetail } from "@/lib/serialize";
import { centsToDollarString } from "@/lib/money";

export const runtime = "nodejs";

type Context = RouteContext<"/api/orders/[id]/payments">;

/**
 * POST /api/orders/:id/payments — record a payment against an order.
 *
 * All the interesting behaviour (atomic over-payment rejection, idempotent
 * retries) lives in `recordPayment`; this handler is HTTP plumbing.
 * Over-payment surfaces as a 422 whose `meta.maxAllowed` tells the client
 * exactly what would have fit.
 *
 * An `Idempotency-Key` header — the conventional header name for this (see
 * Stripe, GitHub, etc.) — lets a client safely retry a payment whose response
 * it never saw (dropped connection, timeout) without risking a double
 * charge: the same key returns the original payment instead of creating a
 * second one. It is optional; omitting it keeps the old at-most-once-per-call
 * behaviour, where a genuine retry is indistinguishable from a second
 * intended payment.
 */
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;

  const parsed = createPaymentSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const { amount, date, note } = parsed.data;

  const idempotencyKeyHeader = request.headers.get("Idempotency-Key")?.trim();
  if (idempotencyKeyHeader !== undefined && idempotencyKeyHeader.length > 200) {
    throw new ApiError("validation_error", "Idempotency-Key must be 200 characters or fewer.");
  }
  const idempotencyKey = idempotencyKeyHeader || undefined;

  await connectToDatabase();

  const { order, payment } = await recordPayment({
    userId: user.id,
    orderId: id,
    amountCents: amount,
    date,
    note,
    idempotencyKey,
  });

  return NextResponse.json(
    {
      order: serializeOrderDetail(order),
      payment: {
        id: payment.id,
        amountCents: payment.amountCents,
        amount: centsToDollarString(payment.amountCents),
        date: payment.date.toISOString(),
        ...(payment.note ? { note: payment.note } : {}),
      },
    },
    { status: 201 },
  );
});
