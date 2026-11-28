// G43: a phone reads one bot's MCP servers, names and switches only.
import { describe, expect, it } from "vitest";

import { botMcpServers } from "./bot-mcp-servers.ts";
import type { AppConfig } from "./config.ts";
import { conversationSubject, routeClass } from "./route-policy.ts";

const cfg = (mcpServers: Record<string, unknown>) => ({ mcpServers }) as unknown as AppConfig;
const open = { engineMountsCustom: true, ownServersAllowed: true };
const servers = cfg({
  notes: { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "n0tes-value" }, enabled: true },
  waiting: { command: "npx", args: ["-y", "@acme/mcp"], env: {}, enabled: true, pendingEnv: ["ACME_KEY"] },
  netlify: { url: "https://netlify-mcp.netlify.app/mcp", enabled: true },
  keyed: { url: "https://x.example/mcp", auth: "header", headers: { "X-API-Key": "dev-string-value" }, enabled: true },
  resting: { command: "x", args: [], env: {}, enabled: false },
});

describe("GET /api/bots/:id/mcp-servers rows", () => {
  it("carries only name, enabled and on: no command, args, url, env or headers", () => {
    const { servers: rows } = botMcpServers(servers, open);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["enabled", "name", "on"]);
    const text = JSON.stringify(rows);
    for (const leak of ["npx", "@x/notes", "n0tes-value", "x.example", "X-API-Key", "dev-string-value", "ACME_KEY"]) expect(text).not.toContain(leak);
  });

  it("says on only for a server the turn would mount: a pending key or Netlify's own server is enabled but not on", () => {
    const byName = Object.fromEntries(botMcpServers(servers, open).servers.map((row) => [row.name, row]));
    expect(byName.notes).toEqual({ name: "notes", enabled: true, on: true });
    expect(byName.keyed).toEqual({ name: "keyed", enabled: true, on: true });
    expect(byName.waiting).toEqual({ name: "waiting", enabled: true, on: false });
    expect(byName.netlify).toEqual({ name: "netlify", enabled: true, on: false });
    expect(byName.resting).toEqual({ name: "resting", enabled: false, on: false });
  });

  it("an engine that cannot mount custom servers, or a restricted or hidden bot, has every server off", () => {
    for (const gates of [{ engineMountsCustom: false, ownServersAllowed: true }, { engineMountsCustom: true, ownServersAllowed: false }]) {
      expect(botMcpServers(servers, gates).servers.every((row) => row.on === false)).toBe(true);
    }
  });

  it("masks a server name that looks like a key", () => {
    const suffix = "a".repeat(24);
    const name = ["sk", "proj", suffix].join("-");
    const rows = botMcpServers(cfg({ [name]: { command: "x", args: [], env: {}, enabled: true } }), open).servers;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).not.toContain(suffix);
  });

  it("is a conversation route on the bot, so a hidden bot is 404 to a device", () => {
    expect(routeClass("GET", "/api/bots/b1/mcp-servers")).toBe("conversation");
    expect(conversationSubject("/api/bots/b1/mcp-servers")).toEqual({ scope: "bot", botId: "b1" });
    expect(routeClass("PUT", "/api/bots/b1/mcp-servers")).toBe("desktop");
  });
});
