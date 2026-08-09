/**
 * Money handling.
 *
 * Every monetary value is stored and computed as an integer number of cents.
 * Floating point dollars are never used for arithmetic: `0.1 + 0.2 !== 0.3`
 * would eventually make an order that is fully paid look like it still owes a
 * fraction of a cent, and the `paid` status would never trigger.
 *
 * Dollars only exist at the edges: parsed on input, formatted on output.
 */

export const MAX_AMOUNT_CENTS = 1_000_000_000_00; // $1B ceiling, keeps us far inside Number.MAX_SAFE_INTEGER

export class MoneyParseError extends Error {}

/**
 * Parse a user-supplied dollar amount into integer cents.
 *
 * Accepts numbers and strings ("1234.50", "$1,234.50", "1234"). Rejects
 * anything with more than two decimal places rather than silently rounding —
 * a request for "10.005" is ambiguous, and guessing at it loses money.
 */
export function parseDollarsToCents(input: unknown): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyParseError("Amount must be a finite number");
    // Round-trip through a fixed-precision string so 19.99 does not become 1998.
    return parseDollarsToCents(input.toFixed(10).replace(/0+$/, "").replace(/\.$/, ""));
  }

  if (typeof input !== "string") {
    throw new MoneyParseError("Amount must be a number or a numeric string");
  }

  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (cleaned === "") throw new MoneyParseError("Amount is required");

  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    if (/^-?\d+\.\d{3,}$/.test(cleaned)) {
      throw new MoneyParseError("Amount cannot have more than 2 decimal places");
    }
    throw new MoneyParseError("Amount must be a valid decimal number, e.g. 1234.50");
  }

  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  if (cents > MAX_AMOUNT_CENTS) {
    throw new MoneyParseError(`Amount exceeds the maximum of ${formatCents(MAX_AMOUNT_CENTS)}`);
  }

  return sign === "-" ? -cents : cents;
}

/**
 * Compute one line's total and validate it stays inside both
 * `Number.isSafeInteger` and the same `MAX_AMOUNT_CENTS` ceiling applied to
 * individual dollar inputs. Unit price alone is bounded at parse time, but
 * quantity (up to 1,000,000) can still push `quantity * unitPriceCents` past
 * `Number.MAX_SAFE_INTEGER` — e.g. a $1B unit price times a million units —
 * so the multiplication itself has to be checked, not just its inputs.
 */
export function computeLineTotalCents(quantity: number, unitPriceCents: number): number {
  const lineTotalCents = quantity * unitPriceCents;
  if (!Number.isSafeInteger(lineTotalCents) || lineTotalCents > MAX_AMOUNT_CENTS) {
    throw new MoneyParseError(
      `Line total exceeds the maximum of ${formatCents(MAX_AMOUNT_CENTS)} (quantity × unit price too large)`,
    );
  }
  return lineTotalCents;
}

/** Sum line totals into a subtotal, re-checking the ceiling at every step. */
export function sumLineTotalsCents(lineTotalsCents: number[]): number {
  let subtotalCents = 0;
  for (const cents of lineTotalsCents) {
    subtotalCents += cents;
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents > MAX_AMOUNT_CENTS) {
      throw new MoneyParseError(`Order total exceeds the maximum of ${formatCents(MAX_AMOUNT_CENTS)}`);
    }
  }
  return subtotalCents;
}

export interface LineItemAmounts {
  quantity: number;
  unitPriceCents: number;
}

/** Compute every line's total plus the order subtotal in one safe-integer pass. */
export function computeLineTotals(items: LineItemAmounts[]): {
  lineTotalsCents: number[];
  subtotalCents: number;
} {
  const lineTotalsCents = items.map((item) => computeLineTotalCents(item.quantity, item.unitPriceCents));
  return { lineTotalsCents, subtotalCents: sumLineTotalsCents(lineTotalsCents) };
}

/** Render integer cents as a plain decimal string, e.g. 123450 -> "1234.50". */
export function centsToDollarString(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const out = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${out}` : out;
}

/** Render integer cents for display, e.g. 123450 -> "$1,234.50". */
export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
