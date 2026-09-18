import { describe, expect, it } from "vitest";
import { BROWSER_UNAVAILABLE_PREFIX, browserUnavailableActivityName, browserUnavailableDisplayName, browserUnavailableReason } from "./browser-unavailable.ts";

describe("browser-unavailable notice", () => {
  it("round-trips the reason through the activity name", () => {
    const name = browserUnavailableActivityName("agent-browser command timed out");
    expect(name).toBe(`${BROWSER_UNAVAILABLE_PREFIX} agent-browser command timed out`);
    expect(browserUnavailableReason(name)).toBe("agent-browser command timed out");
    expect(browserUnavailableDisplayName(name)).toBe("Browser unavailable this turn — agent-browser command timed out");
  });

  it("never reads another activity as the notice", () => {
    for (const name of ["error: agent-browser command timed out", "stopped: browser unavailable: x", "Read", "browser unavailable:", undefined, null]) {
      expect(browserUnavailableReason(name), String(name)).toBeUndefined();
      expect(browserUnavailableDisplayName(name), String(name)).toBeUndefined();
    }
  });

  it("still says something when the reason is empty", () => {
    expect(browserUnavailableReason(browserUnavailableActivityName("  "))).toBe("the browser engine did not start");
  });
});
