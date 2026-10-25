// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Item 118 (design MCP-118-175 118-1, 118-2, 118-3): a bot files an MCP server
// switched off with names only. The screen is the same in packaged, dev and
// headless runs, so these unit cases cover all three. Every value below is fake.
import { afterEach, describe, expect, it } from "vitest";

import { BOT_MCP_NAMES_ONLY, addBotMcpServer, commandCredentialRefusal } from "./mcp-bot-add.ts";
import { mcpEnableRefusal, mcpCredentialCards, mcpEnableCard, resolveMcpCard, resolveMcpCredential, withKeyHeld } from "./mcp-bot-cards.ts";
import { MAX_MCP_SERVERS, listAllMcpServers, mcpEntryRev, mcpPendingKeys, parseAnyMcpServerMutation, parseAnyStoredMcpServer, toStoredMcpEntry } from "./mcp-registry.ts";
import { clearMcpServerSecrets, setMcpServerSecrets } from "./mcp-secrets.ts";
import { MCP_CARD_STALE, isMcpCredentialId, mcpCredentialCardText, mcpCredentialId, parseMcpCredentialId } from "../shared/credential-request.ts";

const FAKE_KEY = "sk-ant-FAKEFAKEFAKEFAKE0000"; // secret-scan: fixture
const add = (body: unknown, current: Record<string, unknown> = {}) => addBotMcpServer(current, body, "Sable");
const refusedNamesOnly = (result: ReturnType<typeof add>) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(BOT_MCP_NAMES_ONLY);
};

afterEach(() => { clearMcpServerSecrets("notes"); clearMcpServerSecrets("linky"); });

describe("add_mcp_server takes names only (118-1)", () => {
  it("refuses value-shaped env and header fields", () => {
    refusedNamesOnly(add({ name: "notes", command: "npx", env: { NOTES_TOKEN: FAKE_KEY } }));
    refusedNamesOnly(add({ name: "linky", url: "https://mcp.example.com/mcp", auth: "header", headers: { "x-api-key": FAKE_KEY } }));
    refusedNamesOnly(add({ name: "linky", url: "https://mcp.example.com/mcp", auth: "oauth", oauth: { accessToken: "at_fake" } }));
  });

  it("refuses a command or args that carry a credential, including --token=value", () => {
    for (const [command, args] of [
      [`npx -y notes --key ${FAKE_KEY}`, []],
      ["npx", ["-y", "notes", FAKE_KEY]],
      ["npx", ["-y", "notes", "--token=fake-token-value"]],
      ["npx", ["-y", "notes", "--api-key", "fakevalue"]],
      ["npx", ["--password", "hunter2fake"]],
      ["npx", ["-H", "Authorization: Bearer fakeBearerToken1234567"]],
      ["npx", ["-----BEGIN RSA PRIVATE KEY-----"]],
      ["npx --token=abc", []],
    ] as Array<[string, string[]]>) {
      expect(commandCredentialRefusal(command, args), `${command} ${args.join(" ")}`).not.toBeNull();
      refusedNamesOnly(add({ name: "notes", command, args }));
    }
    // a bare flag with nothing after it carries no value
    expect(commandCredentialRefusal("npx", ["-y", "notes", "--token"])).toBeNull();
    expect(commandCredentialRefusal("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"])).toBeNull();
  });

  it("refuses links with userinfo, a query, a fragment or a key in the path", () => {
    for (const url of [
      "https://user:fakepass@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?api_key=fake",
      "https://mcp.example.com/mcp#token=fake",
      `https://mcp.example.com/${FAKE_KEY}/mcp`,
    ]) refusedNamesOnly(add({ name: "linky", url }));
  });

  it("refuses `enabled`, unknown fields, a duplicate name and the server cap", () => {
    const enabled = add({ name: "notes", command: "npx", enabled: true });
    expect(enabled).toMatchObject({ ok: false, status: 400 });
    expect(add({ name: "notes", command: "npx", enabled: false })).toMatchObject({ ok: false });
    expect(add({ name: "notes", command: "npx", cwd: "/" })).toMatchObject({ ok: false });
    expect(add({ name: "notes", command: "npx" }, { notes: { command: "npx" } })).toMatchObject({ ok: false, status: 409 });
    const full = Object.fromEntries(Array.from({ length: MAX_MCP_SERVERS }, (_, index) => [`s${index}`, { command: "npx" }]));
    expect(add({ name: "notes", command: "npx" }, full)).toMatchObject({ ok: false });
    expect(add({ name: "notes", command: "npx", env_keys: ["lower_case"] })).toMatchObject({ ok: false });
    expect(add({ name: "notes", command: "npx", url: "https://mcp.example.com/mcp" })).toMatchObject({ ok: false });
  });

  it("files the entry switched off with its keys pending and a revision stamp", () => {
    const result = add({ name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"], env_keys: ["NOTES_TOKEN"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toEqual({
      command: "npx", args: ["-y", "@x/notes-mcp"], env: {}, pendingEnv: ["NOTES_TOKEN"], rev: result.rev,
      enabled: false, disabledReason: "Added by Sable; turn on to use it",
    });
    expect(result.rev).toBe(mcpEntryRev("notes", result.server));
    expect(result.rev).toMatch(/^[0-9a-f]{12}$/);
    // the stored entry reads back as needing a key, with no value anywhere
    const listed = listAllMcpServers({ notes: result.entry }).find((server) => server.name === "notes");
    expect(listed).toMatchObject({ status: "needs-key", pendingKeys: ["NOTES_TOKEN"], envKeys: ["NOTES_TOKEN"], enabled: false });
    const link = add({ name: "linky", url: "https://mcp.example.com/mcp", transport: "sse", auth: "header", header_keys: ["x-api-key"] });
    expect(link).toMatchObject({ ok: true, entry: { url: "https://mcp.example.com/mcp", transport: "sse", auth: "header", headers: {}, pendingHeaders: ["x-api-key"], enabled: false } });
  });

  it("a renderer edit keeps the pending slot and cannot set pending keys or the stamp itself", () => {
    const filed = add({ name: "notes", command: "npx", env_keys: ["NOTES_TOKEN"] });
    if (!filed.ok) throw new Error(filed.error);
    const forged = parseAnyMcpServerMutation("notes", { command: "npx", env: {}, pendingEnv: ["OTHER"], rev: "000000000000" });
    expect(forged.ok && (forged.server as { pendingEnv?: string[] }).pendingEnv).toBeFalsy();
    const kept = parseAnyMcpServerMutation("notes", { command: "npx", args: [], env: { NOTES_TOKEN: true } }, filed.server, { secretsInBody: false });
    expect(kept.ok && mcpPendingKeys(kept.server)).toEqual(["NOTES_TOKEN"]);
  });
});

describe("dynamic credential ids and cards (118-3)", () => {
  const filed = () => {
    const result = add({ name: "notes", command: "npx", env_keys: ["NOTES_TOKEN"] });
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  it("names one key of one entry at one revision", () => {
    const { rev } = filed();
    const id = mcpCredentialId("notes", "NOTES_TOKEN", rev);
    expect(id).toBe(`mcp:notes:NOTES_TOKEN:${rev}`);
    expect(isMcpCredentialId(id)).toBe(true);
    expect(parseMcpCredentialId(id)).toEqual({ name: "notes", key: "NOTES_TOKEN", rev });
    for (const bad of ["mcp:notes:NOTES_TOKEN", "mcp:Notes:K:0123456789ab", "mcp:notes:K:xyz", "openaiImageApiKey"]) expect(isMcpCredentialId(bad)).toBe(false);
    expect(mcpCredentialCardText("notes", "NOTES_TOKEN").label).toBe("NOTES_TOKEN for notes");
  });

  it("resolves only a declared key at the current revision", () => {
    const { entry, rev } = filed();
    const servers = { notes: entry };
    expect(resolveMcpCredential(servers, mcpCredentialId("notes", "NOTES_TOKEN", rev))).toMatchObject({ ok: true });
    expect(resolveMcpCredential(servers, mcpCredentialId("notes", "OTHER_KEY", rev))).toMatchObject({ ok: false, stale: true });
    expect(resolveMcpCredential(servers, mcpCredentialId("notes", "NOTES_TOKEN", "0123456789ab"))).toMatchObject({ ok: false, stale: true });
    expect(resolveMcpCredential({}, mcpCredentialId("notes", "NOTES_TOKEN", rev))).toMatchObject({ ok: false, stale: true });
    // an edit of what it runs is a new revision: the old card is stale
    const edited = { notes: { ...entry, args: ["-y", "other"] } };
    expect(resolveMcpCard(edited, "notes", rev)).toEqual({ ok: false, stale: true });
    expect(MCP_CARD_STALE).toBe("This server changed; ask again");
  });

  it("refuses to turn on while a key is pending, and after a save only when the value is held", () => {
    const { server, rev } = filed();
    expect(mcpEnableRefusal("notes", server)).toBe("Enter NOTES_TOKEN on its card before turning notes on.");
    const held = withKeyHeld(server, "NOTES_TOKEN");
    expect(mcpPendingKeys(held)).toEqual([]);
    expect(toStoredMcpEntry(held)).toMatchObject({ env: { NOTES_TOKEN: true }, rev });
    expect(mcpEnableRefusal("notes", held)).toMatch(/needs a value for NOTES_TOKEN/);
    setMcpServerSecrets("notes", { env: { NOTES_TOKEN: "fake-notes-value" } });
    expect(mcpEnableRefusal("notes", held)).toBeNull();
    expect(JSON.stringify(toStoredMcpEntry(held))).not.toContain("fake-notes-value");
  });

  it("checks a link's header against the origin it was saved for", () => {
    const result = add({ name: "linky", url: "https://mcp.example.com/mcp", auth: "header", header_keys: ["x-api-key"] });
    if (!result.ok) throw new Error(result.error);
    const held = withKeyHeld(result.server, "x-api-key");
    setMcpServerSecrets("linky", { origin: "https://elsewhere.example.net", headers: { "x-api-key": "fake-header-value" } });
    expect(mcpEnableRefusal("linky", held)).toMatch(/needs a value for x-api-key/);
    setMcpServerSecrets("linky", { origin: "https://mcp.example.com", headers: { "x-api-key": "fake-header-value" } });
    expect(mcpEnableRefusal("linky", held)).toBeNull();
  });

  it("builds a Turn on card and one credential card per pending key, with no value", () => {
    const { name, server, rev } = filed();
    const card = mcpEnableCard(name, server, rev, { id: "b1", name: "Sable" });
    expect(card).toMatchObject({ kind: "mcpEnable", title: "Turn on notes?", options: ["Turn on", "Not now"], mcpEnable: { name, rev, kind: "stdio", command: "npx", pendingKeys: ["NOTES_TOKEN"] } });
    expect(mcpCredentialCards(name, server, rev)).toEqual([expect.objectContaining({ target: `mcp:notes:NOTES_TOKEN:${rev}`, label: "NOTES_TOKEN for notes" })]);
    const words = JSON.stringify([card, mcpCredentialCards(name, server, rev), BOT_MCP_NAMES_ONLY, MCP_CARD_STALE]);
    expect(words).not.toMatch(/—|–|composio|price|\b(safe|safely|safety|unsafe)\b/i);
  });

  it("an owner's own entry keeps its switch (turn on first, key after)", () => {
    const owner = parseAnyStoredMcpServer("linky", { url: "https://mcp.example.com/mcp", auth: "header", headers: { "x-api-key": true } }, { envHeld: () => true });
    if (!owner.ok) throw new Error(owner.error);
    expect(mcpEnableRefusal("linky", owner.server)).toBeNull();
  });
});

describe("hardening: more credential shapes and the waiting cap (1.0.4 follow-up)", () => {
  it("refuses --key, -k, --auth, --password and Basic/Bearer literals and URL userinfo", () => {
    for (const [command, args] of [
      ["npx", ["notes", "--key", "plainvalue"]],
      ["npx", ["notes", "--key=plainvalue"]],
      ["npx", ["notes", "-k", "plainvalue"]],
      ["npx", ["notes", "--auth", "plainvalue"]],
      ["npx", ["notes", "--auth=plainvalue"]],
      ["npx", ["notes", "--password=plainvalue"]],
      ["npx", ["notes", "--token=plainvalue"]],
      ["npx", ["-H", "Authorization: Basic dXNlcjpwYXNz"]],
      ["npx", ["-H", "Authorization:", "Bearer", "abcd1234"]],
      ["npx", ["notes", "https://user:fakepass@host.example.com/mcp"]],
      [`npx notes postgres://admin:fakepass@db.example.com/x`, []],
    ] as Array<[string, string[]]>) {
      expect(commandCredentialRefusal(command, args), `${command} ${args.join(" ")}`).not.toBeNull();
    }
    expect(commandCredentialRefusal("npx", ["notes", "--key"])).toBeNull();
    expect(commandCredentialRefusal("npx", ["notes", "https://host.example.com/mcp"])).toBeNull();
  });

  it("stops a bot after three servers waiting for the owner, and counts each bot by name", () => {
    let current: Record<string, unknown> = {};
    for (const name of ["one", "two", "three"]) {
      const made = add({ name, command: "npx", args: ["-y", name] }, current);
      expect(made.ok, name).toBe(true);
      if (made.ok) current = { ...current, [name]: made.entry };
    }
    const fourth = add({ name: "four", command: "npx" }, current);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error).toMatch(/waiting for the owner/);
    // another bot is not held back, and a server the owner turned on no longer waits
    expect(addBotMcpServer(current, { name: "four", command: "npx" }, "Other").ok).toBe(true);
    expect(add({ name: "four", command: "npx" }, { ...current, one: { ...(current.one as object), enabled: true } }).ok).toBe(true);
  });
});
