// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MARKER, readerFixture } from "./fixture.ts";

describe.skipIf(process.platform === "win32")("TOML source", () => {
  const f = readerFixture();
  const valid = '[mcp_servers.valid]\ncommand = "sample"\n';
  it.each([
    ["truncated header", "[mcp_servers.broken", "unreadable"],
    ["duplicate table", '[mcp_servers.valid]\nargs = []', "unreadable"],
    ["duplicate value", '[mcp_servers.broken]\ncommand = "first"\ncommand = "second"', "unreadable"],
    ["unterminated string", `[mcp_servers.broken]\ncommand = "${MARKER}`, "unreadable"],
    ["oversized config", "#".repeat(3 * 1024 * 1024), "too-much"],
  ])("K3m refuses %s without retaining earlier servers or quoting input", async (_label, broken, status) => {
    f.put("home/.codex/config.toml", valid + broken);
    f.put("home/.grok/config.toml", valid);
    const codex = await f.read("codex", { scope: "mcp" });
    expect(codex).toMatchObject({ status, servers: [], skills: [] });
    expect(JSON.stringify(codex)).not.toContain(MARKER);
    expect((await f.read("grok", { scope: "mcp" })).servers.map(server => server.name)).toEqual(["valid"]);
  });

  it("refuses entries whose execution fields cannot be represented", async () => {
    f.put("home/.codex/config.toml", valid + `
[mcp_servers.limited]
command = "sample"
enabled_tools = ["read"]
[mcp_servers.inherited]
command = "sample"
env_vars = ["API_KEY"]
[mcp_servers.special]
command = "sample"
[mcp_servers.special.unknown]
`);
    const result = await f.read("codex", { scope: "mcp" });
    expect(result.servers.map(server => server.name)).toEqual(["valid"]);
    expect(result.skipped.map(entry => entry.name)).toEqual(["inherited", "limited", "special"]);
  });
});
