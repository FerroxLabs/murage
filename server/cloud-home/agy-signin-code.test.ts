// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-chat Antigravity sign-in code is consumed once from a dedicated route and never reaches the message
// pipeline (messages DB, send store, transcript, engine, pty transcript, logs).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgySigninHolds, SIGNIN_CODE_SHAPE, SIGNIN_HOLD_TTL_MS } from "./agy-signin-code.ts";
import { cloudRouteDecision } from "../route-policy.ts";

const CODE = "4/0AfJohXkQz9_fixtureCodeNeverStored-12345";
const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("./agy-signin-routes.ts", import.meta.url), "utf8");

describe("holds", () => {
  it("write the code once to the held pty, zero the buffer and consume the hold", () => {
    let seen = "", buffer: Buffer | undefined;
    const holds = new AgySigninHolds();
    holds.hold("bot-a", data => { seen = data.toString("utf8"); buffer = data; return true; });
    expect(holds.submit("bot-a", ` ${CODE} `)).toBe("ok");
    expect(seen).toBe(`${CODE}\r`);
    expect([...buffer!].every(byte => byte === 0)).toBe(true);
    expect(holds.submit("bot-a", CODE)).toBe("none");
    expect(holds.has("bot-a")).toBe(false);
  });
  it("refuses a bad shape without writing and without consuming the hold", () => {
    let wrote = false;
    const holds = new AgySigninHolds();
    holds.hold("bot-a", () => { wrote = true; return true; });
    for (const bad of ["short", "has space in it 123456789012345", 42, undefined, "x".repeat(600)]) expect(holds.submit("bot-a", bad)).toBe("bad");
    expect(wrote).toBe(false);
    expect(holds.has("bot-a")).toBe(true);
  });
  it("says gone when the pty has already closed, and consumes the hold", () => {
    const holds = new AgySigninHolds();
    holds.hold("bot-a", () => false);
    expect(holds.submit("bot-a", CODE)).toBe("gone");
    expect(holds.has("bot-a")).toBe(false);
  });
  it("expires after the TTL and is per bot", () => {
    let now = 1_000;
    const holds = new AgySigninHolds(() => now);
    holds.hold("bot-a", () => true);
    expect(holds.has("bot-b")).toBe(false);
    now += SIGNIN_HOLD_TTL_MS + 1;
    expect(holds.has("bot-a")).toBe(false);
    expect(holds.submit("bot-a", CODE)).toBe("none");
  });
  it("calls a line a code only while a sign-in is pending for that bot, and only by shape", () => {
    const holds = new AgySigninHolds();
    expect(holds.looksLikeCode("bot-a", CODE)).toBe(false);
    holds.hold("bot-a", () => true);
    expect(holds.looksLikeCode("bot-a", CODE)).toBe(true);
    expect(holds.looksLikeCode("bot-b", CODE)).toBe(false);
    for (const text of ["hello there", "please write me a function that sorts", "https://example.com/a/b/c/d/e/f", "short"]) expect(holds.looksLikeCode("bot-a", text), text).toBe(false);
    expect(SIGNIN_CODE_SHAPE.test("a".repeat(19))).toBe(false);
  });
});

describe("wiring in server/index.ts", () => {
  const code = index.indexOf("/engine-signin\\/code$/");
  const messages = index.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);");
  const guard = index.indexOf("swallowPastedCode({ cloudHome, botId: m[1], text,");
  const accept = index.indexOf("sendStore.accept({", messages);
  it("registers the code route before /messages, so it never reaches the message pipeline", () => {
    expect(code).toBeGreaterThan(0);
    expect(code).toBeLessThan(messages);
  });
  it("guards /messages before the fingerprint, the send store and the engine", () => {
    expect(guard).toBeGreaterThan(messages);
    expect(guard).toBeLessThan(index.indexOf("sendFingerprint(text", messages));
    expect(guard).toBeLessThan(accept);
    expect(guard).toBeLessThan(index.indexOf("startTurn(bot.id, text", messages));
  });
  it("the code route's handler never touches the message pipeline, logs or echoes the body", () => {
    for (const handler of [index.slice(code, messages), routes]) {
      for (const forbidden of ["sendStore", "sendFingerprint", "startTurn", "console.", "log(", "JSON.stringify(code"]) expect(handler, forbidden).not.toContain(forbidden);
    }
    expect(routes).toContain("owner-desktop");
    expect(routes).toContain("code = undefined");
  });
  it("is a desktop-class owner route in the cloud route policy", () => {
    expect(cloudRouteDecision("POST", "/api/bots/bot-a/engine-signin/code", "owner-desktop", { code: CODE })).toBe("step-up required");
    expect(cloudRouteDecision("POST", "/api/bots/bot-a/engine-signin/code", "owner-desktop", { code: CODE }, true)).toBe("allow");
    expect(cloudRouteDecision("POST", "/api/bots/bot-a/engine-signin/code", "browser", { code: CODE })).not.toBe("allow");
  });
});
