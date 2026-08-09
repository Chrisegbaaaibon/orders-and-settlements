import type { OrderDoc } from "@/models/Order";
import { centsToDollarString } from "./money";
import { deriveOrderState, type OrderStatus } from "./status";

/**
 * Wire format for orders.
 *
 * Money is sent both ways: `*Cents` integers for anything that will be summed
 * or compared, and a decimal *string* for display. Never a JSON float — a
 * client that does `total - paid` on floats reintroduces the rounding bug the
 * server was careful to avoid.
 */

export interface LineItemJson {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  unitPrice: string;
  lineTotalCents: number;
  lineTotal: string;
}

export interface PaymentJson {
  id: string;
  amountCents: number;
  amount: string;
  date: string;
  note?: string;
  createdAt: string;
}

export interface OrderSummaryJson {
  id: string;
  customer: string;
  dueDate: string;
  status: OrderStatus;
  isOverdue: boolean;
  totalCents: number;
  total: string;
  amountPaidCents: number;
  amountPaid: string;
  amountDueCents: number;
  amountDue: string;
  paymentCount: number;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDetailJson extends OrderSummaryJson {
  subtotalCents: number;
  subtotal: string;
  lineItems: LineItemJson[];
  payments: PaymentJson[];
}

export interface OrderAggregates {
  billedCents: number;
  collectedCents: number;
  outstandingCents: number;
  overdueCents: number;
}

export interface OrderAggregatesJson {
  billedCents: number;
  billed: string;
  collectedCents: number;
  collected: string;
  outstandingCents: number;
  outstanding: string;
  overdueCents: number;
  overdue: string;
}

/** Dashboard summary tiles, computed over the complete filtered set — not just the current page. */
export function serializeOrderAggregates(aggregates: OrderAggregates): OrderAggregatesJson {
  return {
    billedCents: aggregates.billedCents,
    billed: centsToDollarString(aggregates.billedCents),
    collectedCents: aggregates.collectedCents,
    collected: centsToDollarString(aggregates.collectedCents),
    outstandingCents: aggregates.outstandingCents,
    outstanding: centsToDollarString(aggregates.outstandingCents),
    overdueCents: aggregates.overdueCents,
    overdue: centsToDollarString(aggregates.overdueCents),
  };
}

/** Line items become read-only once money has been taken against the order. */
export function isOrderEditable(order: Pick<OrderDoc, "payments">): boolean {
  return order.payments.length === 0;
}

export function serializeOrderSummary(order: OrderDoc, now = new Date()): OrderSummaryJson {
  const { status, isOverdue, amountDueCents } = deriveOrderState({
    amountPaidCents: order.amountPaidCents,
    totalCents: order.totalCents,
    dueDate: order.dueDate,
    now,
  });

  return {
    id: order._id.toString(),
    customer: order.customer,
    dueDate: order.dueDate.toISOString(),
    status,
    isOverdue,
    totalCents: order.totalCents,
    total: centsToDollarString(order.totalCents),
    amountPaidCents: order.amountPaidCents,
    amountPaid: centsToDollarString(order.amountPaidCents),
    amountDueCents,
    amountDue: centsToDollarString(amountDueCents),
    paymentCount: order.payments.length,
    editable: isOrderEditable(order),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function serializeOrderDetail(order: OrderDoc, now = new Date()): OrderDetailJson {
  return {
    ...serializeOrderSummary(order, now),
    subtotalCents: order.subtotalCents,
    subtotal: centsToDollarString(order.subtotalCents),
    lineItems: order.lineItems.map((item) => ({
      id: item._id.toString(),
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      unitPrice: centsToDollarString(item.unitPriceCents),
      lineTotalCents: item.lineTotalCents,
      lineTotal: centsToDollarString(item.lineTotalCents),
    })),
    payments: [...order.payments]
      // Newest first: a payment history is read most-recent-first.
      .sort((a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      .map((payment) => ({
        id: payment._id.toString(),
        amountCents: payment.amountCents,
        amount: centsToDollarString(payment.amountCents),
        date: payment.date.toISOString(),
        ...(payment.note ? { note: payment.note } : {}),
        createdAt: payment.createdAt.toISOString(),
      })),
  };
}
