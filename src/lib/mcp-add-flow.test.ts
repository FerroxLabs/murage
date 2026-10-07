// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it, vi } from "vitest";
import { parsePaste, type PasteRemoteDraft, type PasteStdioDraft } from "../../shared/mcp-paste";
import type { McpBridge } from "./mcp-bridge";
import {
  defaultHeaderChoice, envForBody, headerFor, headerValues, inspectInput, installStage, removeServer, saveCommand, saveRemote, signInTo, splitValues, testServer,
} from "./mcp-add-flow";

const KEY = "sk-live-THE-SECRET-KEY-0042";

function recorder(answers: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method: string; body: string }> = [];
  const order: string[] = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ?? "" });
    order.push(`api ${init?.method ?? "GET"} ${path}`);
    return answers[path] ?? { servers: [] };
  });
  const bridge: McpBridge = {
    mode: vi.fn(async () => "desktop" as const),
    saveSecrets: vi.fn(async (name) => { order.push(`saveSecrets ${name}`); return { ok: true } as const; }),
    signIn: vi.fn(async (name) => { order.push(`signIn ${name}`); return { ok: true } as const; }),
    cancelSignIn: vi.fn(async () => true),
    signOut: vi.fn(async () => ({ ok: true, revoked: true, message: "Signed out." }) as const),
    remove: vi.fn(async (name) => { order.push(`remove ${name}`); return { ok: true, revoked: true, message: "Removed. Murage also signed you out of cloud.comfy.org." } as const; }),
  };
  return { api, bridge, calls, order };
}

const remoteDraft = (input: string): PasteRemoteDraft => {
  const parsed = parsePaste(input);
  if (!parsed.ok || parsed.drafts[0]?.kind !== "remote") throw new Error("fixture is not a link");
  return parsed.drafts[0];
};
const stdioDraft = (input: string): PasteStdioDraft => {
  const parsed = parsePaste(input);
  if (!parsed.ok || parsed.drafts[0]?.kind !== "stdio") throw new Error("fixture is not a command");
  return parsed.drafts[0];
};

describe("inspectInput", () => {
  it("keeps the pasted link locally, takes the probe from the harness, and sends only the paste", async () => {
    const { api, calls } = recorder({
      "/api/mcp/inspect": { ok: true, source: "link", notes: [], drafts: [{ kind: "remote", name: "comfy", maskedUrl: "https://cloud.comfy.org/mcp", urlHasSecret: false, fields: [], probe: { ok: false, reason: "needs-sign-in", error: "x", signIn: { host: "cloud.comfy.org" }, apiKey: { headerHint: "x-api-key" } } }] },
    });
    const out = await inspectInput({ api }, "https://cloud.comfy.org/mcp");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.drafts[0]).toMatchObject({ kind: "remote", name: "comfy", url: "https://cloud.comfy.org/mcp", probe: { reason: "needs-sign-in", apiKey: { headerHint: "x-api-key" } } });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ input: "https://cloud.comfy.org/mcp" });
  });

  it("sends the local confirmation when the owner gave it", async () => {
    const { api, calls } = recorder({ "/api/mcp/inspect": { ok: true, source: "link", notes: [], drafts: [{ kind: "remote", name: "x", maskedUrl: "http://127.0.0.1:8811/mcp", urlHasSecret: false, fields: [] }] } });
    await inspectInput({ api }, "http://127.0.0.1:8811/mcp", "this-computer");
    expect(JSON.parse(calls[0]!.body)).toEqual({ input: "http://127.0.0.1:8811/mcp", confirmLocal: "this-computer" });
  });

  it("does not call the harness for a paste that cannot be read, and says why", async () => {
    const { api } = recorder();
    const out = await inspectInput({ api }, "[server]\ncommand = \"npx\"");
    expect(out).toMatchObject({ ok: false });
    expect(api).not.toHaveBeenCalled();
  });
});

describe("saveRemote: the sequencing contract", () => {
  const draft = remoteDraft("https://cloud.comfy.org/mcp");

  it("saves the entry first, then hands the key to the shell, and no request body carries the key", async () => {
    const { api, bridge, calls, order } = recorder();
    const result = await saveRemote({ api, bridge }, { name: "comfy", draft, auth: "header", headers: { "X-API-Key": KEY } });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["api POST /api/mcp/servers", "saveSecrets comfy"]);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ name: "comfy", url: "https://cloud.comfy.org/mcp", auth: "header", headers: { "X-API-Key": true }, enabled: false });
    expect(calls.map((call) => call.body).join("")).not.toContain(KEY);
    expect(bridge.saveSecrets).toHaveBeenCalledWith("comfy", { headers: { "X-API-Key": KEY } });
  });

  it("never saves secrets when the entry itself was refused", async () => {
    const { bridge } = recorder();
    const api = vi.fn(async () => { throw new Error("An MCP server with that name already exists."); });
    const result = await saveRemote({ api, bridge }, { name: "comfy", draft, auth: "header", headers: { "X-API-Key": KEY } });
    expect(result).toEqual({ ok: false, message: "An MCP server with that name already exists." });
    expect(bridge.saveSecrets).not.toHaveBeenCalled();
  });

  it("stores a link that holds a key masked, and gives the shell the real one", async () => {
    const secretLink = "https://hooks.example.com/mcp/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123/run";
    const secretDraft = remoteDraft(secretLink);
    expect(secretDraft.urlHasSecret).toBe(true);
    const { api, bridge, calls } = recorder();
    await saveRemote({ api, bridge }, { name: "hook", draft: secretDraft, auth: "none", headers: {} });
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ name: "hook", url: secretDraft.maskedUrl, urlSecret: true });
    expect(calls[0]!.body).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123");
    expect(bridge.saveSecrets).toHaveBeenCalledWith("hook", { url: secretLink });
  });

  it("asks the shell for nothing when a plain link has no secret to keep", async () => {
    const { api, bridge } = recorder();
    await saveRemote({ api, bridge }, { name: "comfy", draft, auth: "oauth", headers: {} });
    expect(bridge.saveSecrets).not.toHaveBeenCalled();
  });

  it("replaces an entry it already saved (PUT), so a change of method carries on", async () => {
    const { api, bridge, calls } = recorder();
    await saveRemote({ api, bridge }, { name: "comfy", draft, auth: "header", headers: { Authorization: `Bearer ${KEY}` }, existing: true });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/mcp/servers/comfy" });
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("name");
    expect(calls[0]!.body).not.toContain(KEY);
    expect(bridge.saveSecrets).toHaveBeenCalledWith("comfy", { headers: { Authorization: `Bearer ${KEY}` } });
  });

  it("with no desktop shell the values ride the body, which is the only place they can go", async () => {
    const { api, calls } = recorder();
    await saveRemote({ api }, { name: "comfy", draft, auth: "header", headers: { "X-API-Key": KEY } });
    expect(JSON.parse(calls[0]!.body).headers).toEqual({ "X-API-Key": KEY });
  });

  it("carries the local confirmation into the body", async () => {
    const { api, bridge, calls } = recorder();
    await saveRemote({ api, bridge }, { name: "mine", draft: remoteDraft("http://127.0.0.1:8811/mcp"), auth: "none", headers: {}, confirmLocal: "this-computer" });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ confirmLocal: "this-computer" });
  });
});

describe("saveCommand, sign-in, test, remove", () => {
  it("sends environment names as placeholders and the values to the shell", async () => {
    const draft = stdioDraft("GITHUB_TOKEN=abc123 npx -y @x/github");
    const { api, bridge, calls } = recorder();
    await saveCommand({ api, bridge }, { name: "github", draft, env: { GITHUB_TOKEN: "abc123" } });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ name: "github", command: "npx", env: { GITHUB_TOKEN: true }, enabled: false });
    expect(calls[0]!.body).not.toContain("abc123");
    expect(bridge.saveSecrets).toHaveBeenCalledWith("github", { env: { GITHUB_TOKEN: "abc123" } });
  });

  it("signs in through the shell and reports a cancel as a cancel", async () => {
    const { api, bridge } = recorder();
    expect(await signInTo({ api, bridge }, "comfy")).toEqual({ ok: true });
    const cancelled: McpBridge = { ...bridge, signIn: vi.fn(async () => ({ ok: false, error: "cancelled", message: "Sign-in was cancelled." }) as const) };
    expect(await signInTo({ api, bridge: cancelled }, "comfy")).toEqual({ ok: false, message: "Sign-in was cancelled.", cancelled: true });
    expect(await signInTo({ api }, "comfy")).toMatchObject({ ok: false, cancelled: false });
  });

  it("asks for the long first-run window only when told it is a first run", async () => {
    const { api, calls } = recorder({ "/api/mcp/servers/a/test": { ok: true, tools: [] } });
    await testServer({ api }, "a");
    await testServer({ api }, "a", true);
    expect(calls[0]!.body).toBe("");
    expect(JSON.parse(calls[1]!.body)).toEqual({ patience: "first-run" });
  });

  it("turns a failed request into a failed probe, not an exception", async () => {
    const api = vi.fn(async () => { throw new Error("Two MCP connection tests are already running."); });
    expect(await testServer({ api }, "a")).toEqual({ ok: false, error: "Two MCP connection tests are already running." });
  });

  it("removes through the shell alone when there is one, and deletes itself when there is not", async () => {
    const withShell = recorder();
    expect(await removeServer({ api: withShell.api, bridge: withShell.bridge }, "comfy")).toEqual({ ok: true, message: "Removed. Murage also signed you out of cloud.comfy.org." });
    expect(withShell.calls).toEqual([]);
    const without = recorder();
    expect(await removeServer({ api: without.api }, "comfy")).toEqual({ ok: true });
    expect(without.calls[0]).toMatchObject({ method: "DELETE", path: "/api/mcp/servers/comfy" });
  });
});

describe("small rules", () => {
  it("names the header a key goes in", () => {
    expect(headerFor("authorization", "")).toEqual({ name: "Authorization", prefix: "Bearer " });
    expect(headerFor("x-api-key", "")).toEqual({ name: "X-API-Key", prefix: "" });
    expect(headerFor("custom", " X-Token ")).toEqual({ name: "X-Token", prefix: "" });
    expect(defaultHeaderChoice("x-api-key")).toBe("x-api-key");
    expect(defaultHeaderChoice(undefined)).toBe("authorization");
  });

  it("keeps a snippet's Bearer prefix fixed and asks only for the token", () => {
    const draft = remoteDraft('{"mcpServers":{"gh":{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${input:github_token}"}}}}');
    const field = draft.fields[0]!;
    expect(headerValues(draft.fields, { [field.id]: "ghp_abc" })).toEqual({ Authorization: "Bearer ghp_abc" });
    expect(headerValues(draft.fields, {})).toEqual({});
  });

  it("splits typed values between the body and the shell", () => {
    expect(splitValues({ A: "1" }, undefined)).toEqual({ body: { A: "1" }, secrets: {} });
    expect(splitValues({ A: "1" }, recorder().bridge)).toEqual({ body: { A: true }, secrets: { A: "1" } });
    const { bridge } = recorder();
    expect(envForBody({ KEEP: true, NEW: "v", BLANK: "" }, bridge)).toEqual({ body: { KEEP: true, NEW: true, BLANK: "" }, secrets: { NEW: "v" } });
    expect(envForBody({ NEW: "v" }, undefined)).toEqual({ body: { NEW: "v" }, secrets: {} });
  });

  it("stages the wait for a first run at 8 and 60 seconds", () => {
    expect([0, 7, 8, 59, 60, 200].map(installStage)).toEqual(["start", "start", "setup", "setup", "still", "still"]);
  });
});

import { usableMcpBridge } from "./mcp-bridge";
describe("usableMcpBridge", () => {
  it("is the bridge only in desktop mode; a dev launch (local-config) or no shell sends values in the body", async () => {
    const { bridge } = recorder();
    vi.stubGlobal("window", { muragebox: { mcpServers: bridge } });
    expect(await usableMcpBridge()).toBe(bridge);
    vi.stubGlobal("window", { muragebox: { mcpServers: { ...bridge, mode: async () => "local-config" } } });
    expect(await usableMcpBridge()).toBeUndefined();
    vi.stubGlobal("window", { muragebox: { mcpServers: { ...bridge, mode: async () => { throw new Error("x"); } } } });
    expect(await usableMcpBridge()).toBeUndefined();
    vi.stubGlobal("window", {});
    expect(await usableMcpBridge()).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

import { displayArgs, moveArgSecretsToEnv, secretsInArgs } from "./mcp-add-flow";
describe("a secret in a command's arguments (review L5)", () => {
  const stdio = (args: string[]): PasteStdioDraft => ({ kind: "stdio", name: "x", command: "npx", args, fields: [] });
  it("finds the value of a secret-named flag, joined or separate, and a bare credential", () => {
    expect(secretsInArgs(["-y", "@x/server", "--api-key", "abc123"])).toEqual([{ indexes: [2, 3], envName: "API_KEY", value: "abc123" }]);
    expect(secretsInArgs(["--token=abc123"])).toEqual([{ indexes: [0], envName: "TOKEN", value: "abc123" }]);
    expect(secretsInArgs(["-y", "ghp_abcdefghijklmnop1234"])).toEqual([{ indexes: [1], envName: "SECRET", value: "ghp_abcdefghijklmnop1234" }]);
  });
  it("leaves placeholders, variable references, plain flags and paths alone", () => {
    expect(secretsInArgs(["--api-key", "<your key>"])).toEqual([]);
    expect(secretsInArgs(["--token", "${TOKEN}"])).toEqual([]);
    expect(secretsInArgs(["--port", "8080", "--root", "/home/me/project", "-y"])).toEqual([]);
    expect(secretsInArgs(["--api-key"])).toEqual([]);
  });
  it("moves the value into a secret environment field and out of the arguments", () => {
    const moved = moveArgSecretsToEnv(stdio(["-y", "@x/server", "--api-key", "abc123"]), {});
    expect(moved.draft.args).toEqual(["-y", "@x/server"]);
    expect(moved.draft.fields).toEqual([{ id: "env:API_KEY", label: "API_KEY", secret: true, placeholder: false, where: { type: "env", name: "API_KEY" } }]);
    expect(moved.typed).toEqual({ "env:API_KEY": "abc123" });
    expect(JSON.stringify(moved.draft)).not.toContain("abc123");
    const nothing = stdio(["-y", "pkg"]);
    expect(moveArgSecretsToEnv(nothing, {}).draft).toBe(nothing);
  });
  it("never draws the value: the displayed command hides it", () => {
    expect(displayArgs(["-y", "pkg", "--api-key", "abc123", "--token=zzz999"])).toEqual(["-y", "pkg", "--api-key", "••••", "--token=••••"]);
  });
});
