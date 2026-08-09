import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { createPaymentSchema } from "@/lib/validation";
import { validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { recordPayment } from "@/lib/payments";
import { serializeOrderDetail } from "@/lib/serialize";
import { centsToDollarString } from "@/lib/money";

export const runtime = "nodejs";

type Context = RouteContext<"/api/orders/[id]/payments">;

/**
 * POST /api/orders/:id/payments — record a payment against an order.
 *
 * All the interesting behaviour (atomic over-payment rejection) lives in
 * `recordPayment`; this handler is HTTP plumbing. Over-payment surfaces as a
 * 422 whose `meta.maxAllowed` tells the client exactly what would have fit.
 */
export const POST = withErrorHandling(async (request: Request, context: Context) => {
  const user = await requireUser();
  const { id } = await context.params;

  const parsed = createPaymentSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const { amount, date, note } = parsed.data;

  await connectToDatabase();

  const { order, payment } = await recordPayment({
    userId: user.id,
    orderId: id,
    amountCents: amount,
    date,
    note,
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
