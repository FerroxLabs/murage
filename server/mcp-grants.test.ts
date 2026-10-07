// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MCP_GRANTS, MCP_GRANT_TTL_MS, McpGrants, mcpGrantAdmits } from "./mcp-grants.ts";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "murage-grants-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("McpGrants", () => {
  it("stores a hash only, in a file only the owner can read, and survives a restart", () => {
    const dir = fresh();
    const grants = new McpGrants(dir);
    const made = grants.mint({ botId: "b1", send: true })!;
    const file = join(dir, "mcp-grants.json");
    expect(readFileSync(file, "utf8")).not.toContain(made.token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(new McpGrants(dir).resolve(bearer(made.token))).toMatchObject({ botId: "b1", send: true });
  });

  it("refuses a wrong, malformed or missing token, and ends at expiry or revoke", () => {
    let now = 1_000;
    const grants = new McpGrants(fresh(), () => now);
    const made = grants.mint({ botId: "b1", send: false })!;
    expect(grants.resolve({})).toBeNull();
    expect(grants.resolve(bearer("mcpg_" + "0".repeat(64)))).toBeNull();
    expect(grants.resolve(bearer("not-a-grant"))).toBeNull();
    expect(grants.resolve(bearer(made.token))).not.toBeNull();
    now += MCP_GRANT_TTL_MS + 1;
    expect(grants.resolve(bearer(made.token))).toBeNull();
    expect(grants.list()).toEqual([]);
    const again = grants.mint({ botId: "b1", send: false })!;
    expect(grants.revoke(again.grant.id)).toBe(true);
    expect(grants.resolve(bearer(again.token))).toBeNull();
  });

  it("keeps a bounded number of grants", () => {
    const grants = new McpGrants(fresh());
    for (let i = 0; i < MAX_MCP_GRANTS; i++) expect(grants.mint({ botId: `b${i}`, send: false })).not.toBeNull();
    expect(grants.mint({ botId: "extra", send: false })).toBeNull();
  });
});

describe("mcpGrantAdmits", () => {
  const read = { id: "g", botId: "b1", send: false, createdAt: 0, expiresAt: 1 };
  const send = { ...read, send: true };
  const owner = (thread: string) => ({ t1: "b1", t2: "b2" } as Record<string, string>)[thread];
  it("opens a handful of routes for one bot and nothing else", () => {
    expect(mcpGrantAdmits(read, "GET", "/api/health", owner)).toBe(true);
    expect(mcpGrantAdmits(read, "GET", "/api/bots", owner)).toBe(true);
    expect(mcpGrantAdmits(read, "POST", "/api/bots", owner)).toBe(false);
    expect(mcpGrantAdmits(read, "GET", "/api/threads/t1/messages", owner)).toBe(true);
    expect(mcpGrantAdmits(read, "GET", "/api/threads/t2/messages", owner)).toBe(false);
    expect(mcpGrantAdmits(read, "GET", "/api/threads/none/messages", owner)).toBe(false);
    expect(mcpGrantAdmits(read, "POST", "/api/bots/b1/messages", owner)).toBe(false);
    expect(mcpGrantAdmits(send, "POST", "/api/bots/b1/messages", owner)).toBe(true);
    expect(mcpGrantAdmits(send, "POST", "/api/bots/b1/interrupt", owner)).toBe(true);
    expect(mcpGrantAdmits(send, "POST", "/api/bots/b2/messages", owner)).toBe(false);
    for (const path of ["/api/search", "/api/events", "/api/config", "/api/groups/g1/messages", "/api/bots/b1", "/api/mcp-grants"]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) expect(mcpGrantAdmits(send, method, path, owner), `${method} ${path}`).toBe(false);
    }
  });
});
