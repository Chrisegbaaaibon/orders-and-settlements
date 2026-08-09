import { describe, expect, it } from "vitest";
import { deriveOrderState } from "./status";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Convenience wrapper: totals in cents, due date as YYYY-MM-DD. */
function state(amountPaidCents: number, totalCents: number, dueDate: string, now = NOW) {
  return deriveOrderState({ amountPaidCents, totalCents, dueDate: day(dueDate), now });
}

describe("deriveOrderState", () => {
  it("is pending with no payments and a future due date", () => {
    expect(state(0, 100_000, "2026-03-22").status).toBe("pending");
  });

  it("is partially_paid when some but not all has been paid", () => {
    expect(state(40_000, 100_000, "2026-03-22").status).toBe("partially_paid");
  });

  it("is paid when payments equal the total", () => {
    expect(state(100_000, 100_000, "2026-03-22").status).toBe("paid");
  });

  it("is overdue when past the due date and not fully paid", () => {
    expect(state(0, 100_000, "2026-03-10").status).toBe("overdue");
    expect(state(40_000, 100_000, "2026-03-10").status).toBe("overdue");
  });

  describe("edge cases", () => {
    it("reports paid, not overdue, for an order settled after its due date", () => {
      // The case called out in the brief: it *was* overdue, it is now settled.
      const result = state(100_000, 100_000, "2026-03-01");
      expect(result.status).toBe("paid");
      expect(result.isOverdue).toBe(false);
      expect(result.amountDueCents).toBe(0);
    });

    it("flags a partially-paid order past its due date as both", () => {
      const result = state(40_000, 100_000, "2026-03-10");
      expect(result.status).toBe("overdue");
      expect(result.isOverdue).toBe(true);
      expect(result.amountDueCents).toBe(60_000);
    });

    it("does not mark an order due today as overdue until the day is over", () => {
      // Due 2026-03-15, now is midday on 2026-03-15.
      expect(state(0, 100_000, "2026-03-15").status).toBe("pending");
      // One minute into the next day it is late.
      expect(state(0, 100_000, "2026-03-15", new Date("2026-03-16T00:01:00Z")).status).toBe(
        "overdue",
      );
    });

    it("treats a zero-total order as paid", () => {
      // Every line item free. There is nothing to collect, so it is settled
      // rather than perpetually pending.
      expect(state(0, 0, "2026-03-01").status).toBe("paid");
    });

    it("never reports a negative amount due", () => {
      // Defensive: the API prevents over-payment, but if data were ever
      // corrected out of band the display must not show a negative balance.
      expect(state(120_000, 100_000, "2026-03-22").amountDueCents).toBe(0);
    });
  });
});
