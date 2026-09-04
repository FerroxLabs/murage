import { describe, expect, it } from "vitest";

import {
  listMcpServers,
  mcpServerNameError,
  parseMcpServerMutation,
  parseStoredMcpServer,
} from "./mcp-registry.ts";

describe("custom MCP registry", () => {
  it("parses stdio servers and keeps newly added commands disabled", () => {
    expect(parseMcpServerMutation("notes", { command: "npx", args: ["-y", "notes-mcp"] })).toEqual({
      ok: true,
      server: { command: "npx", args: ["-y", "notes-mcp"], env: {}, enabled: false },
    });
    // A hand-authored file entry has always mounted unless it opted out.
    expect(parseStoredMcpServer("notes", { command: "npx" })).toEqual({
      ok: true,
      server: { command: "npx", args: [], env: {}, enabled: true },
    });
  });

  it("refuses unsafe names and every name Murage mounts itself", () => {
    expect(mcpServerNameError("Bad.Name")).toMatch(/lowercase/);
    expect(mcpServerNameError("safe-notes")).toBeNull();
    for (const reserved of [
      "muragebox",
      "computer",
      "agents",
      "composio",
      "browser",
      "phone",
      "dweb",
      "murage_connectors",
      "murage_phone",
    ]) {
      expect([reserved, mcpServerNameError(reserved)])
        .toEqual([reserved, "That name is reserved by Murage."]);
    }
  });

  it("never puts environment values in renderer listings", () => {
    const listings = listMcpServers({
      github: { command: "github-mcp", env: { GITHUB_TOKEN: "ghp_real", MODE: "read-only" } },
    });
    expect(listings).toEqual([{
      name: "github",
      command: "github-mcp",
      args: [],
      envKeys: ["GITHUB_TOKEN", "MODE"],
      enabled: true,
    }]);
    expect(JSON.stringify(listings)).not.toContain("ghp_real");
    expect(JSON.stringify(listings)).not.toContain("read-only");
  });

  it("preserves write-only values only when a matching value is stored", () => {
    const existing = { command: "old", args: [], env: { TOKEN: "secret", DROP: "gone" }, enabled: true };
    expect(parseMcpServerMutation("notes", {
      command: "new",
      env: { TOKEN: true, NEXT: "fresh" },
      enabled: true,
    }, existing)).toEqual({
      ok: true,
      server: { command: "new", args: [], env: { TOKEN: "secret", NEXT: "fresh" }, enabled: true },
    });
    expect(parseMcpServerMutation("notes", { command: "new", env: { MISSING: true } }, existing)).toEqual({
      ok: false,
      error: "No saved value exists for MISSING.",
    });
  });

  it("drops an unparseable entry from a listing rather than the whole list", () => {
    expect(listMcpServers({
      "Bad Name": { command: "npx" },
      computer: { command: "npx" },
      broken: { command: "" },
      good: { command: "npx", args: ["-y", "ok"] },
    }).map((entry) => entry.name)).toEqual(["good"]);
  });
});
