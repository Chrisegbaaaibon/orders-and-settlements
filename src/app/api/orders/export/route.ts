import mongoose, { type QueryFilter } from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { Order, type OrderDoc } from "@/models/Order";
import { exportQuerySchema } from "@/lib/validation";
import { validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { centsToDollarString } from "@/lib/money";
import { deriveOrderState } from "@/lib/status";

export const runtime = "nodejs";

/**
 * GET /api/orders/export?from=YYYY-MM-DD&to=YYYY-MM-DD — CSV download.
 *
 * The range filters on due date (the date a finance team actually reports on),
 * inclusive at both ends. Both bounds are optional.
 *
 * Rows stream out of a cursor rather than loading every order into memory, so
 * the export does not get slower to first byte as the account grows.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  const url = new URL(request.url);
  const parsed = exportQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const { from, to } = parsed.data;

  await connectToDatabase();
  const now = new Date();

  const filter: QueryFilter<OrderDoc> = { userId: new mongoose.Types.ObjectId(user.id) };
  if (from || to) {
    filter.dueDate = {
      ...(from ? { $gte: from } : {}),
      // `to` is normalised to UTC midnight; extend to the end of that day so the
      // range is inclusive of orders due on the closing date.
      ...(to ? { $lte: new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) } : {}),
    };
  }

  const columns = [
    "order_id",
    "customer",
    "due_date",
    "status",
    "is_overdue",
    "order_total",
    "amount_paid",
    "amount_due",
    "payment_count",
    "created_at",
  ];

  const cursor = Order.find(filter).sort({ dueDate: 1 }).cursor();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`${columns.join(",")}\n`));

      try {
        for await (const order of cursor) {
          const { status, isOverdue, amountDueCents } = deriveOrderState({
            amountPaidCents: order.amountPaidCents,
            totalCents: order.totalCents,
            dueDate: order.dueDate,
            now,
          });

          const row = [
            order._id.toString(),
            order.customer,
            order.dueDate.toISOString().slice(0, 10),
            status,
            String(isOverdue),
            centsToDollarString(order.totalCents),
            centsToDollarString(order.amountPaidCents),
            centsToDollarString(amountDueCents),
            String(order.payments.length),
            order.createdAt.toISOString(),
          ];

          controller.enqueue(encoder.encode(`${row.map(csvCell).join(",")}\n`));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await cursor.close();
      }
    },
  });

  const filename = `orders-${from ? from.toISOString().slice(0, 10) : "all"}-to-${
    to ? to.toISOString().slice(0, 10) : "all"
  }.csv`;

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});

/**
 * Quote a CSV cell. The leading apostrophe on formula characters defuses CSV
 * injection: a customer named `=cmd|...` would otherwise execute when the file
 * is opened in Excel.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
