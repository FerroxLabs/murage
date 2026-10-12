import { describe, expect, it } from "vitest";
import { BROWSER_HELD_FOR_ANSWER_REASON, BROWSER_UNAVAILABLE_PREFIX, browserUnavailableActivityName, browserUnavailableDisplayName, browserUnavailableReason, USER_CHROME_UNREACHABLE_REASON } from "./browser-unavailable.ts";

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

  it("says plainly that another conversation waiting for an answer has the browser", () => {
    expect(browserUnavailableDisplayName(browserUnavailableActivityName(BROWSER_HELD_FOR_ANSWER_REASON))).toBe(
      "Another conversation with this bot is using the browser while it waits for your answer, so this turn ran without it. Answering that request lets the next turn use it.");
  });

  it("still says something when the reason is empty", () => {
    expect(browserUnavailableReason(browserUnavailableActivityName("  "))).toBe("the browser engine did not start");
  });
});

describe("browser check progress (1.0.2)", () => {
  it("keeps checking, finished and unfinished apart from the failure wording", async () => {
    const m = await import("./browser-unavailable");
    for (const [reason, kind] of [[m.BROWSER_CHECKING_REASON, "checking"], [m.BROWSER_CHECKED_REASON, "checked"], [m.BROWSER_CHECK_UNFINISHED_REASON, "unfinished"], [m.BROWSER_CHECK_FAILED_REASON, "check-failed"]] as const) {
      expect(m.browserUnavailableKind(reason)).toBe(kind);
      const text = m.browserUnavailableDisplayName(m.browserUnavailableActivityName(reason))!;
      expect(text).not.toMatch(/couldn't start|ran without it/);
      expect(text).not.toMatch(/—|safe/i);
    }
  });

  it("a check that errored says it did not finish and to try again, not the next-turn fallback", async () => {
    const m = await import("./browser-unavailable");
    const text = m.browserUnavailableDisplayName(m.browserUnavailableActivityName(m.BROWSER_CHECK_FAILED_REASON))!;
    expect(text).toBe("The browser check didn't finish. Try again in a moment.");
    expect(text).not.toMatch(/didn't use the browser|next turn/);
  });
});
