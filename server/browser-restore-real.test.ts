// SPDX-License-Identifier: AGPL-3.0-or-later
// The real engine against a saved session of 120 origins (Fable, 1.0.3, Sean's Mac).
// agent-browser 0.36.0 restored every saved origin's storage with a real navigation and a
// 500 ms sleep before the first command answered, so 120 origins took about a minute.
// With the split store the first command answers inside the 20 s command bound, the
// cookie session is still signed in, and each origin's storage is there when the bot
// gets to it, by address or by a link.
//
// Runs only with the pinned engine: MURAGE_REAL_AGENT_BROWSER (its path) and
// AGENT_BROWSER_EXECUTABLE_PATH (Chromium), on a host the engine accepts (not root, not a
// container).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowserIntegration } from "./browser-engine.ts";
import { BROWSER_COMMAND_BOUND_MS, createNativeBrowser } from "./browser-native-relay.ts";
import { decryptEngineData, encryptEngineData, newestEngineState, prepareBrowserRestore } from "./browser-restore-store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const binary = process.env.MURAGE_REAL_AGENT_BROWSER;
const ORIGINS = 120;
const KEY = "c".repeat(64);
const SESSION = "restore-real";

describe.skipIf(!binary)("the real engine relaunches with a 120-origin saved session", () => {
  let server: Server;
  let port = 0;
  const dirs: string[] = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      const host = String(request.headers.host ?? "").split(":")[0];
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${host}</title><body><p id="who">host=${host} cookie=${request.headers.cookie ?? ""}</p><a id="go" href="http://o99.localhost:${port}/landing">go</a></body>`);
    });
    await new Promise<void>(done => server.listen(0, () => done()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>(done => server.close(() => done()));
    for (const dir of dirs) removeTempDirSync(dir);
  });
  const origin = (i: number) => `http://o${i}.localhost:${port}`;
  const text = (reply: unknown) => JSON.stringify(reply) ?? "";

  it("answers the first command inside the command bound and keeps the bot signed in", async () => {
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { process.stdout.write(`${parts.map(String).join(" ")}\n`); });
    const dataDir = mkdtempSync(join(tmpdir(), "murage-restore-real-"));
    dirs.push(dataDir);
    const spec = agentBrowserIntegration({ binaryPath: binary!, session: SESSION, encryptionKey: KEY, dataDir, realmId: "restore-real", env: process.env });
    // The saved session the engine left at its idle exit: one sign-in cookie, 120 origins with storage.
    const sessions = join(spec.env.HOME!, ".agent-browser", "sessions");
    mkdirSync(sessions, { recursive: true });
    const saved = {
      cookies: [{ name: "sid", value: "signed-in", domain: "o0.localhost", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400, size: 0, httpOnly: true, secure: false, session: false, sameSite: "Lax" }],
      origins: Array.from({ length: ORIGINS }, (_, i) => ({ origin: origin(i), localStorage: [{ name: "token", value: `v${i}` }], sessionStorage: [] })),
    };
    writeFileSync(join(sessions, `${SESSION}-saved.json.enc`), encryptEngineData(Buffer.from(JSON.stringify(saved)), KEY), { mode: 0o600 });

    const native = createNativeBrowser(spec);
    try {
      const started = Date.now();
      await native.command(["get", "url"]);
      const firstMs = Date.now() - started;
      process.stdout.write(`[restore-real] first command after relaunch with ${ORIGINS} saved origins: ${firstMs} ms\n`);
      expect(firstMs).toBeLessThan(BROWSER_COMMAND_BOUND_MS);

      // The cookie session survived the relaunch.
      await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${origin(0)}/whoami` } });
      expect(text(await native.request("tools/call", { name: "agent_browser_get_text", arguments: { selector: "#who" } }))).toContain("cookie=sid=signed-in");

      // An origin's storage is there on the bot's first visit by address.
      const visit = Date.now();
      await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${origin(57)}/inbox` } });
      process.stdout.write(`[restore-real] first visit to a saved origin, storage restored: ${Date.now() - visit} ms\n`);
      expect(text(await native.request("tools/call", { name: "agent_browser_eval", arguments: { script: "location.pathname + ' ' + localStorage.getItem('token')" } }))).toContain("/inbox v57");

      // And on its first visit through a link.
      await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${origin(1)}/` } });
      await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "#go" } });
      expect(text(await native.request("tools/call", { name: "agent_browser_eval", arguments: { script: "location.host + ' ' + localStorage.getItem('token')" } }))).toContain(`o99.localhost:${port} v99`);
    } finally {
      await native.close();
    }

    // The engine saved at close. Every origin's storage is still kept for the next run, and the cookie too.
    const next = prepareBrowserRestore(spec, () => {})!;
    expect(next.origins).toBe(ORIGINS);
    for (const i of [0, 1, 57, 99, 119]) expect(next.pending(origin(i))?.localStorage).toEqual([{ name: "token", value: `v${i}` }]);
    // What the engine restores at its next launch: the cookies, and no origin to walk through.
    const engineFile = newestEngineState(sessions, SESSION)!;
    expect(engineFile).not.toMatch(/-saved\.json\.enc$/u);
    const left = JSON.parse(decryptEngineData(readFileSync(engineFile), KEY).toString("utf8")) as { cookies: Array<{ name: string }>; origins: unknown[] };
    expect(left.cookies.map(cookie => cookie.name)).toContain("sid");
    expect(left.origins).toEqual([]);
  }, 180_000);
});
