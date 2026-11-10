// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real Chromium, two origins served from this test (localhost and 127.0.0.1 are different sites, so the iframe is an
// out-of-process frame): the page lock sees it. Runs only where CHROME_BIN names a Chrome (build host container).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const chrome = process.env.CHROME_BIN;
const cleanup: Array<() => void> = [];
afterAll(() => { for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch { /* best effort */ } } });

async function serve(body: (port: number) => Record<string, string>): Promise<{ port: number; server: Server }> {
  let pages: Record<string, string> = {};
  const server = createServer((req, res) => { const html = pages[req.url ?? "/"]; res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html" }); res.end(html ?? ""); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  pages = body(port);
  cleanup.push(() => server.close());
  return { port, server };
}

async function launch(url: string): Promise<{ child: ChildProcess; endpoint: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mb-oopif-"));
  const child = spawn(chrome!, ["--headless", "--no-sandbox", "--disable-gpu", "--site-per-process", "--remote-debugging-port=0", `--user-data-dir=${dir}`, url], { stdio: ["ignore", "ignore", "pipe"] });
  cleanup.push(() => { child.kill("SIGKILL"); removeTempDirSync(dir); });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("chrome did not start")), 20_000);
    child.stderr!.on("data", (chunk) => { text += chunk; const m = /DevTools listening on (ws:\/\/\S+)/u.exec(text); if (m) { clearTimeout(timer); resolve(m[1]!); } });
    child.once("exit", () => reject(new Error("chrome exited")));
  });
  return { child, endpoint };
}

/** Plain CDP, to show what the old lock looked at. */
async function frameTreeOf(endpoint: string): Promise<{ childFrames: number }> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  let serial = 0; const waiting = new Map<number, (m: any) => void>();
  socket.on("message", (raw) => { const m = JSON.parse(String(raw)); if (typeof m.id === "number") waiting.get(m.id)?.(m); });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => { const id = ++serial; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  try {
    const targets = await send("Target.getTargets");
    const page = targets.result.targetInfos.find((t: any) => t.type === "page");
    const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const tree = await send("Page.getFrameTree", {}, attached.result.sessionId);
    return { childFrames: tree.result.frameTree.childFrames?.length ?? 0 };
  } finally { socket.terminate(); }
}

async function settledVerdict(endpoint: string, want: boolean, ms = 8000): Promise<boolean> {
  const guard = new BrowserDocumentGuard(async () => endpoint, { endpoint });
  cleanup.push(() => guard.close());
  const until = Date.now() + ms; let last = !want;
  while (Date.now() < until) {
    try { last = await guard.protected(); } catch { last = !want; }
    if (last === want) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

describe.skipIf(!chrome)("real Chromium: an out-of-process frame locks the page", () => {
  it("a page with a cross-site iframe LOCKS, though Page.getFrameTree shows no child frame", async () => {
    const inner = await serve(() => ({ "/": "<p>pay here</p>" }));
    const outer = await serve(() => ({ "/": `<h1>shop</h1><iframe src="http://127.0.0.1:${inner.port}/"></iframe>` }));
    const { endpoint } = await launch(`http://localhost:${outer.port}/`);
    // Wait until Chrome has the frame as its own target, then show the old lock's blind spot.
    expect(await settledVerdict(endpoint, true)).toBe(true);
    expect((await frameTreeOf(endpoint)).childFrames).toBe(0);
  }, 40_000);
  it("an ordinary page with no frame stays unlocked (Hobart)", async () => {
    const page = await serve(() => ({ "/": "<h1>Hobart</h1>" + "<p>text</p>".repeat(5000) }));
    const { endpoint } = await launch(`http://localhost:${page.port}/`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await settledVerdict(endpoint, false, 4000)).toBe(false);
  }, 40_000);
  it("a password page still locks", async () => {
    const page = await serve(() => ({ "/": '<input type="password">' }));
    const { endpoint } = await launch(`http://localhost:${page.port}/`);
    expect(await settledVerdict(endpoint, true)).toBe(true);
  }, 40_000);
});
