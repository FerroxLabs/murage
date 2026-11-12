// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createBrowserEngineLoginBridge, engineLoginSocketUrl } from "./engine-login-browser";
import { BROWSER_SIGNIN_ENGINES, signInOfferHere } from "./cloud-signin-status";

class FakeSocket {
  static last: FakeSocket; readyState = 0; binaryType = ""; sent: unknown[] = []; closed: [number?, string?] | null = null;
  onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null; onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send(data: unknown) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed = [code, reason]; this.onclose?.({ code: code ?? 1000, reason: reason ?? "" }); }
}
const bridge = (ticket = async () => ({ ticket: "T1" })) => createBrowserEngineLoginBridge({ ticket, openSocket: (url) => new FakeSocket(url) as unknown as WebSocket, origin: () => "https://home.example", openTab: () => true });

describe("browser engine sign-in bridge", () => {
  it("asks for a ticket, then opens the relay with it; the key of an enrollment is the first message and never in the URL", async () => {
    const b = bridge();
    const started = b.start({ homeId: "h", engine: "codex", action: "enroll-key", secret: "k".repeat(30) });
    await Promise.resolve(); await Promise.resolve();
    FakeSocket.last.readyState = 1; FakeSocket.last.onopen!();
    expect(await started).toMatchObject({ ok: true });
    expect(FakeSocket.last.url).toBe("wss://home.example/api/engine-login/codex?action=enroll-key&loginTicket=T1");
    expect(FakeSocket.last.sent).toEqual(["k".repeat(30)]);
    expect(FakeSocket.last.url).not.toContain("kkkk");
  });
  it("a refused ticket is a plain failure and opens no socket", async () => {
    FakeSocket.last = undefined as never;
    const result = await bridge(async () => { throw new Error("Enter the code we emailed you."); }).start({ homeId: "h", engine: "claudeAgent", action: "login" });
    expect(result).toEqual({ ok: false, code: "refused", message: "Enter the code we emailed you." });
    expect(FakeSocket.last).toBeUndefined();
  });
  it("sends a pasted code, reports the relay's reason on close, and opens only vendor links", async () => {
    const b = bridge(); const closed: string[] = []; const data: string[] = [];
    b.onClosed((p) => closed.push(p.reason)); b.onData((p) => data.push(new TextDecoder().decode(p.data)));
    const started = b.start({ homeId: "h", engine: "claudeAgent", action: "login" });
    await Promise.resolve(); await Promise.resolve();
    FakeSocket.last.readyState = 1; FakeSocket.last.onopen!();
    const { id } = (await started) as { ok: true; id: string };
    FakeSocket.last.onmessage!({ data: new TextEncoder().encode("hello").buffer });
    expect(data).toEqual(["hello"]);
    expect(await b.input({ id, data: "code\r" })).toEqual({ ok: true }); expect(FakeSocket.last.sent).toEqual(["code\r"]);
    expect((await b.openLink({ id, url: "https://claude.com/cai/oauth/authorize?x=1" })).ok).toBe(true);
    expect((await b.openLink({ id, url: "https://evil.example/claude.com" })).ok).toBe(false);
    FakeSocket.last.onclose!({ code: 1001, reason: "idle-timeout" });
    expect(closed).toEqual(["idle-timeout"]);
  });
  it("builds a wss URL for https and carries bot and provider", () => {
    expect(engineLoginSocketUrl("https://h.example", { engine: "opencodeGo", action: "enroll-key", provider: "zen" }, "T")).toBe("wss://h.example/api/engine-login/opencodeGo?action=enroll-key&provider=zen&loginTicket=T");
  });
});

describe("the sign-in offer in a browser", () => {
  it("shows for the engines a browser can sign in, and never for one it cannot", () => {
    const browserOnly = { homePage: true, bridge: false };
    for (const engine of ["claudeAgent", "codex", "grokAgent", "kimiAgent"]) expect(signInOfferHere(engine, browserOnly)).toBe(true);
    for (const engine of ["opencodeGo", "antigravityAgent"]) expect(signInOfferHere(engine, browserOnly)).toBe(false);
    expect(BROWSER_SIGNIN_ENGINES).not.toContain("opencodeGo");
  });
});
