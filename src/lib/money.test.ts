import { describe, expect, it } from "vitest";
import {
  MAX_AMOUNT_CENTS,
  MoneyParseError,
  centsToDollarString,
  computeLineTotalCents,
  computeLineTotals,
  parseDollarsToCents,
  sumLineTotalsCents,
} from "./money";

describe("parseDollarsToCents", () => {
  it("parses whole dollars and cents", () => {
    expect(parseDollarsToCents("1000")).toBe(100_000);
    expect(parseDollarsToCents("1000.00")).toBe(100_000);
    expect(parseDollarsToCents("1234.56")).toBe(123_456);
    expect(parseDollarsToCents("0.01")).toBe(1);
    expect(parseDollarsToCents("0.1")).toBe(10);
  });

  it("accepts formatted input", () => {
    expect(parseDollarsToCents("$1,234.56")).toBe(123_456);
    expect(parseDollarsToCents("  500 ")).toBe(50_000);
  });

  it("parses numbers without float drift", () => {
    // The bug this guards: 19.99 * 100 === 1998.9999999999998 in IEEE 754.
    expect(parseDollarsToCents(19.99)).toBe(1999);
    expect(parseDollarsToCents(0.29)).toBe(29);
    expect(parseDollarsToCents(1000)).toBe(100_000);
    // A float with sub-cent precision is rejected, not silently rounded.
    expect(() => parseDollarsToCents(1.005)).toThrow(MoneyParseError);
  });

  it("rejects more than two decimal places rather than rounding", () => {
    expect(() => parseDollarsToCents("10.005")).toThrow(MoneyParseError);
    expect(() => parseDollarsToCents("0.001")).toThrow(/2 decimal places/);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseDollarsToCents("")).toThrow(MoneyParseError);
    expect(() => parseDollarsToCents("abc")).toThrow(MoneyParseError);
    expect(() => parseDollarsToCents(Number.NaN)).toThrow(MoneyParseError);
    expect(() => parseDollarsToCents(Infinity)).toThrow(MoneyParseError);
    expect(() => parseDollarsToCents(null)).toThrow(MoneyParseError);
  });

  it("rejects amounts above the ceiling", () => {
    expect(() => parseDollarsToCents("9999999999")).toThrow(/maximum/);
  });
});

describe("computeLineTotalCents", () => {
  it("multiplies quantity by unit price", () => {
    expect(computeLineTotalCents(3, 1_999)).toBe(5_997);
  });

  it("rejects a quantity/price combination that overflows a safe integer", () => {
    // Each input independently passes the field-level bounds (unit price
    // capped at MAX_AMOUNT_CENTS, quantity capped at 1,000,000) but their
    // product does not fit in Number.MAX_SAFE_INTEGER.
    const unitPriceCents = MAX_AMOUNT_CENTS; // $1,000,000,000.00
    const quantity = 1_000_000;
    expect(Number.isSafeInteger(quantity * unitPriceCents)).toBe(false);
    expect(() => computeLineTotalCents(quantity, unitPriceCents)).toThrow(MoneyParseError);
  });

  it("rejects a single line total above the order ceiling even when it is a safe integer", () => {
    // 2 x MAX_AMOUNT_CENTS is a safe integer, but a single line still should
    // not be allowed to exceed the same ceiling applied to a whole order.
    expect(Number.isSafeInteger(2 * MAX_AMOUNT_CENTS)).toBe(true);
    expect(() => computeLineTotalCents(2, MAX_AMOUNT_CENTS)).toThrow(/maximum/);
  });
});

describe("sumLineTotalsCents", () => {
  it("sums line totals", () => {
    expect(sumLineTotalsCents([5_997, 25_000])).toBe(30_997);
  });

  it("rejects a running sum that exceeds the ceiling even though every line is individually valid", () => {
    const withinCeiling = Array.from({ length: 200 }, () => MAX_AMOUNT_CENTS / 1_000);
    expect(() => sumLineTotalsCents(withinCeiling)).not.toThrow(); // sums to well under the ceiling
    const tooMany = Array.from({ length: 200 }, () => MAX_AMOUNT_CENTS);
    expect(() => sumLineTotalsCents(tooMany)).toThrow(MoneyParseError);
  });
});

describe("computeLineTotals", () => {
  it("computes every line total and the subtotal together", () => {
    const result = computeLineTotals([
      { quantity: 3, unitPriceCents: 1_999 },
      { quantity: 1, unitPriceCents: 25_000 },
    ]);
    expect(result.lineTotalsCents).toEqual([5_997, 25_000]);
    expect(result.subtotalCents).toBe(30_997);
  });

  it("rejects the accepted-but-overflowing combination from the audit: a $1B unit price times a million units", () => {
    expect(() =>
      computeLineTotals([{ quantity: 1_000_000, unitPriceCents: MAX_AMOUNT_CENTS }]),
    ).toThrow(MoneyParseError);
  });
});

describe("centsToDollarString", () => {
  it("always renders two decimal places", () => {
    expect(centsToDollarString(0)).toBe("0.00");
    expect(centsToDollarString(1)).toBe("0.01");
    expect(centsToDollarString(100_000)).toBe("1000.00");
    expect(centsToDollarString(123_456)).toBe("1234.56");
  });

  it("round-trips through the parser", () => {
    for (const cents of [0, 1, 99, 100, 12_345, 100_000, 999_999_99]) {
      expect(parseDollarsToCents(centsToDollarString(cents))).toBe(cents);
    }
  });
});
