import { describe, expect, it } from "vitest";
import { answeredByOwner, settledBy } from "./mobile-push-hooks.ts";

describe("settledBy (B10)", () => {
  it("an answered card keeps where it was answered", () => {
    expect(settledBy({ answered: "Allow once" }, "desktop")).toBe("desktop");
    expect(settledBy({ answered: "Deny" }, "elsewhere")).toBe("elsewhere");
  });
  it("a dismissed or expired card was answered by nobody", () => {
    expect(settledBy({ dismissed: true }, "elsewhere")).toBe("dismissed");
    expect(settledBy({ expired: true }, "elsewhere")).toBe("expired");
  });
  it("a card the system closed (answered \"unavailable\", dismissed) was answered by nobody", () => {
    expect(settledBy({ answered: "unavailable", dismissed: true }, "elsewhere")).toBe("dismissed");
    expect(settledBy({ answered: "unavailable" }, "desktop")).toBe("dismissed");
    expect(answeredByOwner({ answered: "unavailable" })).toBe(false);
    expect(answeredByOwner({ answered: "Deny" })).toBe(true);
    expect(answeredByOwner({})).toBe(false);
  });
  it("an answer wins over a later expiry flag", () => {
    expect(settledBy({ answered: "Allow once", expired: true }, "desktop")).toBe("desktop");
  });
});
