import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeDesktopOnlyRouteError, routeErrorFrom } from "./desktop-only-route-error";

describe("describeDesktopOnlyRouteError", () => {
  it("maps a route-miss into plain words when the status backs it up", () => {
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no route: GET /api/bots/bot-1/computer" })).toBe(
      "This isn't available from here.",
    );
    // the door's message is case-sensitive on the method but the prefix check is not
    expect(describeDesktopOnlyRouteError({ status: 404, message: "No route: POST /api/bots/bot-1/browser" })).toBe(
      "This isn't available from here.",
    );
  });

  it("maps the route-policy gate's 404 wording too, but never a bot lookup miss", () => {
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no such route" })).toBe(
      "This isn't available from here.",
    );
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no such bot" })).toBe("no such bot");
  });

  it("an explicit code decides outright, regardless of status or text (the primary signal, fix round 2)", () => {
    expect(describeDesktopOnlyRouteError({ status: 500, code: "no-route", message: "whatever" })).toBe(
      "This isn't available from here.",
    );
    expect(describeDesktopOnlyRouteError({ status: 500, code: "desktop_only", message: "whatever" })).toBe(
      "This needs your Mac to sign in first.",
    );
    expect(describeDesktopOnlyRouteError({ status: 500, code: "browser_inactive", message: "whatever" })).toBe(
      "Browser unavailable right now.",
    );
  });

  it("never maps a 404 the text doesn't back up — a real 'no such bot' miss keeps its own message", () => {
    // /api/bots/:id/computer 404s for "no such bot" too (server/index.ts
    // ~17923), a legitimate condition that has nothing to do with the
    // route-table fallthrough this function maps. Status 404 alone must
    // not be enough, or a deleted bot would get this panel's route-missing
    // copy instead of its own.
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no such bot" })).toBe("no such bot");
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no such browser" })).toBe("no such browser");
  });

  // Fix round 2: status 401 on /api/bots/:id/browser is NOT unambiguous by
  // itself — the door's device-auth refusal (server/index.ts:11386) and
  // browser-owner-api.ts's unrelated "authority went inactive" check both
  // throw status 401. Both now send their own `code` (tested above), so
  // status-401-alone must never decide on its own any more; without a code
  // it falls back to an exact (not prefix) text match for each of the two
  // known strings, which still tells them apart, and anything else passes
  // through unchanged rather than guessing.
  describe("401 without a code no longer guesses — it falls back to the exact known strings only", () => {
    it("maps the door's lowercase refusal to the sign-in copy", () => {
      expect(describeDesktopOnlyRouteError({ status: 401, message: "browser owner authentication required" })).toBe(
        "This needs your Mac to sign in first.",
      );
    });

    it("maps browser-owner-api's capital-B 'authority inactive' error to different copy, not the sign-in copy", () => {
      expect(describeDesktopOnlyRouteError({ status: 401, message: "Browser owner authentication required" })).toBe(
        "Browser unavailable right now.",
      );
    });

    it("does not collapse an unrelated 401 into either mapped copy", () => {
      expect(describeDesktopOnlyRouteError({ status: 401, message: "anything at all" })).toBe("anything at all");
    });
  });

  it("falls back to the same three-way text match only when there is no status at all", () => {
    expect(describeDesktopOnlyRouteError({ message: "no route: GET /api/bots/bot-1/computer" })).toBe(
      "This isn't available from here.",
    );
    expect(describeDesktopOnlyRouteError({ message: "browser owner authentication required" })).toBe(
      "This needs your Mac to sign in first.",
    );
    expect(describeDesktopOnlyRouteError({ message: "Browser owner authentication required" })).toBe(
      "Browser unavailable right now.",
    );
  });

  it("leaves every other message untouched", () => {
    expect(describeDesktopOnlyRouteError({ status: 500, message: "The computer did not return a live desktop link" })).toBe(
      "The computer did not return a live desktop link",
    );
    expect(describeDesktopOnlyRouteError({ message: "" })).toBe("");
  });
});

describe("routeErrorFrom", () => {
  it("reads status and body.code off the Error api() throws", () => {
    const cause = Object.assign(new Error("no route: GET /api/bots/bot-1/computer"), {
      status: 404,
      body: { error: "no route: GET /api/bots/bot-1/computer" },
    });
    expect(routeErrorFrom(cause)).toEqual({
      status: 404,
      code: undefined,
      message: "no route: GET /api/bots/bot-1/computer",
    });
  });

  it("carries the server's code through", () => {
    const cause = Object.assign(new Error("Browser owner authentication required"), {
      status: 401,
      body: { error: "Browser owner authentication required", code: "browser_inactive" },
    });
    expect(routeErrorFrom(cause)).toEqual({ status: 401, code: "browser_inactive", message: "Browser owner authentication required" });
  });

  it("degrades gracefully for a cause that is not an Error", () => {
    expect(routeErrorFrom("boom")).toEqual({ message: "boom" });
  });
});

// Fix round 1: the mapping above used to key on message text alone, with
// nothing tying it to the server's actual strings — a wording change at
// either site would silently stop it firing and the raw string would
// render again. Fix round 2 adds a third pin: the two DIFFERENT 401s on
// /api/bots/:id/browser, which round 1's status-401-alone rule wrongly
// collapsed into one message (phone-panels-rereview.md). All three pins
// read the real source, so a wording, status, or code change at any of the
// three sites fails HERE, not silently in production.
describe("pinned against the server's actual strings and codes", () => {
  const index = readFileSync(fileURLToPath(new URL("../../server/index.ts", import.meta.url)), "utf8");
  const ownerApi = readFileSync(fileURLToPath(new URL("../../server/browser-owner-api.ts", import.meta.url)), "utf8");

  it("the route-table fallthrough (server/index.ts ~18079): 404, `no route: ${method} ${path}`, no code", () => {
    expect(index).toContain("return json(res, 404, { error: `no route: ${method} ${path}` });");
    // and the mapping actually matches what that template literal produces
    expect(describeDesktopOnlyRouteError({ status: 404, message: "no route: GET /api/bots/bot-1/computer" })).toBe(
      "This isn't available from here.",
    );
  });

  it("the door's device-auth refusal (server/index.ts ~11386): 401, code desktop_only", () => {
    const line = 'if (!desktop && !paired) return json(res, 401, { error: "browser owner authentication required", code: "desktop_only" });';
    expect(index).toContain(line);
    const message = line.match(/error: "([^"]*)"/)?.[1];
    const code = line.match(/code: "([^"]*)"/)?.[1];
    expect(message).toBe("browser owner authentication required");
    expect(code).toBe("desktop_only");
    expect(describeDesktopOnlyRouteError({ status: 401, code, message: message! })).toBe(
      "This needs your Mac to sign in first.",
    );
  });

  it("browserOwnerRequest's 'authority inactive' check (server/browser-owner-api.ts ~10): 401, code browser_inactive, DIFFERENT wording than the door's", () => {
    const line = 'const valid = () => { if (!authority?.active()) throw Object.assign(new Error("Browser owner authentication required"), { status: 401, code: "browser_inactive" }); };';
    expect(ownerApi).toContain(line);
    const message = line.match(/new Error\("([^"]*)"\)/)?.[1];
    const code = line.match(/code: "([^"]*)"/)?.[1];
    expect(message).toBe("Browser owner authentication required");
    expect(code).toBe("browser_inactive");
    // capital-B, distinct from the door's lowercase-b string one test up —
    // the whole point of the round-2 fix is that these two must not collapse.
    expect(message).not.toBe("browser owner authentication required");
    expect(describeDesktopOnlyRouteError({ status: 401, code, message: message! })).toBe(
      "Browser unavailable right now.",
    );
  });
});

// Fix round 1 (raw route/no-such-route strings) and fix round 2 (both 401
// wordings): no raw internal string can ever reach a person through this
// function, regardless of how the caller's error is shaped, and the two
// 401s must never produce the SAME output as each other's raw text either.
describe("a raw route/auth string never renders", () => {
  const rawStrings = [
    "no route: GET /api/bots/bot-1/computer",
    "no route: POST /api/bots/bot-1/browser",
    "browser owner authentication required",
    "Browser owner authentication required",
  ];
  const statusFor = (message: string) => (message.startsWith("no route:") ? 404 : 401);

  it("never returns the raw string verbatim, with a status", () => {
    for (const message of rawStrings) {
      expect(describeDesktopOnlyRouteError({ status: statusFor(message), message })).not.toBe(message);
    }
  });

  it("never returns the raw string verbatim, without a status (the fallback path)", () => {
    for (const message of rawStrings) {
      expect(describeDesktopOnlyRouteError({ message })).not.toBe(message);
    }
  });

  it("never returns the raw string verbatim through routeErrorFrom, exactly as a real catch block sees it", () => {
    for (const message of rawStrings) {
      const status = statusFor(message);
      const cause = Object.assign(new Error(message), { status, body: { error: message } });
      expect(describeDesktopOnlyRouteError(routeErrorFrom(cause))).not.toBe(message);
    }
  });

  it("the two different 401s never produce the same plain-words output as each other", () => {
    const deviceAuth = describeDesktopOnlyRouteError({ status: 401, message: "browser owner authentication required" });
    const inactive = describeDesktopOnlyRouteError({ status: 401, message: "Browser owner authentication required" });
    expect(deviceAuth).not.toBe(inactive);
  });
});
