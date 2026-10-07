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
const COMMIT_TOKEN = "fedcba9876543210".repeat(4); // the link routes' own token (MURAGE_MCP_COMMIT_TOKEN)
const MODEL_PROVIDER_TOKEN = "0011223344556677".repeat(4); // the model provider commit token: must NOT open them
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

// This harness runs the packaged rule (MURAGE_SECRETS_EXTERNAL=1): an env value
// never rides the body (MCP-LINK T16). The body names it with `true`, and main
// pushes the value over the commit route (commitEnv below).
const addServer = (name: string) =>
  desktop("POST", "/api/mcp/servers", {
    name,
    command: "notes-mcp",
    args: ["--stdio"],
    env: { NOTES_TOKEN: true },
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
      // The two locks of the link routes: the per-launch commit token the
      // desktop shell holds, and the packaged rule that a body never carries a secret.
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: MODEL_PROVIDER_TOKEN,
      MURAGE_MCP_COMMIT_TOKEN: COMMIT_TOKEN,
      MURAGE_SECRETS_EXTERNAL: "1",
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
    // T16: a value in the body is refused in the packaged app, and nothing is stored
    const plaintext = await desktop("POST", "/api/mcp/servers", { name: "lifecycle", command: "notes-mcp", env: { NOTES_TOKEN: "stored-secret-value" } });
    expect([plaintext.status, plaintext.body]).toEqual([400, { error: "Enter the value in its field." }]);
    expect(storedServers()).toEqual({});
    const created = await addServer("lifecycle");
    expect(created.status).toBe(201);
    // a new command is inert until the person turns it on
    expect(created.body.servers).toEqual([{
      kind: "stdio",
      name: "lifecycle",
      command: "notes-mcp",
      args: ["--stdio"],
      envKeys: ["NOTES_TOKEN"],
      enabled: false,
      status: "needs-key",
    }]);
    // main pushes the value; config.json keeps `true`, the listing only the name
    expect(await commit("PUT", "/api/mcp/servers/lifecycle/secrets", { env: { NOTES_TOKEN: "stored-secret-value" } })).toEqual({ status: 200, body: { ok: true } });
    // a command server's push carries no origin
    expect((await commit("PUT", "/api/mcp/servers/lifecycle/secrets", { origin: "http://127.0.0.1:1", env: { NOTES_TOKEN: "x" } })).status).toBe(400);
    expect(storedServers().lifecycle.env).toEqual({ NOTES_TOKEN: true });
    expect(JSON.stringify(storedServers())).not.toContain("stored-secret-value");

    const listed = await desktop("GET", "/api/mcp/servers");
    expect(listed.status).toBe(200);
    expect(listed.body.servers).toHaveLength(1);
    expect(listed.body.servers[0]).toMatchObject({ status: "ready" });
    expect(JSON.stringify(listed.body)).not.toContain("stored-secret-value");

    // `true` beside a saved key means "keep it"; a new name arrives from main
    // a new command with saved values must say whether to keep them (review L6)
    const unsaid = await desktop("PUT", "/api/mcp/servers/lifecycle", {
      command: "notes-mcp",
      args: ["--stdio", "--verbose"],
      env: { NOTES_TOKEN: true, MODE: true },
    });
    expect(unsaid.status).toBe(400);
    expect(unsaid.body.code).toBe("env-choice");
    const edited = await desktop("PUT", "/api/mcp/servers/lifecycle", {
      command: "notes-mcp",
      args: ["--stdio", "--verbose"],
      env: { NOTES_TOKEN: true, MODE: true },
      keepSavedValues: true,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.servers[0].envKeys).toEqual(["MODE", "NOTES_TOKEN"]);
    expect(storedServers().lifecycle.env).toEqual({ NOTES_TOKEN: true, MODE: true });
    // the test route needs every held value before it spawns anything
    const missing = await desktop("POST", "/api/mcp/servers/lifecycle/test");
    expect(missing.body).toEqual({ ok: false, reason: "needs-key", error: "This server needs a value for MODE. Enter it again." });
    expect((await commit("PUT", "/api/mcp/servers/lifecycle/secrets", { env: { NOTES_TOKEN: "stored-secret-value", MODE: "read-only" } })).status).toBe(200);

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

// ── servers added by link (spec MCP-LINK 3.11) ───────────────────────────

const COMMIT_HEADERS = { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}` } as const;
const commit = (method: string, path: string, body?: unknown) => api(method, path, body, { ...COMMIT_HEADERS });
const DEAD_LINK = "http://127.0.0.1:1/mcp";
const addRemote = (name: string, extra: Record<string, unknown> = {}) =>
  desktop("POST", "/api/mcp/servers", { name, url: DEAD_LINK, confirmLocal: "this-computer", headers: { "X-API-Key": true }, ...extra });

describe("link routes are desktop-only, and the commit routes need the commit token too", () => {
  it.each(REMOTE_SURFACES)("refuses inspect, secrets and sign-in target from a %s surface", async (_label, headers) => {
    expect((await addRemote("gated")).status).toBe(201);
    const before = storedServers();
    for (const [method, path, body] of [
      ["POST", "/api/mcp/inspect", { input: DEAD_LINK }],
      ["PUT", "/api/mcp/servers/gated/secrets", { headers: { "X-API-Key": "smuggled" } }],
      ["DELETE", "/api/mcp/servers/gated/secrets", undefined],
      ["GET", "/api/mcp/servers/gated/oauth-target", undefined],
    ] as const) {
      const blocked = await api(method, path, body, { ...headers, authorization: `Bearer ${COMMIT_TOKEN}` });
      expect([method, path, blocked.status, blocked.body]).toEqual([method, path, 404, { error: "no such route" }]);
    }
    expect(storedServers()).toEqual(before);
    expect((await desktop("DELETE", "/api/mcp/servers/gated")).status).toBe(200);
  });

  it("M2: the model provider's commit token does not open the link routes, and the link token does not open the provider's", async () => {
    expect((await addRemote("ownlock")).status).toBe(201);
    const withProvider = { ...DESKTOP_HEADERS, authorization: `Bearer ${MODEL_PROVIDER_TOKEN}` };
    for (const [method, path, body] of [
      ["PUT", "/api/mcp/servers/ownlock/secrets", { headers: { "X-API-Key": "k" } }],
      ["DELETE", "/api/mcp/servers/ownlock/secrets", undefined],
      ["GET", "/api/mcp/servers/ownlock/oauth-target", undefined],
    ] as const) {
      const blocked = await api(method, path, body, withProvider);
      expect([method, blocked.status]).toEqual([method, 404]);
    }
    const withMcp = { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}` };
    for (const path of ["/api/flux-connection/replace", "/api/provider-connections/replace"]) {
      const blocked = await api("POST", path, { bank: "", expectedRevision: "" }, withMcp);
      expect([path, blocked.status]).toEqual([path, 404]);
    }
    expect((await api("GET", "/api/provider-connections/revision", undefined, withMcp)).status).toBe(404);
    expect((await api("PUT", "/api/mcp/servers/ownlock/secrets", { origin: "http://127.0.0.1:1", headers: { "X-API-Key": "k" } }, withMcp)).status).toBe(200);
    expect((await desktop("DELETE", "/api/mcp/servers/ownlock")).status).toBe(200);
  });

  it("the desktop proof alone is not enough for the commit routes: no token, a wrong token and a malformed token all get 404", async () => {
    expect((await addRemote("locked")).status).toBe(201);
    for (const authorization of [undefined, `Bearer ${"0".repeat(64)}`, `Bearer ${COMMIT_TOKEN.slice(1)}`, COMMIT_TOKEN, `Bearer ${COMMIT_TOKEN.toUpperCase()}`]) {
      const headers: Record<string, string> = { ...DESKTOP_HEADERS, ...(authorization ? { authorization } : {}) };
      for (const [method, path, body] of [
        ["PUT", "/api/mcp/servers/locked/secrets", { headers: { "X-API-Key": "k" } }],
        ["DELETE", "/api/mcp/servers/locked/secrets", undefined],
        ["GET", "/api/mcp/servers/locked/oauth-target", undefined],
      ] as const) {
        const blocked = await api(method, path, body, headers);
        expect([String(authorization), method, blocked.status]).toEqual([String(authorization), method, 404]);
      }
    }
    expect((await desktop("GET", "/api/mcp/servers")).body.servers[0]).toMatchObject({ name: "locked", status: "needs-key" });
    expect((await desktop("DELETE", "/api/mcp/servers/locked")).status).toBe(200);
  });
});

describe("link servers through the routes", () => {
  it("adds a link server, never takes a secret in the body, takes it through the commit route, and forgets it on delete", async () => {
    // a literal key in the body is refused; nothing is stored
    const refused = await addRemote("keyed", { headers: { "X-API-Key": "sk-live-IN-THE-BODY" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Enter the key in the key field.");
    expect(JSON.stringify(refused.body)).not.toContain("sk-live-IN-THE-BODY");
    expect(storedServers()).toEqual({});
    // a link that holds a key is refused too
    expect((await addRemote("keyed", { url: "http://127.0.0.1:1/mcp?key=abc" })).status).toBe(400);

    const created = await addRemote("keyed");
    expect(created.status).toBe(201);
    expect(created.body.servers).toEqual([{
      kind: "remote", name: "keyed", url: DEAD_LINK, host: "127.0.0.1", auth: "header",
      headerNames: ["X-API-Key"], local: "this-computer", enabled: false, status: "needs-key",
    }]);
    // the stored entry has the name and a true placeholder, never a value
    expect(storedServers().keyed).toMatchObject({ url: DEAD_LINK, headers: { "X-API-Key": true }, local: "this-computer", enabled: false });

    // main pushes the value over the commit route
    const pushed = await commit("PUT", "/api/mcp/servers/keyed/secrets", { origin: "http://127.0.0.1:1", headers: { "X-API-Key": "sk-live-FROM-MAIN" }, oauth: { accessToken: "at-1", refreshToken: "RT-NEVER-HERE" } });
    expect(pushed).toEqual({ status: 200, body: { ok: true } });
    const listed = await desktop("GET", "/api/mcp/servers");
    expect(listed.body.servers[0]).toMatchObject({ name: "keyed", status: "ready" });
    expect(JSON.stringify(listed.body)).not.toMatch(/sk-live-FROM-MAIN|at-1|RT-NEVER-HERE/);
    expect(JSON.stringify(storedServers())).not.toMatch(/sk-live-FROM-MAIN|at-1|RT-NEVER-HERE/);

    // the test route uses the stored value and reports in public language; nothing listens on port 1
    const tested = await desktop("POST", "/api/mcp/servers/keyed/test");
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(tested.body)).not.toContain("sk-live-FROM-MAIN");

    // a bad push is refused
    expect((await commit("PUT", "/api/mcp/servers/keyed/secrets", { nothing: "useful" })).status).toBe(400);
    expect((await commit("PUT", "/api/mcp/servers/nosuch/secrets", { headers: { K: "v" } })).status).toBe(404);

    // deleting the entry clears its secrets: a new entry of the same name starts empty
    expect((await desktop("DELETE", "/api/mcp/servers/keyed")).status).toBe(200);
    expect((await addRemote("keyed")).body.servers[0]).toMatchObject({ status: "needs-key" });
    expect((await desktop("DELETE", "/api/mcp/servers/keyed")).status).toBe(200);
  });

  it("clears a server's secrets through the commit route", async () => {
    expect((await addRemote("clearing")).status).toBe(201);
    await commit("PUT", "/api/mcp/servers/clearing/secrets", { origin: "http://127.0.0.1:1", headers: { "X-API-Key": "k-1234" } });
    expect((await desktop("GET", "/api/mcp/servers")).body.servers[0].status).toBe("ready");
    expect(await commit("DELETE", "/api/mcp/servers/clearing/secrets")).toEqual({ status: 200, body: { ok: true } });
    expect((await desktop("GET", "/api/mcp/servers")).body.servers[0].status).toBe("needs-key");
    expect((await desktop("DELETE", "/api/mcp/servers/clearing")).status).toBe(200);
  });

  it("inspect saves nothing, asks before connecting to a local link, and needs JSON", async () => {
    const before = storedServers();
    const asked = await desktop("POST", "/api/mcp/inspect", { input: DEAD_LINK });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ ok: true, source: "link", drafts: [{ kind: "remote", name: expect.any(String), probe: { ok: false, reason: "local-confirm", needs: "this-computer" } }] });
    const again = await desktop("POST", "/api/mcp/inspect", { input: DEAD_LINK, confirmLocal: "this-computer" });
    expect(again.body.drafts[0].probe).toMatchObject({ ok: false, reason: "unreachable" });
    expect(storedServers()).toEqual(before);
    expect((await desktop("POST", "/api/mcp/inspect", { input: "x", confirmLocal: "bogus" })).status).toBe(400);
    const textPlain = await fetch(`${base}/api/mcp/inspect`, { method: "POST", headers: { ...DESKTOP_HEADERS, "content-type": "text/plain" }, body: "{}" });
    expect(textPlain.status).toBe(415);
  });

  it("a local confirmation in the body comes only from confirmLocal, a pasted local key is ignored", async () => {
    const res = await desktop("POST", "/api/mcp/servers", { name: "sneaky", url: "http://192.168.1.5/mcp", local: "local-network", headers: { "X-K": true } });
    expect(res.status).toBe(201);
    expect(storedServers().sneaky).not.toHaveProperty("local");
    expect((await desktop("DELETE", "/api/mcp/servers/sneaky")).status).toBe(200);
  });

  it("counts link and command servers together against the limit of 20", async () => {
    for (let index = 0; index < 20; index += 1) {
      const res = index % 2 === 0 ? await addServer(`fill${index}`) : await addRemote(`fill${index}`);
      expect([index, res.status]).toEqual([index, 201]);
    }
    const over = await addRemote("fill20");
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/at most 20/);
    for (let index = 0; index < 20; index += 1) await desktop("DELETE", `/api/mcp/servers/fill${index}`);
    expect(storedServers()).toEqual({});
  });

  it("the sign-in target needs the desktop shell: without one it says so", async () => {
    expect((await addRemote("signin", { auth: "oauth", headers: undefined })).status).toBe(201);
    const target = await commit("GET", "/api/mcp/servers/signin/oauth-target");
    expect(target.status).toBe(409);
    expect(target.body.error).toBe("Sign in needs the Murage desktop app.");
    expect((await desktop("DELETE", "/api/mcp/servers/signin")).status).toBe(200);
  });
});
