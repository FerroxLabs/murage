import { describe, expect, it } from "vitest";

import {
  isHarnessOwnedMcpEnvName,
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

  it.each([
    "MURAGE_COMMS_TOKEN", "murage_harness_url", "MuRaGe_FUTURE_CAPABILITY",
    "MURAGEBOX_TOKEN", "muragebox_url", "MuRaGeBoX_FUTURE_CAPABILITY",
    "ELECTRON_RUN_AS_NODE", "electron_run_as_node",
    "DWEB_URL", "dweb_url", "PH_ANDROID_SERIAL", "ph_android_serial",
  ])("rejects reserved environment name %s in stored entries and mutations, including retained values", (key) => {
    const existing = { command: "notes", args: [], env: { [key]: "saved-private-value" }, enabled: true };
    const expected = { ok: false, error: `Environment variable “${key}” is reserved by Murage.` };
    expect(isHarnessOwnedMcpEnvName(key)).toBe(true);
    expect(parseStoredMcpServer("notes", existing)).toEqual(expected);
    expect(parseMcpServerMutation("notes", { command: "notes", env: { [key]: "new-private-value" } })).toEqual(expected);
    expect(parseMcpServerMutation("notes", { command: "notes", env: { [key]: true } }, existing)).toEqual(expected);
    expect(existing.env[key]).toBe("saved-private-value");
  });

  it("keeps ordinary environment names valid and omits reserved entries from listings", () => {
    expect(isHarnessOwnedMcpEnvName("NOTES_TOKEN")).toBe(false);
    const raw = {
      blocked: { command: "notes", env: { MURAGE_COMMS_TOKEN: "private-value" } },
      notes: { command: "notes", env: { NOTES_TOKEN: "notes-private-value" } },
    };
    const before = JSON.stringify(raw);
    expect(listMcpServers(raw)).toEqual([
      { name: "notes", command: "notes", args: [], envKeys: ["NOTES_TOKEN"], enabled: true },
    ]);
    expect(parseStoredMcpServer("notes", raw.notes)).toMatchObject({ ok: true, server: { env: raw.notes.env } });
    expect(JSON.stringify(raw)).toBe(before);
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
