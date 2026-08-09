import { z } from "zod";
import { MoneyParseError, parseDollarsToCents } from "./money";
import { ORDER_STATUSES } from "./status";

/**
 * Zod schemas for every write endpoint. Amounts arrive as dollars (number or
 * string) and leave these schemas as integer cents, so no route handler ever
 * touches a floating-point dollar value.
 */

/** A dollar amount that transforms into integer cents, with a floor in cents. */
const dollarsAsCents = (opts: { min: number; label: string }) =>
  z.union([z.number(), z.string()]).transform((value, ctx) => {
    let cents: number;
    try {
      cents = parseDollarsToCents(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof MoneyParseError ? error.message : "Invalid amount",
      });
      return z.NEVER;
    }
    if (cents < opts.min) {
      ctx.addIssue({
        code: "custom",
        message: `${opts.label} must be at least ${(opts.min / 100).toFixed(2)}`,
      });
      return z.NEVER;
    }
    return cents;
  });

/** A calendar date, accepted as "YYYY-MM-DD" or ISO, normalised to UTC midnight. */
const calendarDate = z
  .string()
  .min(1, "Date is required")
  .transform((value, ctx) => {
    const isDayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = new Date(isDayOnly ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: "custom", message: "Must be a valid date (YYYY-MM-DD)" });
      return z.NEVER;
    }
    return new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
    );
  });

export const lineItemSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(500),
  quantity: z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      const n = typeof value === "number" ? value : Number(value.trim());
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: "Quantity must be a whole number" });
        return z.NEVER;
      }
      if (n < 1) {
        ctx.addIssue({ code: "custom", message: "Quantity must be at least 1" });
        return z.NEVER;
      }
      if (n > 1_000_000) {
        ctx.addIssue({ code: "custom", message: "Quantity must be 1,000,000 or less" });
        return z.NEVER;
      }
      return n;
    }),
  // Free line items are allowed (min 0); only the order total is constrained.
  unitPrice: dollarsAsCents({ min: 0, label: "Unit price" }),
});

export const createOrderSchema = z.object({
  customer: z.string().trim().min(1, "Customer is required").max(200),
  dueDate: calendarDate,
  lineItems: z.array(lineItemSchema).min(1, "An order needs at least one line item").max(200),
});

/**
 * PATCH accepts any subset. `lineItems` is only honoured while the order has no
 * payments — enforced in the route, not here, because it depends on stored state.
 */
export const updateOrderSchema = createOrderSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one field to update" },
);

export const createPaymentSchema = z.object({
  amount: dollarsAsCents({ min: 1, label: "Payment amount" }), // >= $0.01
  date: calendarDate.optional(),
  note: z.string().trim().max(1000).optional(),
});

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const exportQuerySchema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password must be 200 characters or fewer"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
