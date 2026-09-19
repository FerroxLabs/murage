import { describe, expect, it } from "vitest";
import { BROWSER_UNAVAILABLE_PREFIX, browserUnavailableActivityName, browserUnavailableDisplayName, browserUnavailableReason, USER_CHROME_UNREACHABLE_REASON } from "./browser-unavailable.ts";

describe("browser-unavailable notice", () => {
  it("round-trips the reason through the activity name", () => {
    const name = browserUnavailableActivityName("agent-browser command timed out");
    expect(name).toBe(`${BROWSER_UNAVAILABLE_PREFIX} agent-browser command timed out`);
    expect(browserUnavailableReason(name)).toBe("agent-browser command timed out");
    expect(browserUnavailableDisplayName(name)).toBe("The browser didn't start in time, so this turn ran without it. It'll try again next turn.");
  });

  it("never reads another activity as the notice", () => {
    for (const name of ["error: agent-browser command timed out", "stopped: browser unavailable: x", "Read", "browser unavailable:", undefined, null]) {
      expect(browserUnavailableReason(name), String(name)).toBeUndefined();
      expect(browserUnavailableDisplayName(name), String(name)).toBeUndefined();
    }
  });

  it("says each cause in plain words for surfaces without a renderer", () => {
    expect(browserUnavailableDisplayName(browserUnavailableActivityName("spawn ENOENT"))).toBe("The browser couldn't start, so this turn ran without it. It'll try again next turn.");
    expect(browserUnavailableDisplayName(browserUnavailableActivityName(USER_CHROME_UNREACHABLE_REASON))).toBe(
      "Your Chrome isn't reachable, so this turn ran without a browser. Open Chrome and turn on remote debugging at chrome://inspect/#remote-debugging.");
  });

  it("still says something when the reason is empty", () => {
    expect(browserUnavailableReason(browserUnavailableActivityName("  "))).toBe("the browser engine did not start");
  });
});
