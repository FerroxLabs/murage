import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collapseKey, newEventRef, newKeySecret, newToken, threadGroup } from "./mobile-push-keys.ts";
import { EVENT_REF, TOKEN_PATTERNS } from "../shared/mobile-push.ts";

const push = JSON.parse(readFileSync(new URL("../apps/mobile/contract/push.json", import.meta.url), "utf8")) as {
  collapseKeys: Array<{ bindingId: string; secret: string; key: string; collapseKey: string }>;
  threadGroups: Array<{ bindingId: string; secret: string; botId: string; threadGroup: string }>;
};

describe("key derivation", () => {
  it.each(push.collapseKeys)("collapse($bindingId, $key)", (c) => {
    expect(collapseKey(c.secret, c.key)).toBe(c.collapseKey);
  });
  it.each(push.threadGroups)("threadGroup($bindingId, $botId)", (c) => {
    expect(threadGroup(c.secret, c.botId)).toBe(c.threadGroup);
  });
  it("keys both with the host-only secret: a relay knowing the binding and a guess at the id cannot reproduce them", () => {
    const secret = newKeySecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(newKeySecret()).not.toBe(secret);
    expect(collapseKey(secret, "req-1")).toMatch(/^[0-9a-f]{32}$/);
    expect(threadGroup(secret, "scout")).toMatch(/^[0-9a-f]{16}$/);
    expect(threadGroup(secret, "scout")).not.toBe(threadGroup(newKeySecret(), "scout"));
    expect(() => collapseKey("not-hex", "req-1")).toThrow();
  });
  it("mints refs and tokens in the contract's shapes", () => {
    expect(newEventRef()).toMatch(EVENT_REF);
    expect(newToken("murage_pd_")).toMatch(TOKEN_PATTERNS.detail);
    expect(newToken("murage_pr_")).toMatch(TOKEN_PATTERNS.respond);
    expect(newEventRef()).not.toBe(newEventRef());
  });
});
