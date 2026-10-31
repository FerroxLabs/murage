// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tester feedback relay (UX lane L-FB): the contract, the scrub, the deadline and the answers the form shows.
// No network: every control-plane call is an injected fetch. Fake key shapes only.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOVED_ID, FEEDBACK_ORIGINS, feedbackAppVersion, feedbackEndpoint, feedbackInstallId, feedbackOs, relayFeedback, REMOVED, scrubFeedbackText,
  type FeedbackRequest,
} from "./feedback-relay.ts";
import { feedbackRoute } from "./feedback-routes.ts";
import { readBody } from "./read-body.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const INSTALL = "8f7d3c2e-1b4a-4c5d-9e8f-0a1b2c3d4e5f";
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surface: "desktop",
    screen: "today",
    title: "Today",
    state: { page: "today", botId: "juno", selectedCard: "card-1", gates: [{ id: "flux", reason: "Waiting on Flux Router" }] },
    controls: [{ id: "send", label: "Send", address: "help/feedback/send" }],
    words: "I could not find where to change the morning brief.",
    createdAt: "2026-11-02T12:00:00.000Z",
    ...overrides,
  };
}

function fakeFetch(answer: (() => Promise<Response>) | Response = new Response('{"ok":true,"id":"0b8f3c2e-1b4a-4c5d-9e8f-0a1b2c3d4e5f"}', { status: 200 })) {
  const calls: Array<{ url: string; init: RequestInit; payload: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, payload: JSON.parse(String(init?.body ?? "{}")) });
    return typeof answer === "function" ? answer() : answer;
  }) as typeof fetch;
  return { impl, calls };
}

const deps = (f: typeof fetch, extra: Record<string, unknown> = {}) => ({
  fetch: f, installId: () => INSTALL, appVersion: "1.0.12", os: "macos" as const, endpoint: "https://cp.example.test/v1/owner-feedback", ...extra,
});
const route = (b: unknown, f: typeof fetch, extra: Record<string, unknown> = {}) =>
  feedbackRoute({ method: "POST", path: "/api/feedback", readBody: async () => b }, deps(f, extra));

describe("POST /api/feedback: the contract", () => {
  it("sends one item with the install id, version and OS added, and answers sent", async () => {
    const f = fakeFetch();
    expect(await route(body({ replyEmail: "Me@Example.com" }), f.impl)).toEqual({ status: 200, body: { sent: true } });
    expect(f.calls).toHaveLength(1);
    const sent = f.calls[0];
    expect(sent.url).toBe("https://cp.example.test/v1/owner-feedback");
    expect(sent.init.method).toBe("POST");
    expect(sent.payload).toMatchObject({ installId: INSTALL, appVersion: "1.0.12", os: "macos", surface: "desktop", screen: "today", replyEmail: "me@example.com" });
    expect(Object.keys(sent.payload).sort()).toEqual(
      ["appVersion", "controls", "createdAt", "installId", "os", "replyEmail", "screen", "state", "surface", "title", "words"],
    );
  });

  it.each([
    ["an unknown field holding a message body", { messageText: "the owner's private chat" }],
    ["a draft inside the envelope state", { state: { page: "today", draft: "half-typed message" } }],
    ["a control carrying a value", { controls: [{ id: "x", label: "y", value: "typed" }] }],
    ["the client naming its own install id", { installId: INSTALL }],
    ["file contents as the selected card", { state: { selectedCard: "Dear Sam, the contract is attached" } }],
    ["words over 2000 characters", { words: "a".repeat(2001) }],
    ["empty words", { words: "  " }],
    ["a bad surface", { surface: "watch" }],
  ])("refuses %s with 400 and sends nothing", async (_name, overrides) => {
    const f = fakeFetch();
    const answer = await route(body(overrides), f.impl);
    expect(answer?.status).toBe(400);
    expect(answer?.body).toMatchObject({ sent: false, reason: "invalid" });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a body over 16 KB with 413", async () => {
    const f = fakeFetch();
    const answer = await feedbackRoute({ method: "POST", path: "/api/feedback", readBody: async (max) => {
      expect(max).toBe(16 * 1024);
      throw Object.assign(new Error("body too large"), { status: 413 });
    } }, deps(f.impl));
    expect(answer?.status).toBe(413);
    expect(f.calls).toHaveLength(0);
  });

  it("answers only its own path and method", async () => {
    const f = fakeFetch();
    expect(await feedbackRoute({ method: "POST", path: "/api/other", readBody: async () => body() }, deps(f.impl))).toBeNull();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect(await feedbackRoute({ method, path: "/api/feedback", readBody: async () => body() }, deps(f.impl))).toBeNull();
  });
});

describe("scrub before it leaves the computer", () => {
  it.each([
    ["sk-", "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234"], // secret-scan: fixture
    ["ghp_", "ghp_FAKEfakeFAKEfakeFAKEfake1234"], // secret-scan: fixture
    ["AKIA", "AKIAFAKEFAKEFAKE1234"], // secret-scan: fixture
    ["xoxb-", "xoxb" + "-1234567890-FAKEFAKEFAKEFAKE"], // secret-scan: fixture, in two parts so the public push passes
  ])("removes a fake %s key from the words, the title and a label", async (_name, key) => {
    const f = fakeFetch();
    await route(body({ words: `my key ${key} broke it`, title: `T ${key}`, controls: [{ id: "c", label: key }] }), f.impl);
    const sent = JSON.stringify(f.calls[0].payload);
    expect(sent).not.toContain(key);
    expect(f.calls[0].payload.words).toBe(`my key ${REMOVED} broke it`);
  });

  it("leaves ordinary words as typed", () => {
    expect(scrubFeedbackText("The Send button was hidden behind the panel.")).toBe("The Send button was hidden behind the panel.");
  });
});

describe("more that never leaves the computer", () => {
  it("replaces an id that is shaped like a key, in every id field", async () => {
    const f = fakeFetch();
    const key = "ghp_FAKEfakeFAKEfakeFAKEfake1234"; // secret-scan: fixture
    await route(body({ screen: key, state: { botId: key, selectedCard: key, gates: [{ id: key, reason: "r" }] }, controls: [{ id: key, label: "x" }] }), f.impl);
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("ghp_");
    expect(f.calls[0].payload.screen).toBe(REMOVED_ID);
  });

  it("removes a private key pasted without its footer, and a whole block", () => {
    // Made up and put together here, so no key-shaped text sits in this file for a secret scan to stop on.
    const pem = (edge: "BEGIN" | "END", kind = "") => `-----${edge} ${kind}PRIVATE KEY-----`;
    expect(scrubFeedbackText(`here ${pem("BEGIN", "RSA ")}\nMIIfakehalf`)).toBe(`here ${REMOVED}`);
    expect(scrubFeedbackText(`a ${pem("BEGIN")}\nMIIfake\n${pem("END")} b`)).toBe(`a ${REMOVED} b`);
  });

  it("keeps the words inside 2000 characters after the scrub lengthens them", async () => {
    const f = fakeFetch();
    const words = "?key=a ".repeat(285).trim(); // 1994 characters, longer once each value becomes [removed]
    expect(words.length).toBeLessThanOrEqual(2000);
    expect((await route(body({ words }), f.impl))?.body).toEqual({ sent: true });
    expect(String(f.calls[0].payload.words).length).toBeLessThanOrEqual(2000);
  });
});

describe("answers the form can show", () => {
  it("does not call a 200 that is not the control plane's answer sent", async () => {
    const f = fakeFetch(new Response("<html>captive portal</html>", { status: 200 }));
    expect((await route(body(), f.impl))?.body).toEqual({ sent: false, reason: "unavailable" });
  });

  it("answers timeout when the request body trickles past the deadline", async () => {
    const f = fakeFetch();
    const answer = await feedbackRoute({ method: "POST", path: "/api/feedback", readBody: () => new Promise(() => {}) }, deps(f.impl, { deadlineMs: 50 }));
    expect(answer).toEqual({ status: 200, body: { sent: false, reason: "timeout" }, close: true });
    expect(f.calls).toHaveLength(0);
  });

  it("stops the body read itself at the deadline: listeners off, bytes dropped, connection closed", async () => {
    const stream = new PassThrough();
    const req = stream as unknown as IncomingMessage;
    stream.write('{"surface":"desk');
    const answer = await feedbackRoute(
      { method: "POST", path: "/api/feedback", readBody: (max, signal) => readBody(req, max, signal) },
      deps(fakeFetch().impl, { deadlineMs: 50 }),
    );
    expect(answer).toEqual({ status: 200, body: { sent: false, reason: "timeout" }, close: true });
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    stream.write("more bytes after the answer");
    stream.emit("error", new Error("socket reset")); // must not throw
  });

  it.each([
    [429, "rate_limited"],
    [400, "refused"],
    [413, "refused"],
    [503, "unavailable"],
    [500, "unavailable"],
  ])("maps a %s from the control plane to %s", async (status, reason) => {
    const f = fakeFetch(new Response("{}", { status }));
    expect((await route(body(), f.impl))?.body).toEqual({ sent: false, reason });
  });

  it("says offline when the network is down", async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect((await route(body(), f.impl))?.body).toEqual({ sent: false, reason: "offline" });
  });

  it("gives up at the deadline and says timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    const started = Date.now();
    const result = await relayFeedback(body() as FeedbackRequest, deps(hang, { deadlineMs: 50 }));
    expect(result).toEqual({ sent: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("uses a 10 second deadline by default and refuses redirects", async () => {
    const f = fakeFetch();
    await route(body(), f.impl);
    expect(f.calls[0].init.redirect).toBe("error");
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("what the server adds", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) removeTempDirSync(d); });

  it("keeps one random install id in the data folder and makes a new one when it is damaged", () => {
    const dir = mkdtempSync(join(tmpdir(), "feedback-id-"));
    dirs.push(dir);
    const first = feedbackInstallId(dir);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(feedbackInstallId(dir)).toBe(first);
    expect(readFileSync(join(dir, "feedback-install-id"), "utf8").trim()).toBe(first);
    writeFileSync(join(dir, "feedback-install-id"), "garbage");
    expect(feedbackInstallId(dir)).not.toBe(first);
  });

  it("names the OS and a version the control plane accepts", () => {
    expect([feedbackOs("darwin"), feedbackOs("win32"), feedbackOs("linux")]).toEqual(["macos", "windows", "linux"]);
    expect(feedbackAppVersion("1.0.12")).toBe("1.0.12");
    expect(feedbackAppVersion("")).toBe("dev");
    expect(feedbackAppVersion("1.0.12; rm -rf")).toBe("dev");
  });

  it("goes to production unless MURAGE_CONTROL_PLANE_URL names staging, and never to another host", () => {
    expect(feedbackEndpoint({})).toBe(`${FEEDBACK_ORIGINS.prod}/v1/owner-feedback`);
    expect(feedbackEndpoint({ MURAGE_CONTROL_PLANE_URL: `${FEEDBACK_ORIGINS.staging}/` })).toBe(`${FEEDBACK_ORIGINS.staging}/v1/owner-feedback`);
    expect(feedbackEndpoint({ MURAGE_CONTROL_PLANE_URL: "https://evil.example" })).toBe(`${FEEDBACK_ORIGINS.prod}/v1/owner-feedback`);
  });
});

describe("round 2 smaller points", () => {
  it("scrubs a credential in a field under 8 characters", () => {
    for (const short of ["?key=ab", "&key=a", "?token=x"]) expect(scrubFeedbackText(short)).toContain(REMOVED);
  });

  it("does not send a reply email the scrubber would change", async () => {
    const f = fakeFetch();
    await route(body({ replyEmail: "sk-ant-abcdefghijklmnopqrstuv@example.com" }), f.impl); // secret-scan: fixture
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].payload).not.toHaveProperty("replyEmail");
  });
});
