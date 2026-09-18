// F3 — an unreachable model server used to say, in the chat, exactly this:
//
//     fetch failed
//
// undici's own two words, escaping before the driver's `upstream ` label was
// applied. No host, no engine, no next step — and this is the commonest local
// failure there is: the box is off, or the tailnet dropped.
import { describe, expect, it } from "vitest";

import { endpointName, isEndpointUnreachable, unreachableEndpointMessage } from "./provider-error.ts";
import { ERROR_MESSAGE_MAX } from "./provider-error.ts";

/** What undici actually throws when nothing is listening. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:11434`), { code, syscall: "connect" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("recognising a connection that never happened", () => {
  it("sees through undici's wrapper to the errno", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ETIMEDOUT"]) {
      expect(isEndpointUnreachable(fetchFailed(code))).toBe(true);
    }
  });

  it("still catches a bare `fetch failed` with no cause at all", () => {
    expect(isEndpointUnreachable(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not claim a server that answered badly", () => {
    // These have a response. Rewriting them would hide the real cause.
    expect(isEndpointUnreachable(new Error("upstream HTTP 401: bad key"))).toBe(false);
    expect(isEndpointUnreachable(new Error("upstream returned an empty reply"))).toBe(false);
    expect(isEndpointUnreachable(Object.assign(new Error("stop"), { name: "AbortError" }))).toBe(false);
    expect(isEndpointUnreachable(undefined)).toBe(false);
  });
});

describe("naming the address without leaking what is in it", () => {
  it("keeps the host and port and drops the path and query", () => {
    expect(endpointName("http://192.168.1.50:11434/v1")).toBe("192.168.1.50:11434");
    expect(endpointName("https://api.example.test/v1?key=sk-secret")).toBe("api.example.test");
  });

  it("never answers with nothing", () => {
    expect(endpointName("")).toBe("the model server");
    expect(endpointName(undefined)).toBe("the model server");
    expect(endpointName("not a url")).toBe("the model server");
  });
});

describe("what the chat bubble says", () => {
  const message = unreachableEndpointMessage("http://192.168.1.50:11434/v1");

  it("names the address and what to check, and never says `fetch failed`", () => {
    expect(message).toContain("192.168.1.50:11434");
    expect(message).not.toContain("fetch failed");
    expect(message).toMatch(/could not reach/i);
    expect(message).toMatch(/running/i);
  });

  it("fits the transcript without being truncated", () => {
    expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
  });

  it("says something useful even with no address to name", () => {
    expect(unreachableEndpointMessage(undefined)).toContain("the model server");
  });
});
