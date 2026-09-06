import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// An `mcpServers` entry is a command line that every capable bot spawns as a
// tool server on its next turn, and the /test route spawns it immediately. So
// all six MCP routes take the same desktop gate as /api/cli-test and the
// local-VM lifecycle routes, and answer 404 — never 403, which would confirm
// the route is here — to anything that cannot prove it is the renderer.
//
// The proof is a per-launch secret, not the marker: a bare
// `x-murage-surface: desktop` header is something any local process can type,
// and this file asserts that it is not enough.
//
// The last case covers the SECOND write path. Teaching saveConfig about
// `mcpServers` put the field within reach of the generic PUT/PATCH
// /api/config route — a second way to choose what gets spawned. Unproven
// callers are now refused at the administrative boundary before parsing;
// proven desktop callers must still use the dedicated MCP routes.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = {
  "x-murage-surface": "desktop",
  "x-murage-surface-secret": DESKTOP_SECRET,
} as const;

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const desktop = (method: string, path: string, body?: unknown) =>
  api(method, path, body, { ...DESKTOP_HEADERS });

/** Every way in that is not a proven desktop: an unmarked local caller, a
 * caller that types the marker without the secret, and a paired phone. */
const REMOTE_SURFACES: Array<[string, Record<string, string>]> = [
  ["unmarked", {}],
  ["marker without the secret", { "x-murage-surface": "desktop" }],
  ["companion", { "x-murage-companion": "1" }],
];

const storedServers = (): Record<string, any> =>
  JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8")).mcpServers ?? {};

const addServer = (name: string) =>
  desktop("POST", "/api/mcp/servers", {
    name,
    command: "notes-mcp",
    args: ["--stdio"],
    env: { NOTES_TOKEN: "stored-secret-value" },
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "murage-mcp-gate-"));
  const data = join(home, ".murage");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>MCP gate test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  // one inert fixture instance, so booting neither scans the real PATH for
  // agent CLIs nor reaches the network
  writeFileSync(join(data, "config.json"), JSON.stringify({
    language: "en",
    instances: {
      quiet: {
        driver: "claudeAgent",
        displayName: "Quiet fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_STATIC_DIR: staticDir,
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("custom MCP routes are desktop-only", () => {
  it("lets the desktop add, list, edit, toggle, test and delete a server", async () => {
    const created = await addServer("lifecycle");
    expect(created.status).toBe(201);
    // a new command is inert until the person turns it on
    expect(created.body.servers).toEqual([{
      name: "lifecycle",
      command: "notes-mcp",
      args: ["--stdio"],
      envKeys: ["NOTES_TOKEN"],
      enabled: false,
    }]);
    // the configured value is never echoed back, only its name
    expect(JSON.stringify(created.body)).not.toContain("stored-secret-value");
    expect(storedServers().lifecycle.env).toEqual({ NOTES_TOKEN: "stored-secret-value" });

    const listed = await desktop("GET", "/api/mcp/servers");
    expect(listed.status).toBe(200);
    expect(listed.body.servers).toHaveLength(1);

    // an empty value beside a saved key means "keep it"
    const edited = await desktop("PUT", "/api/mcp/servers/lifecycle", {
      command: "notes-mcp",
      args: ["--stdio", "--verbose"],
      env: { NOTES_TOKEN: true, MODE: "read-only" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.servers[0].envKeys).toEqual(["MODE", "NOTES_TOKEN"]);
    expect(storedServers().lifecycle.env).toEqual({
      NOTES_TOKEN: "stored-secret-value",
      MODE: "read-only",
    });

    const toggled = await desktop("PATCH", "/api/mcp/servers/lifecycle", { enabled: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.servers[0].enabled).toBe(true);

    // the probe route is reachable from the desktop and reports in public
    // language — `notes-mcp` is not installed on this machine
    const tested = await desktop("POST", "/api/mcp/servers/lifecycle/test");
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(false);
    expect(tested.body.error).toMatch(/Could not start this command/);

    expect((await desktop("DELETE", "/api/mcp/servers/lifecycle")).status).toBe(200);
    expect(storedServers()).toEqual({});
  });

  it("refuses a name Murage mounts itself", async () => {
    const reserved = await desktop("POST", "/api/mcp/servers", { name: "computer", command: "evil" });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toMatch(/reserved/);
    expect(storedServers()).toEqual({});
  });

  it.each(REMOTE_SURFACES)("refuses GET from a %s surface", async (_label, headers) => {
    expect((await addServer("readable")).status).toBe(201);
    const blocked = await api("GET", "/api/mcp/servers", undefined, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    expect((await desktop("DELETE", "/api/mcp/servers/readable")).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses POST from a %s surface", async (_label, headers) => {
    const blocked = await api("POST", "/api/mcp/servers", {
      name: "smuggled",
      command: "curl",
      args: ["evil.example"],
    }, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    // the refusal is real, not cosmetic: nothing was stored
    expect(storedServers()).toEqual({});
  });

  it.each(REMOTE_SURFACES)("refuses PUT from a %s surface", async (_label, headers) => {
    expect((await addServer("puttarget")).status).toBe(201);
    const blocked = await api("PUT", "/api/mcp/servers/puttarget", {
      command: "curl",
      args: ["evil.example"],
    }, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    expect(storedServers().puttarget.command).toBe("notes-mcp");
    expect((await desktop("DELETE", "/api/mcp/servers/puttarget")).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses PATCH from a %s surface", async (_label, headers) => {
    expect((await addServer("patchtarget")).status).toBe(201);
    const blocked = await api("PATCH", "/api/mcp/servers/patchtarget", { enabled: true }, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    expect(storedServers().patchtarget.enabled).toBe(false);
    expect((await desktop("DELETE", "/api/mcp/servers/patchtarget")).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses DELETE from a %s surface", async (_label, headers) => {
    expect((await addServer("deletetarget")).status).toBe(201);
    const blocked = await api("DELETE", "/api/mcp/servers/deletetarget", undefined, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    expect(Object.keys(storedServers())).toContain("deletetarget");
    expect((await desktop("DELETE", "/api/mcp/servers/deletetarget")).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses the connection test from a %s surface", async (_label, headers) => {
    expect((await addServer("probetarget")).status).toBe(201);
    const blocked = await api("POST", "/api/mcp/servers/probetarget/test", undefined, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    expect((await desktop("DELETE", "/api/mcp/servers/probetarget")).status).toBe(200);
  });

  it("will not let PUT /api/config smuggle mcpServers past the six gates", async () => {
    expect((await addServer("guarded")).status).toBe(201);
    const before = storedServers();

    for (const [, headers] of REMOTE_SURFACES) {
      const blocked = await api("PUT", "/api/config", {
        mcpServers: { guarded: { command: "curl", args: ["evil.example"], enabled: true } },
      }, headers);
      expect(blocked.status).toBe(404);
      expect(storedServers()).toEqual(before);
    }

    // and the desktop cannot use the generic route as a side door either —
    // mcpServers is settable ONLY through the six routes above
    const fromDesktop = await desktop("PUT", "/api/config", {
      language: "de",
      mcpServers: { guarded: { command: "curl", args: ["evil.example"], enabled: true } },
    });
    expect(fromDesktop.status).toBe(400);
    expect(storedServers()).toEqual(before);
    // the whole patch was refused, so the innocent sibling did not land
    expect(JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8")).language).toBe("en");

    expect((await desktop("DELETE", "/api/mcp/servers/guarded")).status).toBe(200);
  });
});
