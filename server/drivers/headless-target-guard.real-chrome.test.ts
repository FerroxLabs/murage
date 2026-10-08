// Real Chrome, not a fake socket: proves a tab the engine creates with Target.createTarget gets the
// beforeunload guard before its own page scripts run, and that the guard adds almost nothing to tab
// creation. Runs only where CHROME_BIN names a Chrome (build host container); writes a CDP trace to
// CHROME_TRACE when set.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { BEFOREUNLOAD_GUARD_SCRIPT } from "../browser-beforeunload-guard.ts";
import { startTargetGuard } from "./headless-target-guard.ts";

const chrome = process.env.CHROME_BIN;
const trace: string[] = [];
const note = (line: string) => trace.push(`${new Date().toISOString()} ${line}`);

async function launch(): Promise<{ child: ChildProcess; url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mb-chrome-"));
  const child = spawn(chrome!, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("chrome did not start")), 20_000);
    child.stderr!.on("data", (chunk) => { text += chunk; const m = /DevTools listening on (ws:\/\/\S+)/u.exec(text); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once("exit", () => reject(new Error("chrome exited")));
  });
  return { child, url, dir };
}

/** What the engine does for tab_new: createTarget, attachToTarget (flatten), then enable domains. */
class EngineLike {
  private serial = 0;
  private waiting = new Map<number, (m: any) => void>();
  constructor(private socket: WebSocket) {
    socket.on("message", (raw) => { const m = JSON.parse(String(raw)); if (typeof m.id === "number") { note(`engine <- ${raw.toString().slice(0, 160)}`); this.waiting.get(m.id)?.(m); } });
  }
  static async connect(url: string) { const s = new WebSocket(url); await new Promise<void>((r, j) => { s.once("open", () => r()); s.once("error", j); }); return new EngineLike(s); }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.serial;
    note(`engine -> ${method}${sessionId ? ` [${sessionId.slice(0, 6)}]` : ""}`);
    return new Promise((resolve) => { this.waiting.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  /** The engine's tab_new with a URL: the page is requested at creation. */
  async tabNew(url: string, guard?: { installed: (id: string) => Promise<boolean> }, blank = false) {
    const t0 = performance.now();
    const created = await this.send("Target.createTarget", { url: guard || blank ? "about:blank" : url });
    const attached = await this.send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId as string;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    // what the proxy now does: wait for the guard on the blank target, then send it to the page
    if (guard) note(`guard installed on ${created.result.targetId.slice(0, 6)}: ${await guard.installed(created.result.targetId)}`);
    const ms = performance.now() - t0; // tab creation only: the page load that follows is the same with or without the guard
    if (guard || blank) {
      await this.send("Page.navigate", { url }, sessionId);
      // the probes read what the page script set: wait for it to have run, not a fixed 150 ms a loaded runner can miss
      for (let i = 0; i < 200; i++) {
        const ran = await this.send("Runtime.evaluate", { expression: `location.href === ${JSON.stringify(url)} && typeof window.__wrapped === "string"`, returnByValue: true }, sessionId);
        if (ran.result?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return { sessionId, ms };
  }
  close() { this.socket.close(); }
}

describe.skipIf(!chrome)("beforeunload guard on a real Chrome", () => {
  const page = `<!doctype html><title>bu</title><script>window.__wrapped=EventTarget.prototype.addEventListener.toString();addEventListener("beforeunload",function(e){e.preventDefault();e.returnValue="leave?";});</script>`;
  const http = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(page); });
  afterAll(() => { http.close(); if (process.env.CHROME_TRACE) writeFileSync(process.env.CHROME_TRACE, trace.join("\n") + "\n"); });

  it("a tab created by Target.createTarget runs the guard before its page scripts, at under 100 ms added", async () => {
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const pageUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    const { child, url, dir } = await launch();
    try {
      const baseline = await EngineLike.connect(url);
      const plain = await baseline.tabNew(pageUrl, undefined, true);
      const plainProbe = await baseline.send("Runtime.evaluate", { expression: `JSON.stringify({native:/\\[native code\\]/.test(window.__wrapped||""),guard:!!window[Symbol.for("murage.beforeunload-guard")]})`, returnByValue: true }, plain.sessionId);
      note(`baseline probe ${plainProbe.result.result.value} in ${plain.ms.toFixed(1)} ms`);
      expect(JSON.parse(plainProbe.result.result.value)).toEqual({ native: true, guard: false });

      const guard = await startTargetGuard(url, BEFOREUNLOAD_GUARD_SCRIPT, note);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const tab = await baseline.tabNew(pageUrl, guard);
        times.push(tab.ms);
        const probe = await baseline.send("Runtime.evaluate", { expression: `JSON.stringify({wrapped:!/\\[native code\\]/.test(window.__wrapped||""),guard:!!window[Symbol.for("murage.beforeunload-guard")],prevented:(()=>{const e=new Event("beforeunload",{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})(),handler:window.onbeforeunload})`, returnByValue: true }, tab.sessionId);
        note(`guarded tab ${i} probe ${probe.result.result.value} in ${tab.ms.toFixed(1)} ms`);
        expect(JSON.parse(probe.result.result.value)).toEqual({ wrapped: true, guard: true, prevented: false, handler: null });
      }
      // a navigation away from a guarded page raises no prompt (no pending dialog blocks it)
      const last = await baseline.tabNew(pageUrl, guard);
      const away = await Promise.race([baseline.send("Page.navigate", { url: "about:blank" }, last.sessionId).then(() => "navigated"), new Promise((r) => setTimeout(() => r("blocked"), 5_000))]);
      note(`navigate away: ${away}`);
      expect(away).toBe("navigated");
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      note(`tab creation: baseline ${plain.ms.toFixed(1)} ms, guarded mean ${mean.toFixed(1)} ms`);
      expect(mean - plain.ms).toBeLessThan(100);
      guard.close(); baseline.close();
    } finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
