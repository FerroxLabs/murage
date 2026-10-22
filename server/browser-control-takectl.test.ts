// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 real-engine gate B4 then B4b (Windows, RUN C): right after Take control the
// owner's first mousePressed got 500 "Browser stream disconnected or busy". Take
// control drops the live view and reconnects it in the background, and the
// relay's input refuses while no stream socket is open. The relay here does the
// same: its stream opens a moment after connect() is asked, as a real one does
// (a `stream status` command, then a WebSocket handshake).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController } from "./browser-control.ts";
import type { NativeBrowser } from "./browser-native-relay.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) removeTempDirSync(path); });

function relayLike(connectMs: number) {
  const sent: Record<string, unknown>[] = [];
  let open = false;
  let sensitive = false;
  const make = (): NativeBrowser => ({
    protected: async () => sensitive,
    request: async (method, call) => {
      if (method === "tools/list") return { tools: [{ name: "agent_browser_open" }] };
      const url = String((call?.arguments as { url?: string } | undefined)?.url ?? "");
      sensitive = url.endsWith("/login.html");
      return { content: [{ type: "text", text: "page" }] };
    },
    command: async () => ({}),
    connect: async () => { await new Promise((resolve) => setTimeout(resolve, connectMs)); open = true; return "stream"; },
    input: (event) => { if (!open) throw new Error("Browser stream disconnected or busy"); sent.push(event); },
    resetStream: () => { open = false; },
    close: async () => { open = false; sensitive = false; },
  });
  return { make, sent };
}

describe("Take control: the owner's first input after a control change", () => {
  it("B4 then B4b: lock, take, reopen, return, bot reads a page, take again, then a click at once reaches the page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-takectl-test-")); directories.push(dir);
    const relay = relayLike(40);
    const c = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: relay.make });
    c.register("p", { command: "fixture", args: [], env: {} });
    const open = (url: string) => c.dispatch("p", "tools/call", { name: "agent_browser_open", arguments: { url } }, () => true);
    // B4: the password page locks, Take control, Reopen blank page, Return to bot, the bot reads a new page.
    await expect(open("http://127.0.0.1/login.html")).rejects.toThrow();
    expect(c.status("p").protectedReason).toBe("sensitive-page");
    const take = await c.take("p", "owner");
    const reopened = await c.reopen("p", "owner", take.generation);
    expect(reopened.protectedDocument).toBe(false);
    await c.release("p", "owner", reopened.generation);
    await open("http://127.0.0.1/reopen.html");
    // B4b: Take control, and the owner clicks straight away.
    const held = await c.take("p", "owner");
    expect(held.connected).toBe(false);
    for (const eventType of ["mousePressed", "mouseReleased"]) {
      await c.input("p", "owner", held.generation, { type: "input_mouse", eventType, x: 200, y: 200, button: "left", clickCount: 1 });
    }
    expect(relay.sent.map((event) => event.eventType)).toEqual(["mousePressed", "mouseReleased"]);
    expect(c.status("p")).toMatchObject({ held: true, connected: true, protectedDocument: true, protectedReason: "owner-input" });
    const again = await c.reopen("p", "owner", c.status("p").generation);
    expect(again.protectedDocument).toBe(false);
    expect((await c.release("p", "owner", again.generation)).held).toBe(false);
  });

  it("input that waited for the stream is refused, and never sent, when control changed meanwhile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-takectl-test-")); directories.push(dir);
    const relay = relayLike(40);
    const c = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: relay.make });
    c.register("p", { command: "fixture", args: [], env: {} });
    const held = await c.take("p", "owner");
    const click = c.input("p", "owner", held.generation, { type: "input_mouse", eventType: "mousePressed", x: 1, y: 1 });
    await c.release("p", "owner", held.generation);
    await expect(click).rejects.toThrow();
    expect(relay.sent).toEqual([]);
  });

  it("a connect that never resolves gives a 503 within 10 s and sends no input", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "murage-takectl-test-")); directories.push(dir);
      const sent: Record<string, unknown>[] = [];
      const make = (): NativeBrowser => ({
        protected: async () => false,
        request: async () => ({ tools: [] }),
        command: async () => ({}),
        connect: () => new Promise<string>(() => {}),
        input: (event) => { sent.push(event); },
        resetStream: () => {},
        close: async () => {},
      });
      const c = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: make });
      c.register("p", { command: "fixture", args: [], env: {} });
      const held = await c.take("p", "owner");
      const click = c.input("p", "owner", held.generation, { type: "input_mouse", eventType: "mousePressed", x: 1, y: 1 });
      const outcome = click.then(() => null, (error: unknown) => error as { status?: number; message: string });
      await vi.advanceTimersByTimeAsync(10_001);
      const error = await outcome;
      expect(error).toMatchObject({ status: 503, message: "The browser view is still reconnecting. Try again." });
      expect(sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
