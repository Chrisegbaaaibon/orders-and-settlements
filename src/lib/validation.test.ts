import { describe, expect, it } from "vitest";
import { calendarDate, createOrderSchema } from "./validation";

describe("calendarDate", () => {
  it("accepts a valid day-only date and normalises to UTC midnight", () => {
    const result = calendarDate.parse("2026-03-02");
    expect(result.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rejects an invalid calendar date instead of silently rolling it forward", () => {
    // Date.UTC(2026, 1, 30) normalises to March 2 rather than throwing — the
    // schema has to catch this itself, not rely on the Date constructor to.
    expect(() => calendarDate.parse("2026-02-30")).toThrow(/valid calendar date/);
  });

  it("rejects other invalid day-only dates: month 13, day 0, Feb 29 on a non-leap year", () => {
    expect(() => calendarDate.parse("2026-13-01")).toThrow();
    expect(() => calendarDate.parse("2026-01-00")).toThrow();
    expect(() => calendarDate.parse("2027-02-29")).toThrow(); // 2027 is not a leap year
  });

  it("accepts Feb 29 on an actual leap year", () => {
    expect(() => calendarDate.parse("2028-02-29")).not.toThrow();
  });

  it("still accepts a full ISO datetime string", () => {
    const result = calendarDate.parse("2026-03-02T15:30:00.000Z");
    expect(result.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rejects an empty or garbage string", () => {
    expect(() => calendarDate.parse("")).toThrow();
    expect(() => calendarDate.parse("not-a-date")).toThrow();
  });
});

describe("createOrderSchema", () => {
  it("rejects an order whose due date is an invalid calendar date", () => {
    const result = createOrderSchema.safeParse({
      customer: "Acme",
      dueDate: "2026-02-30",
      lineItems: [{ description: "Widget", quantity: 1, unitPrice: "10.00" }],
    });
    expect(result.success).toBe(false);
  });
});
