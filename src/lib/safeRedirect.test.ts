import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safeRedirect";

describe("safeRedirect", () => {
  it("passes through a plain internal path", () => {
    expect(safeRedirect("/orders/123")).toBe("/orders/123");
    expect(safeRedirect("/dashboard?status=paid")).toBe("/dashboard?status=paid");
  });

  it("falls back for undefined, null, or empty input", () => {
    expect(safeRedirect(undefined)).toBe("/dashboard");
    expect(safeRedirect(null)).toBe("/dashboard");
    expect(safeRedirect("")).toBe("/dashboard");
  });

  it("falls back for a scheme-relative URL", () => {
    expect(safeRedirect("//evil.example.com")).toBe("/dashboard");
  });

  it("falls back for a backslash variant of scheme-relative", () => {
    expect(safeRedirect("/\\evil.example.com")).toBe("/dashboard");
  });

  it("falls back for an absolute URL with a scheme", () => {
    expect(safeRedirect("https://evil.example.com")).toBe("/dashboard");
    expect(safeRedirect("javascript:alert(1)")).toBe("/dashboard");
  });

  it("falls back for a path containing a control character", () => {
    expect(safeRedirect("/\t/evil.example.com")).toBe("/dashboard");
  });

  it("falls back for a path that does not start with '/'", () => {
    expect(safeRedirect("dashboard")).toBe("/dashboard");
  });

  it("honours a custom fallback", () => {
    expect(safeRedirect("//evil.com", "/login")).toBe("/login");
  });
});
