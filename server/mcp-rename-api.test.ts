// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rename (APP-GRANT-FIXPLAN-r3 "Rename", Rules 54, 32, 43, 57b..c) against the real harness: a pure rename moves the
// stored sign-in from the old name to the new one, deletes every grant on `custom:<from>` from every bot record, and
// carries no grant to `custom:<to>`, which asks again. A later server under the old name starts with nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASE, MCP_COMMIT_TOKEN as COMMIT_TOKEN, DESKTOP_HEADERS, desktopApi } from "./testing/index-harness.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { acpToolKey } from "../shared/mount-identity.ts";
import { autoVerdict } from "./auto-approve.ts";

let fake: FakeRemoteMcp;
beforeAll(async () => { fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "rename-key-7", unauthorized: "api-key-only", prm: false }); });
afterAll(async () => { await fake?.close(); });

const commit = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
  method, headers: { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const statusOf = async (name: string) => ((await desktopApi("GET", "/api/mcp/servers")).body.servers as Array<{ name: string; status?: string }>).find((s) => s.name === name)?.status;
const grantsOf = async (botId: string): Promise<string[]> => {
  const bot = (await desktopApi("GET", `/api/bots/${botId}`)).body.bot as { alwaysAllow?: string[]; tasks?: Array<{ alwaysAllow?: string[] }> };
  return [...(bot.alwaysAllow ?? []), ...(bot.tasks ?? []).flatMap((task) => task.alwaysAllow ?? [])];
};
/** A call on `<server>__lookup` the way an ACP driver files it, with that server mounted as the owner's custom server. */
const callOn = (server: string) => ({
  tool: "other", summary: "lookup", toolKind: "other" as const,
  toolIdentity: { namespace: "mcp", name: `${server}__lookup` },
  toolCall: { name: "lookup", input: {} },
  mcpMounts: [{ engineName: server, mountId: `custom:${server}`, provenance: "custom" as const }],
});
const cards = (alwaysAllow: string[], server: string) => {
  const call = callOn(server);
  return autoVerdict({ alwaysAllow }, call.tool, call.summary, { call }).source !== "always-allow";
};

async function addLinkServer(name: string): Promise<void> {
  const created = await desktopApi("POST", "/api/mcp/servers", { name, url: fake.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await desktopApi("PATCH", `/api/mcp/servers/${name}`, { enabled: true })).status).toBe(200);
}

describe("renaming a server (r3 Rename)", () => {
  it("moves the sign-in to the new name, deletes the old mount's grants, and the new name and a re-added old name ask again", async () => {
    await addLinkServer("rnold");
    expect((await commit("PUT", "/api/mcp/servers/rnold/secrets", { origin: fake.origin, headers: { "x-api-key": "rename-key-7" } })).status).toBe(200);
    expect(await statusOf("rnold")).toBe("ready");
    const bot = (await desktopApi("POST", "/api/bots", { name: "Rename fixture" })).body.bot as { id: string };
    const oldKey = acpToolKey("custom:rnold", "lookup");
    const otherKey = acpToolKey("custom:rnother", "lookup");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: [oldKey, otherKey, "Bash:ls"] })).status).toBe(200);
    expect(await grantsOf(bot.id)).toContain(oldKey);
    expect(cards(await grantsOf(bot.id), "rnold")).toBe(false);
    try {
      const renamed = await desktopApi("PATCH", "/api/mcp/servers/rnold", { name: "rnnew" });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      // the sign-in works under the new name, and nothing is left under the old one
      expect(await statusOf("rnnew")).toBe("ready");
      expect(await statusOf("rnold")).toBeUndefined();
      // every grant on custom:rnold is gone from every record of the bot; the other grants stay
      const after = await grantsOf(bot.id);
      expect(after).not.toContain(oldKey);
      expect(after.some((key) => key.includes("rnold"))).toBe(false);
      expect(after).toContain(otherKey);
      expect(after).toContain("Bash:ls");
      // the first call on the new name cards
      expect(cards(after, "rnnew")).toBe(true);
      // a server added again under the old name has no sign-in and no grant: it cards too
      await addLinkServer("rnold");
      expect(await statusOf("rnold")).toBe("needs-key");
      expect(cards(await grantsOf(bot.id), "rnold")).toBe(true);
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/rnold");
      await desktopApi("DELETE", "/api/mcp/servers/rnnew");
    }
  });
});

describe("deleting a server (09-A4)", () => {
  it("deletes every grant on custom:<name> with the server, so a new server under that name asks again", async () => {
    await addLinkServer("dgone");
    const bot = (await desktopApi("POST", "/api/bots", { name: "Delete fixture" })).body.bot as { id: string };
    const key = acpToolKey("custom:dgone", "lookup");
    const otherKey = acpToolKey("custom:dkeep", "lookup");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: [key, otherKey, "Bash:ls"] })).status).toBe(200);
    expect(cards(await grantsOf(bot.id), "dgone")).toBe(false);
    expect((await desktopApi("DELETE", "/api/mcp/servers/dgone")).status).toBe(200);
    try {
      const after = await grantsOf(bot.id);
      expect(after).not.toContain(key);
      expect(after).toContain(otherKey);
      expect(after).toContain("Bash:ls");
      await addLinkServer("dgone");
      expect(cards(await grantsOf(bot.id), "dgone")).toBe(true);
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/dgone");
    }
  });
});

describe("editing a command server (09-A4)", () => {
  it("drops its grants when the command or arguments change, and keeps them for a save that changes nothing", async () => {
    const name = "pgrant";
    expect((await desktopApi("POST", "/api/mcp/servers", { name, command: "npx", args: ["-y", "@x/a"], env: {} })).status).toBe(201);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Edit fixture" })).body.bot as { id: string };
    const key = acpToolKey(`custom:${name}`, "lookup");
    const otherKey = acpToolKey("custom:pkeep", "lookup");
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: [key, otherKey] })).status).toBe(200);
      // a save that changes nothing keeps the grants
      expect((await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "npx", args: ["-y", "@x/a"], env: {} })).status).toBe(200);
      expect(await grantsOf(bot.id)).toContain(key);
      // a different program under the same name: the earlier answers do not carry over
      const edited = await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "npx", args: ["-y", "@x/evil"], env: {} });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const after = await grantsOf(bot.id);
      expect(after).not.toContain(key);
      expect(after).toContain(otherKey);
      expect(cards(after, name)).toBe(true);
    } finally {
      await desktopApi("DELETE", `/api/mcp/servers/${name}`);
    }
  });
});
