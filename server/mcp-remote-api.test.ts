// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parsePaste } from "../shared/mcp-paste.ts";
import type { StoredRemoteMcpServer } from "./mcp-registry.ts";
import {
  MAX_INSPECT_PROBES,
  MCP_ROUTE_DEADLINE_MS,
  bindSecretsToEntry,
  commandEditNeedsEnvChoice,
  secretsNoLongerApply,
  withDeadline,
  inspectMcpInput,
  isRemoteBody,
  mcpCommitRouteAllowed,
  oauthTargetFor,
  parseConfirmLocal,
  prepareRemoteBody,
  redactDraftForResponse,
  secretsInBodyAllowed,
  testRemoteServer,
  validateSecretsPush,
} from "./mcp-remote-api.ts";
import { clearAllMcpServerSecrets, setMcpServerSecrets } from "./mcp-secrets.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";

let fake: FakeRemoteMcp | undefined;
afterEach(async () => {
  clearAllMcpServerSecrets();
  await fake?.close();
  fake = undefined;
});

const remote = (over: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer => ({ url: "https://x.example/mcp", auth: "none", headers: {}, enabled: true, ...over });

describe("editing a command server that holds saved env values (review L6)", () => {
  const cmd = (over: Record<string, unknown> = {}) => ({ command: "npx", args: ["-y", "@x/a"], env: {}, enabled: true, ...over }) as never;
  it("asks when the command or the arguments change and values are held, and only then", () => {
    const held = cmd({ heldEnv: ["TOKEN"] });
    expect(commandEditNeedsEnvChoice(held, cmd({ command: "node", heldEnv: ["TOKEN"] }))).toBe(true);
    expect(commandEditNeedsEnvChoice(held, cmd({ args: ["-y", "@x/b"], heldEnv: ["TOKEN"] }))).toBe(true);
    expect(commandEditNeedsEnvChoice(cmd({ env: { TOKEN: "v" } }), cmd({ command: "node" }))).toBe(true);
    expect(commandEditNeedsEnvChoice(held, cmd({ heldEnv: ["TOKEN"] })), "same command").toBe(false);
    expect(commandEditNeedsEnvChoice(cmd(), cmd({ command: "node" })), "nothing held").toBe(false);
    expect(commandEditNeedsEnvChoice(remote(), remote({ url: "https://y.example/mcp" }))).toBe(false);
  });
});

describe("commit routes: the per-launch token", () => {
  const token = "a".repeat(64);
  it("accepts the exact bearer only", () => {
    expect(mcpCommitRouteAllowed(`Bearer ${token}`, token)).toBe(true);
    for (const bad of [undefined, "", `bearer ${token}`, `Bearer ${"b".repeat(64)}`, `Bearer ${token.slice(1)}`, `Bearer ${token}x`, `Bearer ${"A".repeat(64)}`, token, ["x"], 5]) {
      expect([String(bad), mcpCommitRouteAllowed(bad, token)]).toEqual([String(bad), false]);
    }
    expect(mcpCommitRouteAllowed(`Bearer ${token}`, "")).toBe(false);
  });
});

describe("what a body may carry", () => {
  it("secrets are allowed in a body only with no desktop shell, and MURAGE_SECRETS_EXTERNAL forces the packaged rule", () => {
    expect(secretsInBodyAllowed(true, {})).toBe(false);
    expect(secretsInBodyAllowed(false, {})).toBe(true);
    expect(secretsInBodyAllowed(false, { MURAGE_SECRETS_EXTERNAL: "1" })).toBe(false);
    expect(secretsInBodyAllowed(false, { MURAGE_SECRETS_EXTERNAL: "0" })).toBe(true);
  });
  it("parseConfirmLocal accepts the two confirmations and nothing else", () => {
    expect(parseConfirmLocal(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseConfirmLocal("this-computer")).toEqual({ ok: true, value: "this-computer" });
    expect(parseConfirmLocal("local-network")).toEqual({ ok: true, value: "local-network" });
    for (const bad of ["public", "", 1, true, {}, "THIS-COMPUTER"]) expect(parseConfirmLocal(bad)).toEqual({ ok: false });
  });
  it("tells a link body from a command body", () => {
    expect(isRemoteBody({ name: "a", url: "https://x/mcp" })).toBe(true);
    expect(isRemoteBody({ serverUrl: "https://x/mcp" })).toBe(true);
    expect(isRemoteBody({ httpUrl: "https://x/mcp" })).toBe(true);
    expect(isRemoteBody({ command: "npx" })).toBe(false);
    expect(isRemoteBody({ url: 5 })).toBe(false);
    expect(isRemoteBody(null)).toBe(false);
  });
  it("prepareRemoteBody keeps only link fields: name, confirmLocal, local and strangers never ride in", () => {
    const raw = prepareRemoteBody({ name: "x", url: "https://x.example/mcp", confirmLocal: "this-computer", local: "this-computer", command: "evil", env: { A: "b" }, headers: { K: true }, enabled: true, auth: "header" }, false);
    expect(raw).toEqual({ url: "https://x.example/mcp", headers: { K: true }, enabled: true, auth: "header" });
  });
  it("a dev run splits a key-holding link the way the packaged app would, keeping the full link in config", () => {
    const raw = prepareRemoteBody({ url: "https://x.example/mcp?key=abc" }, true);
    expect(raw).toEqual({ url: "https://x.example/mcp?key=abc", urlSecret: true });
    const aliased = prepareRemoteBody({ serverUrl: "https://x.example/s/abcdefghijklmnopqrstuvwx/mcp" }, true);
    expect(aliased).toEqual({ url: "https://x.example/s/abcdefghijklmnopqrstuvwx/mcp", urlSecret: true });
    // packaged: no split; the registry refuses the key-holding link
    expect(prepareRemoteBody({ url: "https://x.example/mcp?key=abc" }, false)).toEqual({ url: "https://x.example/mcp?key=abc" });
  });
  it("validateSecretsPush reduces to what the harness may hold and bounds the size", () => {
    expect(validateSecretsPush({ headers: { K: "v" }, oauth: { accessToken: "at", refreshToken: "RT-SECRET", clientSecret: "CS" } })).toEqual({ headers: { K: "v" }, oauth: { accessToken: "at" } });
    expect(validateSecretsPush({ headers: { K: "x".repeat(70_000) } })).toBeNull();
    for (const bad of [null, [], "x", 3, {}, { oauth: { refreshToken: "only" } }]) expect(validateSecretsPush(bad)).toBeNull();
  });
});

describe("redactDraftForResponse", () => {
  it("drops the pasted link and every secret field's pasted value, keeps plain values", () => {
    const parsed = parsePaste(JSON.stringify({ mcpServers: { a: { url: "https://x.example/s/abcdefghijklmnopqrstuvwx/mcp?k=QSECRET", headers: { Authorization: "Bearer sk-pasted-secret-value", "X-Workspace": "acme" } } } }));
    if (!parsed.ok) throw new Error("parse");
    const out = redactDraftForResponse(parsed.drafts[0]!);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/QSECRET|abcdefghijklmnopqrstuvwx|sk-pasted-secret-value/);
    expect(out).toMatchObject({ kind: "remote", urlHasSecret: true });
    const fields = (out as { fields: Array<{ id: string; hasValue: boolean; value?: string; secret: boolean }> }).fields;
    expect(fields.find((field) => field.id === "header:Authorization")).toMatchObject({ secret: true, hasValue: true });
    expect(fields.find((field) => field.id === "header:Authorization")).not.toHaveProperty("value");
    expect(fields.find((field) => field.id === "header:X-Workspace")).toMatchObject({ secret: false, value: "acme" });
  });
  it("a stdio draft keeps its command and args and masks secret env values", () => {
    const parsed = parsePaste('FOO=bar NOTES_TOKEN=tok_live_abc123 npx -y @x/notes');
    if (!parsed.ok) throw new Error("parse");
    const out = redactDraftForResponse(parsed.drafts[0]!);
    expect(out).toMatchObject({ kind: "stdio", command: "npx", args: ["-y", "@x/notes"] });
    expect(JSON.stringify(out)).not.toContain("tok_live_abc123");
    expect(JSON.stringify(out)).toContain("bar");
  });
});

describe("inspect saves nothing and asks before it connects", () => {
  it("a link on this computer answers local-confirm and sends no request until confirmLocal is sent", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const before = fake.requests.length;
    const asked = await inspectMcpInput({ input: fake.mcpUrl }, { existingNames: new Set() });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ ok: true, source: "link", drafts: [{ kind: "remote", probe: { ok: false, reason: "local-confirm", needs: "this-computer" } }] });
    expect(fake.requests.length).toBe(before);
    const confirmed = await inspectMcpInput({ input: fake.mcpUrl, confirmLocal: "this-computer" }, { existingNames: new Set() });
    expect(confirmed.body).toMatchObject({ ok: true, drafts: [{ probe: { ok: true, transport: "http" } }] });
    // the wrong kind of confirmation does not unlock it
    const wrong = await inspectMcpInput({ input: fake.mcpUrl, confirmLocal: "local-network" }, { existingNames: new Set() });
    expect(wrong.body).toMatchObject({ drafts: [{ probe: { ok: false, reason: "address-changed" } }] });
  });

  it("probes without credentials, even when the paste carries a key", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "the-key-123", unauthorized: "api-key-only", prm: false });
    const answer = await inspectMcpInput({ input: JSON.stringify({ mcpServers: { f: { url: fake.mcpUrl, headers: { "x-api-key": "the-key-123" } } } }), confirmLocal: "this-computer" }, { existingNames: new Set() });
    expect(answer.body).toMatchObject({ ok: true, drafts: [{ probe: { ok: false, reason: "needs-key" } }] });
    for (const request of fake.requests) expect(request.headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(answer.body)).not.toContain("the-key-123");
  });

  it("names avoid the ones in use and the reserved ones, and a stdio paste is not probed", async () => {
    const answer = await inspectMcpInput({ input: '{"mcpServers":{"computer":{"command":"a"},"notes":{"command":"b"}}}' }, { existingNames: new Set(["notes"]) });
    expect(answer.body).toMatchObject({ ok: true, source: "json" });
    const names = (answer.body as { drafts: Array<{ name: string; probe?: unknown }> }).drafts;
    expect(names.map((draft) => draft.name)).toEqual(["computer-2", "notes-2"]);
    expect(names.every((draft) => draft.probe === undefined)).toBe(true);
  });

  it("the ComfyUI command the owner typed becomes the ComfyUI link card", async () => {
    let asked = "";
    const answer = await inspectMcpInput({ input: "npx -y mcp-remote https://cloud.comfy.org/mcp" }, {
      existingNames: new Set(),
      probe: async (input) => { asked = input.url; return { ok: false, reason: "needs-sign-in", error: "x", apiKey: { headerHint: "x-api-key" } }; },
    });
    expect(asked).toBe("https://cloud.comfy.org/mcp");
    expect(answer.body).toMatchObject({ ok: true, source: "command", drafts: [{ kind: "remote", name: "comfy", convertedFrom: "mcp-remote", probe: { reason: "needs-sign-in" } }] });
  });

  it("probes at most five links of a large snippet", async () => {
    const servers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`s${index}`, { url: `https://s${index}.example/mcp` }]));
    let probes = 0;
    const answer = await inspectMcpInput({ input: JSON.stringify({ mcpServers: servers }) }, { existingNames: new Set(), probe: async () => { probes += 1; return { ok: false, reason: "no-answer", error: "x" }; } });
    expect(probes).toBe(MAX_INSPECT_PROBES);
    expect((answer.body as { drafts: unknown[] }).drafts).toHaveLength(8);
  });

  it("refuses bad bodies, an unknown confirmation, TOML and oversize input, with plain reasons", async () => {
    const deps = { existingNames: new Set<string>() };
    expect((await inspectMcpInput(null, deps)).status).toBe(400);
    expect((await inspectMcpInput({ input: 5 }, deps)).status).toBe(400);
    expect((await inspectMcpInput({ input: "https://x.example/mcp", confirmLocal: "public" }, deps)).status).toBe(400);
    expect((await inspectMcpInput({ input: '[mcp_servers.x]\ncommand = "npx"' }, deps)).body).toMatchObject({ ok: false, reason: "toml" });
    expect((await inspectMcpInput({ input: "x".repeat(70_000) }, deps)).body).toMatchObject({ ok: false, reason: "too-large" });
    expect((await inspectMcpInput({ input: "" }, deps)).body).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("testRemoteServer uses the stored credentials", () => {
  it("a header with no value anywhere is needs-key without any request", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "k-987654" });
    const server = remote({ url: fake.mcpUrl, auth: "header", headers: { "x-api-key": true }, local: "this-computer" });
    const before = fake.requests.length;
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: false, reason: "needs-key" });
    expect(fake.requests.length).toBe(before);
    setMcpServerSecrets("a", { origin: fake!.origin, headers: { "x-api-key": "k-987654" } });
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: true, transport: "http" });
  });
  it("a masked link is dialed from the stored copy and is needs-key without one", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const server = remote({ url: `${fake.origin}/s/•••/mcp`, urlSecret: true, local: "this-computer" });
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: false, reason: "needs-key" });
    setMcpServerSecrets("a", { origin: fake!.origin, url: fake.mcpUrl });
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: true });
  });
  it("an oauth entry sends the stored access token, and without one the server's 401 says sign in", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    const server = remote({ url: fake.mcpUrl, auth: "oauth", local: "this-computer" });
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: false, reason: "needs-sign-in" });
    setMcpServerSecrets("a", { origin: fake!.origin, oauth: { accessToken: fake.mintAccessToken() } });
    expect(await testRemoteServer("a", server)).toMatchObject({ ok: true });
  });
  it("reports the transport that worked so the route can save it", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    expect(await testRemoteServer("a", remote({ url: fake.mcpUrl, local: "this-computer" }))).toMatchObject({ ok: true, transport: "sse" });
  });
  it("re-checks the address on every test: a confirmation that no longer matches is address-changed", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    expect(await testRemoteServer("a", remote({ url: fake.mcpUrl, local: "local-network" }))).toMatchObject({ ok: false, reason: "address-changed" });
    expect(await testRemoteServer("a", remote({ url: fake.mcpUrl }))).toMatchObject({ ok: false, reason: "address-changed" });
  });
});

describe("oauthTargetFor", () => {
  it("carries the link and the server's hints and no secret", async () => {
    fake = await startFakeRemoteMcp({ auth: "both", unauthorized: "comfy-verbatim" });
    const target = await oauthTargetFor("a", remote({ url: fake.mcpUrl, auth: "oauth", local: "this-computer" }));
    expect(target).toEqual({
      url: fake.mcpUrl,
      resourceMetadataUrl: "https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource",
      scopeHint: "comfy-mcp:tools:call",
      local: "this-computer",
    });
  });
  it("a step-up scope the relay saw joins the server's own hint (403 insufficient_scope to sign-in)", async () => {
    fake = await startFakeRemoteMcp({ auth: "both", unauthorized: "comfy-verbatim" });
    const target = await oauthTargetFor("a", remote({ url: fake.mcpUrl, auth: "oauth", local: "this-computer" }), {}, { stepUpScope: "tools:write comfy-mcp:tools:call" });
    expect(target?.scopeHint).toBe("comfy-mcp:tools:call tools:write");
    await fake.close();
    fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "plain", prm: true });
    const bare = await oauthTargetFor("a", remote({ url: fake.mcpUrl, auth: "oauth", local: "this-computer" }), {}, { stepUpScope: "tools:write" });
    expect(bare?.scopeHint).toBe("tools:write");
    const junk = await oauthTargetFor("a", remote({ url: fake.mcpUrl, auth: "oauth", local: "this-computer" }), {}, { stepUpScope: "bad\u0000scope ok" });
    expect(junk?.scopeHint).toBe("ok");
  });
  it("a link that holds a key has no sign-in target", async () => {
    expect(await oauthTargetFor("a", remote({ url: "https://x.example/s/•••/mcp", urlSecret: true }))).toBeNull();
    expect(await oauthTargetFor("a", remote({ url: "https://x.example/mcp?k=1", urlSecret: true }))).toBeNull();
  });
});

describe("H2 helpers on the routes", () => {
  it("bindSecretsToEntry stamps the entry's origin and refuses a push issued for another", () => {
    expect(bindSecretsToEntry({ headers: { K: "v" } }, "https://a.example/mcp")).toEqual({ ok: true, doc: { headers: { K: "v" }, origin: "https://a.example" } });
    expect(bindSecretsToEntry({ origin: "https://a.example", headers: { K: "v" } }, "https://a.example/other")).toMatchObject({ ok: true });
    expect(bindSecretsToEntry({ origin: "https://b.example", headers: { K: "v" } }, "https://a.example/mcp")).toEqual({ ok: false, error: "These secrets were issued for another address." });
    expect(bindSecretsToEntry({ headers: { K: "v" } }, "nonsense")).toMatchObject({ ok: false });
  });
  it("secretsNoLongerApply: a changed link or sign-in kind drops them; a toggle, a rename of the transport or an unchanged save keeps them", () => {
    const before = remote({ url: "https://a.example/mcp", auth: "header", headers: { K: true } });
    expect(secretsNoLongerApply(before, { ...before })).toBe(false);
    expect(secretsNoLongerApply(before, { ...before, enabled: false })).toBe(false);
    expect(secretsNoLongerApply(before, { ...before, transport: "sse" })).toBe(false);
    expect(secretsNoLongerApply(before, { ...before, url: "https://a.example/mcp2" })).toBe(true);
    expect(secretsNoLongerApply(before, { ...before, url: "https://b.example/mcp" })).toBe(true);
    expect(secretsNoLongerApply(before, { ...before, auth: "oauth", headers: {} })).toBe(true);
    expect(secretsNoLongerApply(before, { command: "npx", args: [], env: {}, enabled: true })).toBe(true);
    // T16: a command server's env values are in the store now, so a change of kind drops them too.
    expect(secretsNoLongerApply({ command: "npx", args: [], env: {}, enabled: true }, before)).toBe(true);
  });
});

describe("M4: no probe holds a slot longer than the route's deadline", () => {
  it("withDeadline aborts at the deadline and when the parent aborts", async () => {
    expect(MCP_ROUTE_DEADLINE_MS).toBeGreaterThanOrEqual(25_000);
    const timed = withDeadline(undefined, 30);
    expect(timed.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(timed.aborted).toBe(true);
    const parent = new AbortController();
    const child = withDeadline(parent.signal, 60_000);
    expect(child.aborted).toBe(false);
    parent.abort();
    expect(child.aborted).toBe(true);
    expect(withDeadline(AbortSignal.abort(), 60_000).aborted).toBe(true);
  });
  it("inspect hands the probes its signal, so a stuck server is ended by the route's deadline", async () => {
    let seen: AbortSignal | undefined;
    const signal = withDeadline(undefined, 50);
    await inspectMcpInput({ input: "https://slow.example/mcp" }, {
      existingNames: new Set(), signal,
      probe: async (input) => { seen = input.signal; await new Promise((resolve) => setTimeout(resolve, 120)); return { ok: false, reason: "no-answer", error: "x" }; },
    });
    expect(seen).toBe(signal);
    expect(seen!.aborted).toBe(true);
  });
});

describe("the server files run under node's strip-only TypeScript mode (review L1)", () => {
  // The server is started with node's type stripping, which refuses parameter
  // properties, enums and namespaces. `node --check` does not notice any of
  // them in this repo (REV2-4), so this strips every server file the way node
  // would and fails on the first one that cannot be stripped. Nothing is run.
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
  const serverDir = fileURLToPath(new URL(".", import.meta.url));

  it.each([
    ["a parameter property", "export class A { constructor(private x: number) {} }\n"],
    ["a public parameter property", "export class A { constructor(public readonly x: number) {} }\n"],
    ["an enum", "export enum E { A, B }\n"],
    ["a namespace with code", "export namespace N { export const x = 1; }\n"],
  ])("the guard catches %s", (_label, source) => {
    expect(() => stripTypeScriptTypes(source, { mode: "strip" })).toThrow();
  });

  it("accepts ordinary annotated code, so the guard is not a blanket failure", () => {
    expect(() => stripTypeScriptTypes("export class A { readonly x: number; constructor(x: number) { this.x = x; } }\n", { mode: "strip" })).not.toThrow();
  });

  it("L-e: every non-test .ts file under shared/ strips too: the server imports them under the same loader", () => {
    const sharedDir = fileURLToPath(new URL("../shared/", import.meta.url));
    const all = files(sharedDir);
    expect(all.map((path) => path.slice(sharedDir.length))).toContain("mcp-paste.ts");
    const failures: string[] = [];
    for (const file of all) {
      try {
        stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
      } catch (error) {
        failures.push(`${file.slice(sharedDir.length)}: ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every non-test file under server/ strips, link files included", () => {
    const all = files(serverDir);
    expect(all.length).toBeGreaterThan(100);
    for (const name of ["custom-mcp-mounts.ts", "remote-mcp-client.ts", "mcp-relay.ts", "mcp-secrets.ts", "drivers/remote-mcp-proxy.ts"]) {
      expect(all.map((path) => path.slice(serverDir.length))).toContain(name);
    }
    const failures: string[] = [];
    for (const file of all) {
      try {
        stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
      } catch (error) {
        failures.push(`${file.slice(serverDir.length)}: ${String((error as Error).message).split("\n")[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("the packaged layout ships the link proxy", () => {
  it("is a spawned proxy, resolves to a file, and is bundled as its own entry point", async () => {
    const { SPAWNED_PROXIES } = await import("./proxy-paths.ts");
    expect(SPAWNED_PROXIES.remoteMcp).toMatch(/remote-mcp-proxy\.(ts|js)$/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(SPAWNED_PROXIES.remoteMcp)).toBe(true);
    const bundle = readFileSync(new URL("../scripts/bundle-server.mjs", import.meta.url), "utf8");
    expect(bundle).toContain('"drivers/remote-mcp-proxy.ts"');
    expect(bundle).toContain('"connector-proxy.ts"');
  });
});
