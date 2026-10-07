// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// MCP-LINK T16 (a command server's env values leave config.json) and the
// T11 contract the harness keeps with main (NEXT-T11 L-d: every push names
// its origin).
import { afterEach, describe, expect, it } from "vitest";

import { customMcpServerDescriptors, customMcpServers } from "./config.ts";
import {
  listAllMcpServers,
  parseAnyMcpServerMutation,
  parseAnyStoredMcpServer,
  parseMcpServerMutation,
  parseStoredMcpServer,
  toStoredMcpEntry,
  type StoredMcpServer,
} from "./mcp-registry.ts";
import { acceptSecretsPush, secretsNoLongerApply } from "./mcp-remote-api.ts";
import { clearAllMcpServerSecrets, mcpEnvHeld, mcpSecretPresence, resolveHeldEnv, sanitizeSecretDoc, setMcpServerSecrets } from "./mcp-secrets.ts";

afterEach(() => clearAllMcpServerSecrets());

const cfg = (mcpServers: Record<string, unknown>) => ({ mcpServers }) as Parameters<typeof customMcpServers>[0];

describe("T16: stored env placeholders", () => {
  it("a stored `true` is refused with nothing holding it, exactly as before", () => {
    expect(parseStoredMcpServer("notes", { command: "npx", env: { NOTES_TOKEN: true } })).toEqual({ ok: false, error: "No saved value exists for NOTES_TOKEN." });
  });

  it("a stored `true` is accepted when the secret store holds it, and named in heldEnv", () => {
    const held = (name: string, key: string) => name === "notes" && key === "NOTES_TOKEN";
    expect(parseStoredMcpServer("notes", { command: "npx", env: { NOTES_TOKEN: true, MODE: "ro" } }, { envHeld: held })).toEqual({
      ok: true, server: { command: "npx", args: [], env: { MODE: "ro" }, heldEnv: ["NOTES_TOKEN"], enabled: true },
    });
  });

  it("toStoredMcpEntry writes held names back as `true`, never a value", () => {
    const server: StoredMcpServer = { command: "npx", args: ["-y", "x"], env: { MODE: "ro" }, heldEnv: ["NOTES_TOKEN"], enabled: false };
    expect(toStoredMcpEntry(server)).toEqual({ command: "npx", args: ["-y", "x"], env: { MODE: "ro", NOTES_TOKEN: true }, enabled: false });
    const plain: StoredMcpServer = { command: "npx", args: [], env: { A: "1" }, enabled: true };
    expect(toStoredMcpEntry(plain)).toEqual({ command: "npx", args: [], env: { A: "1" }, enabled: true });
  });

  it("packaged mutations refuse an env value in the body and take `true` for a new name", () => {
    expect(parseAnyMcpServerMutation("notes", { command: "npx", env: { NOTES_TOKEN: "plain" } }, undefined, { secretsInBody: false })).toEqual({ ok: false, error: "Enter the value in its field." });
    expect(parseAnyMcpServerMutation("notes", { command: "npx", env: { NOTES_TOKEN: true } }, undefined, { secretsInBody: false })).toEqual({
      ok: true, server: { command: "npx", args: [], env: {}, heldEnv: ["NOTES_TOKEN"], enabled: false },
    });
  });

  it("dev mutations keep today's rules: values in the body, `true` only for a saved value", () => {
    expect(parseMcpServerMutation("notes", { command: "npx", env: { NOTES_TOKEN: "plain" } })).toMatchObject({ ok: true, server: { env: { NOTES_TOKEN: "plain" } } });
    expect(parseMcpServerMutation("notes", { command: "npx", env: { NOTES_TOKEN: true } })).toEqual({ ok: false, error: "No saved value exists for NOTES_TOKEN." });
  });

  it("an edit keeps a held name held with `true`", () => {
    const existing: StoredMcpServer = { command: "npx", args: [], env: {}, heldEnv: ["NOTES_TOKEN"], enabled: true };
    expect(parseAnyMcpServerMutation("notes", { command: "npx2", env: { NOTES_TOKEN: true } }, existing, { secretsInBody: false })).toEqual({
      ok: true, server: { command: "npx2", args: [], env: {}, heldEnv: ["NOTES_TOKEN"], enabled: true },
    });
  });

  it("the listing shows every env name, and needs-key while a held value is missing", () => {
    const raw = { notes: { command: "npx", env: { NOTES_TOKEN: true, MODE: "ro" } }, plain: { command: "x", env: { A: "1" } } };
    const listed = listAllMcpServers(raw, mcpSecretPresence());
    expect(listed.find((row) => row.name === "notes")).toMatchObject({ kind: "stdio", envKeys: ["MODE", "NOTES_TOKEN"], status: "needs-key" });
    expect(listed.find((row) => row.name === "plain")).not.toHaveProperty("status");
    setMcpServerSecrets("notes", { env: { NOTES_TOKEN: "nt" } });
    expect(listAllMcpServers(raw, mcpSecretPresence()).find((row) => row.name === "notes")).toMatchObject({ status: "ready" });
    expect(JSON.stringify(listAllMcpServers(raw, mcpSecretPresence()))).not.toContain("nt\"");
  });
});

describe("T16: the store holds env values and mounts merge them", () => {
  it("sanitizeSecretDoc keeps env strings with valid names and drops Murage's own", () => {
    expect(sanitizeSecretDoc({ env: { NOTES_TOKEN: "nt", EMPTY: "", MURAGE_MCP_TOKEN: "x", "bad name": "y", N: 5 } })).toEqual({ env: { NOTES_TOKEN: "nt", EMPTY: "" } });
  });

  it("customMcpServers mounts a held value and skips an entry whose value is held nowhere", () => {
    const config = cfg({ notes: { command: "npx", env: { NOTES_TOKEN: true, MODE: "ro" } }, other: { command: "y", env: { K: true } } });
    setMcpServerSecrets("notes", { env: { NOTES_TOKEN: "nt-secret" } });
    expect(customMcpServers(config)).toEqual({ notes: { command: "npx", args: [], env: { MODE: "ro", NOTES_TOKEN: "nt-secret" } } });
    expect(customMcpServerDescriptors(config).stdio).toEqual({ notes: { command: "npx", args: [], env: { MODE: "ro", NOTES_TOKEN: "nt-secret" } } });
    expect(JSON.stringify(config)).not.toContain("nt-secret");
  });

  it("resolveHeldEnv names what is missing", () => {
    setMcpServerSecrets("notes", { env: { A: "1" } });
    const server: StoredMcpServer = { command: "x", args: [], env: { M: "m" }, heldEnv: ["A", "B"], enabled: true };
    expect(resolveHeldEnv("notes", server)).toEqual({ env: { M: "m", A: "1" }, missing: ["B"] });
    expect(mcpEnvHeld("notes", "A")).toBe(true);
    expect(mcpEnvHeld("notes", "B")).toBe(false);
  });

  it("a held env value is not a link secret: it is never sent by a link entry", () => {
    setMcpServerSecrets("mixed", { env: { A: "1" } });
    const parsed = parseAnyStoredMcpServer("mixed", { url: "https://a.example/mcp" });
    expect(parsed.ok).toBe(true);
  });
});

describe("the secrets push contract (NEXT-T11 L-d)", () => {
  const remote = { url: "https://a.example/mcp", auth: "header" as const, headers: { "X-API-Key": true as const }, enabled: true };
  const stdio: StoredMcpServer = { command: "npx", args: [], env: {}, heldEnv: ["NOTES_TOKEN"], enabled: true };

  it("a push for a link server must name its origin: none is 400, another is 409, its own is accepted", () => {
    expect(acceptSecretsPush({ headers: { "X-API-Key": "k" } }, remote)).toEqual({ ok: false, status: 400, error: "Name the address these secrets were issued for." });
    expect(acceptSecretsPush({ origin: "https://b.example", headers: { "X-API-Key": "k" } }, remote)).toEqual({ ok: false, status: 409, error: "These secrets were issued for another address." });
    expect(acceptSecretsPush({ origin: "https://a.example", headers: { "X-API-Key": "k" } }, remote)).toEqual({ ok: true, doc: { origin: "https://a.example", headers: { "X-API-Key": "k" } } });
  });

  it("a link push cannot carry env, and a command push carries env only and no origin", () => {
    expect(acceptSecretsPush({ origin: "https://a.example", env: { A: "1" } }, remote)).toMatchObject({ ok: false, status: 400 });
    expect(acceptSecretsPush({ env: { NOTES_TOKEN: "nt" } }, stdio)).toEqual({ ok: true, doc: { env: { NOTES_TOKEN: "nt" } } });
    expect(acceptSecretsPush({ origin: "https://a.example", env: { NOTES_TOKEN: "nt" } }, stdio)).toMatchObject({ ok: false, status: 400 });
    expect(acceptSecretsPush({ headers: { K: "v" } }, stdio)).toMatchObject({ ok: false, status: 400 });
    expect(acceptSecretsPush(null, stdio)).toMatchObject({ ok: false, status: 400 });
  });

  it("changing kind in either direction drops the saved secrets", () => {
    expect(secretsNoLongerApply(stdio, remote)).toBe(true);
    expect(secretsNoLongerApply(remote, stdio)).toBe(true);
    expect(secretsNoLongerApply(stdio, { ...stdio, command: "other" })).toBe(false);
  });
});
