import { describe, expect, it } from "vitest";
import { settledBy } from "./mobile-push-hooks.ts";

describe("settledBy (B10)", () => {
  it("an answered card keeps where it was answered", () => {
    expect(settledBy({ answered: "Allow once" }, "desktop")).toBe("desktop");
    expect(settledBy({ answered: "Deny" }, "elsewhere")).toBe("elsewhere");
  });
  it("a dismissed or expired card was answered by nobody", () => {
    expect(settledBy({ dismissed: true }, "elsewhere")).toBe("dismissed");
    expect(settledBy({ expired: true }, "elsewhere")).toBe("expired");
  });
  it("an answer wins over a later expiry flag", () => {
    expect(settledBy({ answered: "Allow once", expired: true }, "desktop")).toBe("desktop");
  });
});
