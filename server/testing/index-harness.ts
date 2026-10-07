// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The real harness server the index suites share, one per suite file: it
// boots node server/index.ts against a throwaway home, pins a local fake
// engine, and tears the server down after the file. Split out of
// server/index.test.ts so no one file outlasts a Windows Vitest shard (L18).
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./cleanup.ts";
import { browserSessionId } from "../browser-engine.ts";
import { FAKE_FLUX_BROKER_PREFIX, FAKE_FLUX_BROKER_TOKEN, handleFakeFluxBroker } from "./fake-flux-broker.ts";
import { withTurnSecrets } from "./fixture-dump.ts";

export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(SERVER_DIR, "..");
export const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
export const PORT = 18800 + Math.floor(Math.random() * 10_000);
export const BASE = `http://127.0.0.1:${PORT}`;
export const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
export const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;
/** This suite's stand-in for the renderer's copy of the per-launch desktop
 * secret. The child harness runs outside Electron, so its dev injection is
 * open and `MURAGE_DEV_DESKTOP_SECRET` pins the value both sides use — the
 * same path `pnpm dev` and the Playwright rig take. A packaged child ignores
 * that variable entirely; sse-visibility.test.ts proves it. */
export const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
/** Marker plus proof, in the header form and in the query form. `?surface=`
 * alone stopped meaning anything the day the secret landed. */
export const DESKTOP_HEADERS = {
  "x-murage-surface": "desktop",
  "x-murage-surface-secret": DESKTOP_SECRET,
} as const;
export const COMMIT_TOKEN = "fedcba9876543210".repeat(4);
/** The link routes have their own token (MCP-LINK M2). */
export const MCP_COMMIT_TOKEN = "0123fedcba987654".repeat(4);
export const DESKTOP_QUERY = `surface=desktop&surfaceSecret=${DESKTOP_SECRET}`;
/** The per-launch credential the harness shares with its companion
 * (`companion-authority.ts`). The door adds it next to the marker; the marker
 * alone is a string any local process can type. */
export const COMPANION_TOKEN = "c".repeat(64);
/** What the companion stamps on everything it forwards (audit C5): where the
 * request came from, not who the person is. A bare `api()` is a remote door
 * call, so it carries this; a request with neither header is a bare loopback
 * caller and gets the unknown-route 404 on every conversation route. */
export const DOOR_HEADERS = { "x-murage-door-token": COMPANION_TOKEN } as const;
export const PAIRED_PHONE = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN } as const;
// State-only setup must not re-probe every installed engine for each bot.
// Tests of default selection and actual turns retain their own selections.
export const STATE_ONLY_SELECTION = { instanceId: "ghost", model: "ghost-1" };
// A configured `claude` slot opts into product-fleet additions. Override those
// slots explicitly so this fixture never probes developer-installed engines.
// Unknown drivers become inert shadows; `enabled: false` alone still permits
// driver construction/model refresh. The real fake Claude remains available
// for default-selection and dispatch tests.
export const FIXTURE_ENGINE_OVERRIDES = {
  fuigo: { driver: "fixture-unavailable" },
  cursor: { driver: "fixture-unavailable" },
  openaiCompat: { driver: "fixture-unavailable" },
  qwen: { driver: "fixture-unavailable" },
  hermes: { driver: "fixture-unavailable" },
  pi: { driver: "fixture-unavailable" },
};

/** Packaged-shape fixtures receive the renderer proof through their private
 * parent port. Capture that message in memory; dev environment pins are
 * intentionally ignored when process.parentPort exists. */
export function privateDesktopHeaders(serverChild: ChildProcess): Record<string, string> {
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": "" };
  serverChild.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const frame = message as { type?: unknown; secret?: unknown };
    if (frame.type === "murage:desktop-secret" && typeof frame.secret === "string") {
      headers["x-murage-surface-secret"] = frame.secret;
    }
  });
  return headers;
}

export let child: ChildProcess;
/** stands in for the box provider so config saving never touches the network */
export let boxStub: Server;
export let boxStubPort = 0;
export let connectorAliasFixture: { accounts: { id: string; alias: string; status: string; toolkit: { slug: string } }[]; links: { toolkit: string; alias?: string }[]; calls: number } | undefined;
export let home: string;
export let staticDir: string;
export let fakeClaudeDump: string;
export let stderr = "";
export const browserCapabilityCalls: Array<{ operation: string; authorization?: string; body: any }> = [];
export let browserRevokeFailuresRemaining = 0;
export let browserRegisterDelayMs = 0;
export const browserNativeEvents: Array<{ operation: string; session: string }> = [];
/** The browser engine refuses root and container hosts on Linux (browser-engine.ts,
 * agentBrowserIntegration), so a turn there runs without the browser tool and a
 * test that needs the mount cannot pass. The product behaviour is deliberate;
 * these tests run on a non-container Linux, macOS and Windows. */
export const browserEngineRefusesHost = process.platform === "linux"
  && (process.getuid?.() === 0 || ["/.dockerenv", "/run/.containerenv"].some((file) => existsSync(file)));
export const browserFixturePrelude = pathToFileURL(join(SERVER_DIR, "testing", "unified-browser-fixture.mjs")).href;
export const browserSession = (botId: string, profile = "") => browserSessionId(botId, profile, "original-installation");
export const browserRpc = (token: string, base = BASE) => fetch(`${base}/api/internal/unified-browser`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "tools/list" }),
});
export const browserMount = async (file = fakeClaudeDump, base = BASE) => {
  const dump = await readJsonFileWhenReady<{ mcpConfig: { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> } }>(file);
  const mounted = dump.mcpConfig.mcpServers.browser!;
  expect(mounted.args[0]).toMatch(/unified-browser-proxy/);
  expect(mounted.env.MURAGE_CONTROL_TOKEN).toMatch(/^[a-f0-9]{48}$/);
  expect(mounted.env).not.toHaveProperty("AGENT_BROWSER_ENCRYPTION_KEY");
  expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN, base)).status).toBe(200);
  return mounted;
};

export const expectStoppedTestServerCleanly = (serverChild: ChildProcess, capturedStderr: string): void => {
  // POSIX delivers SIGTERM to the server's graceful-shutdown handler, which
  // exits with code 0. Windows cannot deliver that handler signal: Node maps
  // child.kill("SIGTERM") to TerminateProcess and reports the requested stop
  // through signalCode instead. Accept only that exact Windows teardown shape
  // so a non-zero crash or SIGKILL escalation still fails the feature test.
  const requestedWindowsStop = process.platform === "win32"
    && serverChild.exitCode === null
    && serverChild.signalCode === "SIGTERM";
  expect(serverChild.exitCode === 0 || requestedWindowsStop, capturedStderr).toBe(true);
};

export const waitForIsolatedServer = async (
  serverChild: ChildProcess,
  port: number,
  capturedStderr: () => string,
): Promise<void> => {
  const deadline = Date.now() + 20_000;
  let lastObservedHealth = "none";
  for (;;) {
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) {
      throw new Error(
        `isolated server exited before becoming healthy `
        + `(code=${String(serverChild.exitCode)}, signal=${String(serverChild.signalCode)}).\n${capturedStderr()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        const health = await response.json() as { app?: unknown; pid?: unknown; static?: unknown };
        lastObservedHealth = JSON.stringify(health);
        if (health.app === "murage" && health.pid === serverChild.pid && health.static === true) return;
      }
    } catch {
      /* still starting */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `isolated server never became healthy (last health: ${lastObservedHealth}).\n${capturedStderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...DOOR_HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** Adapted from upstream 9f013dd2: hold a real HTTP body while a separate
 * request changes the task state. A headers-only send reaches the handler
 * before finish(), without timing sleeps or mocking the production Store. */
export const delayedJsonBody = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const raw = JSON.stringify(body);
  const req = request(`${BASE}${path}`, {
    method,
    headers: {
      ...DOOR_HEADERS,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(raw),
      expect: "100-continue",
      ...headers,
    },
  });
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
  });
  void response.catch(() => {});
  const accepted = once(req, "continue", { signal: AbortSignal.timeout(5_000) });
  req.flushHeaders();
  try { await accepted; }
  catch (error) { req.destroy(); throw error; }
  return {
    finish: () => { req.end(raw); return response; },
    close: () => req.destroy(),
  };
};

/** The same call, made as the person at the keyboard.
 *
 * `requestSurface` defaults to `remote`, so a bare `api()` is a *remote*
 * caller — which is what most of this file wants to be. Administration is
 * desktop-only, and asserting those routes explicitly through
 * this helper is what keeps "desktop-only" a statement about the request
 * rather than about the test runner's address. */
export const desktopApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  // Existing profile lifecycle fixtures supply the required read snapshot.
  // Missing/stale preconditions use raw requests in the dedicated CAS suite.
  if ((method === "PATCH" || method === "PUT") && path === "/api/config" && body && typeof body === "object" && Object.hasOwn(body, "browserProfiles") && !Object.hasOwn(body, "expectedBrowserProfiles")) {
    const current = await fetch(`${BASE}/api/config`, { headers: DESKTOP_HEADERS });
    const config = await current.json() as { browserProfiles?: Array<{ id: string; name: string }> };
    body = { ...body, expectedBrowserProfiles: (config.browserProfiles ?? []).map(({ id, name }: { id: string; name: string }) => ({ id, name })) };
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...DESKTOP_HEADERS,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** The paired phone, through the companion's door with its launch proof. */
export const phoneApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...PAIRED_PHONE, ...DOOR_HEADERS, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

export const readJsonFileWhenReady = async <T = unknown>(file: string, timeout = 5_000): Promise<T> => {
  let parsed: unknown;
  await expect.poll(() => {
    try {
      // a fake engine's dump carries its turn tokens in the credential file, not the mcp config
      parsed = withTurnSecrets(JSON.parse(readFileSync(file, "utf8")));
      return true;
    } catch {
      return false;
    }
  }, { timeout }).toBe(true);
  return parsed as T;
};

/** Obtain authority from an actual active fake-provider mount, never a test
 * mint endpoint or a bearer retained after stopping/changing its source. */
export const startInternalFixtureTurn = async (botId: string, groupId?: string, text = "hold this fixture turn", send: typeof api = desktopApi) => {
  // Windows taskkill completes asynchronously after interrupt acknowledges.
  // A fresh authority fixture must not steer into that retiring provider turn.
  await expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body;
    const bot = state.bots.find((bot: { id: string }) => bot.id === botId);
    const group = groupId ? state.groups.find((group: { id: string }) => group.id === groupId) : undefined;
    return {
      present: Boolean(bot) && (!groupId || Boolean(group)),
      busy: Boolean(bot?.busy),
      working: Boolean(group?.working),
    };
  }, { timeout: 5_000 }).toEqual({ present: true, busy: false, working: false });
  // Independent threads (N7, 89a41bd7): once a bot has several tasks, model
  // changes and sends must name the thread; a single-task bot keeps the
  // legacy whole-bot write.
  const selected = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId);
  const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
  expect((await desktopApi("PATCH", (selected.tasks?.length ?? 1) > 1 ? `/api/bots/${botId}/tasks/${selected.threadId}` : `/api/bots/${botId}`, { modelSelection })).status).toBe(200);
  rmSync(fakeClaudeDump, { force: true });
  const target = groupId ? `/api/groups/${groupId}/messages` : `/api/bots/${botId}/messages`;
  const started = await send("POST", target, groupId ? { text } : { text, threadId: selected.threadId });
  expect(started.status).toBe(202);
  if (!groupId) {
    expect(started.body.steered).not.toBe(true);
    expect(started.body.queued).not.toBe(true);
  }
  // `prompt` is what the engine was actually asked to do. Tests that care
  // whether a turn RAN on the person's own words read it; everything else
  // ignores it.
  let dump: { pid: number; prompt?: unknown; mcpConfig: { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> } };
  try {
    dump = await readJsonFileWhenReady(fakeClaudeDump);
  } catch (error) {
    // The fixture engine never reported a launch: say what the harness was
    // doing instead of "matcher did not succeed", so a stalled dispatch is
    // diagnosable from the failure alone.
    throw new Error(`${fixtureTurnDiagnostics(botId, groupId ? undefined : selected.threadId)}\n\ncaused by: ${error instanceof Error ? error.message : String(error)}`);
  }
  const env = dump.mcpConfig.mcpServers.agents!.env;
  expect(env.MURAGE_BOT_ID).toBe(botId);
  expect(env.MURAGE_COMMS_TOKEN).toMatch(/^[a-f0-9]{48}$/);
  return {
    dump, env,
    headers: { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
  };
};

/** What the harness and its engine were doing when a fixture turn never
 * launched: the thread's native protocol tail (session opens and closes with
 * their reasons), the harness stderr tail, and the thread's last messages. */
export const fixtureTurnDiagnostics = (botId: string, threadId: string | undefined): string => {
  const tail = (text: string, bytes: number) => (text.length > bytes ? `…${text.slice(-bytes)}` : text);
  const native = threadId ? (() => {
    try { return tail(readFileSync(join(home, ".murage", "native", `${threadId}.ndjson`), "utf8"), 4_000); }
    catch (error) { return `(no native log: ${error instanceof Error ? error.message : String(error)})`; }
  })() : "(group turn: no single thread)";
  const messages = (() => {
    if (!threadId) return "(group turn: no single thread)";
    const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT at, role, kind, substr(json, 1, 300) AS json FROM messages WHERE thread_id = ? ORDER BY at DESC LIMIT 6").all(threadId);
      return JSON.stringify(rows.reverse());
    } catch (error) { return `(messages unavailable: ${error instanceof Error ? error.message : String(error)})`; }
    finally { db.close(); }
  })();
  return [
    `fixture turn for bot ${botId}${threadId ? ` thread ${threadId}` : ""} never launched the fake engine (no ${fakeClaudeDump})`,
    `--- native log tail ---`, native,
    `--- harness stderr tail ---`, tail(stderr, 3_000),
    `--- last messages ---`, messages,
  ].join("\n");
};

/** Stop a fixture turn and wait until its engine process is gone.
 *
 * A Stop on the Claude driver is "requested, not observed" (contracts.ts):
 * `POST /interrupt` signals the CLI and returns, the bot reads idle at once,
 * and the driver settles the turn only when that child closes. The next turn
 * on the same thread is dispatched behind that close (`resetSession` waits
 * for it before spawning), so a test that stopped a turn and started another
 * had `startInternalFixtureTurn`'s 5 s launch wait also covering the old
 * engine's teardown — on a loaded 48-worker box that is what timed out
 * ("routes approved image MCP requests", build host full runs). The real state
 * to wait on is the stopped process itself: its pid is in the launch dump
 * and it must exit after SIGTERM (a CLI that does not is a genuine defect),
 * so the launch wait measures only the new launch. Bounded by the driver's
 * own reset budget for that same close. */
export const stopFixtureTurn = async (botId: string, turn: { dump: { pid: number } }, threadId?: string) => {
  const stopped = await api("POST", `/api/bots/${botId}/interrupt`, threadId ? { threadId } : undefined);
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  await expect.poll(() => {
    try { process.kill(turn.dump.pid, 0); return false; }
    catch { return true; }
  }, { timeout: 10_000, message: `stopped fixture engine pid ${turn.dump.pid} is still running` }).toBe(true);
};

/** The memory settlement of every turn on a thread, oldest first. */
export const turnMemoryOutcomes = (threadId: string): string[] => {
  const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
  try {
    return db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn' ORDER BY rowid").all(threadId)
      .map((row) => String((row as { outcome: unknown }).outcome));
  } finally {
    db.close();
  }
};

export const storedMessageCount = (threadId: string): number => {
  const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
  try {
    const row = z.object({ count: z.number() }).parse(
      db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId),
    );
    return row.count;
  } finally {
    db.close();
  }
};

export const uploadAvatar = async (mime = "image/png"): Promise<string> => {
  const response = await fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: { "content-type": mime },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  expect(response.status).toBe(201);
  const saved = (await response.json()) as { path: string };
  const name = saved.path.replaceAll("\\", "/").split("/").pop();
  if (!name) throw new Error("attachment response did not include a filename");
  return `/api/attachments/${name}`;
};

export const statusWithHeaders = (headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/health", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "murage-api-test-"));
  staticDir = join(home, "static");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  mkdirSync(join(home, "finish-fake"));
  // Only the local fake Claude can run; every other fixture slot is a shadow.
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged Murage</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body { color: white; }");
  writeFileSync(join(staticDir, "mermaid-frame-0123456789abcdef.html"), "<!doctype html><title>Diagram frame</title>");
  writeFileSync(
    join(home, ".murage", "config.json"),
    JSON.stringify({
      instances: {
        ...FIXTURE_ENGINE_OVERRIDES,
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
    }),
  );
  writeFileSync(
    join(home, ".murage", "groups.json"),
    JSON.stringify([
      {
        id: "test-dm",
        threadId: "test-dm-thread",
        name: "Private channel",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
        dm: true,
      },
      {
        // Dedicated to the read-marker privacy test. The older test-dm is
        // deliberately deleted by the working-folder test earlier in this
        // file, so reusing it makes focused and complete runs disagree.
        id: "test-read-dm",
        threadId: "test-read-dm-thread",
        name: "Private read-marker room",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
        dm: true,
      },
      {
        // The Inbox scoping test: one room a phone may see and one private
        // bot-to-bot room it may not, each holding one open request.
        id: "test-inbox-open-room",
        threadId: "test-inbox-open-room-thread",
        name: "Inbox open room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 5,
      },
      {
        id: "test-inbox-dm",
        threadId: "test-inbox-dm-thread",
        name: "Inbox private channel",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 6,
        dm: true,
      },
      {
        id: "test-stranded-room",
        threadId: "test-stranded-room-thread",
        name: "Stranded room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 3,
      },
      {
        id: "test-cancel-room",
        threadId: "test-cancel-room-thread",
        name: "Cancel room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 4,
      },
      {
        id: "test-pinned-room",
        threadId: "test-pinned-room-thread",
        name: "Pinned room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 2,
        pinnedCwd: null,
      },
    ]),
  );

  // A room transcript carrying an approval that outlived its turn: the card
  // is durable, but busyBotId is in-memory only and never survives a restart.
  writeFileSync(
    join(home, ".murage", "messages-test-stranded-room-thread.json"),
    JSON.stringify({
      activeLeafId: "stranded-card",
      messages: [
        {
          id: "stranded-card",
          at: 3,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "stranded-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  // A room holding an approval nobody has answered yet, so "Cancel turn"
  // has something open to close.
  writeFileSync(
    join(home, ".murage", "messages-test-cancel-room-thread.json"),
    JSON.stringify({
      activeLeafId: "cancel-card",
      messages: [
        {
          id: "cancel-card",
          at: 4,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "cancel-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  for (const threadId of ["test-inbox-open-room-thread", "test-inbox-dm-thread"]) {
    writeFileSync(
      join(home, ".murage", `messages-${threadId}.json`),
      JSON.stringify({
        activeLeafId: `${threadId}-card`,
        messages: [{
          id: `${threadId}-card`,
          at: 5,
          parentId: null,
          role: "bot",
          kind: "options",
          card: { title: "Approval needed", subtitle: "rm -rf /tmp/inbox", options: ["Allow", "Deny"], requestId: `${threadId}-request`, tool: "Bash", allowKey: "Bash:rm" },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        }],
      }),
    );
  }

  boxStub = createServer(async (req, res) => {
    if (req.url === "/fixture-browser-event") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      browserNativeEvents.push(body);
      if (body.operation === "verify" && browserRegisterDelayMs) await new Promise(resolve => setTimeout(resolve, browserRegisterDelayMs));
      res.writeHead(200, { "content-type": "application/json" }); return res.end("{}");
    }
    if (await handleFakeFluxBroker(req, res, connectorAliasFixture)) return;
    if (req.url?.startsWith("/v1/capabilities/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const operation = req.url.split("/").pop() ?? "";
      browserCapabilityCalls.push({
        operation,
        authorization: Array.isArray(req.headers.authorization) ? undefined : req.headers.authorization,
        body,
      });
      if (req.headers.authorization !== `Bearer ${"c".repeat(64)}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (operation === "revoke" && browserRevokeFailuresRemaining > 0) {
        browserRevokeFailuresRemaining -= 1;
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "temporary failure" }));
      }
      if (operation === "register" && browserRegisterDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, browserRegisterDelayMs));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(operation === "register" ? { ok: true, expiresAt: body.expiresAt } : { ok: true }));
    }
    if (req.headers.authorization === "Bearer box_slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const ok = req.headers.authorization === "Bearer box_good" || req.headers.authorization === "Bearer box_slow";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, boxes: [] } : { ok: false, code: "unauthorized" }));
  });
  await new Promise<void>((r) => boxStub.listen(0, "127.0.0.1", r));
  boxStubPort = (boxStub.address() as { port: number }).port;

  // The isolated negative control selects a preserved pre-change harness;
  // production never gains an authorization bypass or test mint endpoint.
  child = spawn(process.execPath, ["--import", browserFixturePrelude, "--import", pathToFileURL(join(SERVER_DIR, "testing", "search-fetch-preload.mjs")).href, process.env.MURAGE_IDENTITY_CONTROL_ENTRY ?? join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(PORT),
      MURAGE_WEBHOOK_PORT: String(WEBHOOK_PORT),
      MURAGE_BOX_API: `http://127.0.0.1:${boxStubPort}`,
      // Connected apps run through Flux Router only. A test file that needs
      // them sets MURAGE_TEST_FAKE_FLUX_BROKER=1 before this harness starts,
      // and this build then points at a fake broker; otherwise there is none.
      ...(process.env.MURAGE_TEST_FAKE_FLUX_BROKER === "1" ? {
        MURAGE_FLUX_COMPOSIO_BROKER_URL: `http://127.0.0.1:${boxStubPort}${FAKE_FLUX_BROKER_PREFIX}`,
        MURAGE_FLUX_COMPOSIO_BROKER_TOKEN: FAKE_FLUX_BROKER_TOKEN,
      } : {}),
      MURAGE_STATIC_DIR: staticDir,
      // The preload isolates only native execution; authority uses the real harness.
      MURAGE_AGENT_BROWSER_PATH: process.execPath,
      MURAGE_BROWSER_FIXTURE_URL: `http://127.0.0.1:${boxStubPort}/fixture-browser-event`,
      // Created only by the browser integration test. Keeping an explicit
      // path prevents that test from ever discovering a developer app's live
      // descriptor on the host running the suite.
      MURAGE_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      // Production uses 15s. Keep the real timer path while making the
      // browser-visible heartbeat assertion fast and deterministic.
      MURAGE_SSE_HEARTBEAT_MS: "50",
      // The dev injection, used exactly as `pnpm dev` and the Playwright
      // webServer use it: pin the secret so the caller can hold the same one
      // the harness minted. Refused outright in a packaged child.
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
      // The desktop shell's per-launch commit token, so a suite can push link-server secrets.
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: COMMIT_TOKEN,
      MURAGE_MCP_COMMIT_TOKEN: MCP_COMMIT_TOKEN,
      MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_DUMP: fakeClaudeDump,
      // a finished turn's process stays warm for the next turn: dump every turn
      FAKE_CLAUDE_DUMP_EACH_TURN: "1",
      FAKE_CLAUDE_FINISH_GATE_DIR: join(home, "finish-fake"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

export const deferredCheckpointDirectories: string[] = [];

afterAll(async () => {
  boxStub?.close();
  // Upstream fixed this same Linux scratch-cleanup flake with an inline
  // retry loop; these helpers are that fix plus the cause — the retry AND
  // an exit that is actually waited for before the delete begins.
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
  for (const directory of deferredCheckpointDirectories) expect(existsSync(directory), "owned checkpoint fixture must be removed after server shutdown").toBe(false);
});


/** Split suites import this state read-only; these are its writers. */
export function setBrowserRegisterDelayMs(value: number): void { browserRegisterDelayMs = value; }
export function setConnectorAliasFixture(value: typeof connectorAliasFixture): void { connectorAliasFixture = value; }
