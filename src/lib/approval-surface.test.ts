import { describe, expect, it } from "vitest";
import { allowNeedsComputer, approvalSurface, isComputerOnly, markComputerOnly } from "./approval-surface";

describe("approvalSurface", () => {
  it("reads the desktop, the phone app, a paired browser, and not-yet-known", () => {
    expect(approvalSurface(true, false)).toBe("desktop");
    expect(approvalSurface(true, true)).toBe("desktop");
    expect(approvalSurface(false, true)).toBe("app");
    expect(approvalSurface(false, false)).toBe("browser");
    expect(approvalSurface(undefined, false)).toBe("unknown");
    expect(approvalSurface(undefined, true)).toBe("app");
  });
});

describe("allowNeedsComputer", () => {
  it("hides Allow on a browser pairing unless the card was rated low", () => {
    expect(allowNeedsComputer("browser", { lowRisk: true })).toBe(false);
    expect(allowNeedsComputer("browser", {})).toBe(true);
    expect(allowNeedsComputer("browser", undefined)).toBe(true);
    expect(allowNeedsComputer("browser", { lowRisk: "true" })).toBe(true);
  });
  it("never hides Allow on the desktop, in the app, or before the surface is known", () => {
    for (const surface of ["desktop", "app", "unknown"] as const) expect(allowNeedsComputer(surface, {})).toBe(false);
  });
  it("a server refusal hides Allow for that request, on any surface", () => {
    expect(allowNeedsComputer("app", { lowRisk: true }, true)).toBe(true);
    expect(isComputerOnly("t9", "r9")).toBe(false);
    markComputerOnly("t9", "r9");
    expect(isComputerOnly("t9", "r9")).toBe(true);
    expect(isComputerOnly("t9", "r10")).toBe(false);
  });
});
