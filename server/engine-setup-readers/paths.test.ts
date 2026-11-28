// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { join, relative } from "node:path";
import { GUIDE, MARKER, readerFixture } from "./fixture.ts";

describe.skipIf(process.platform === "win32")("source allow-list", () => {
  const f = readerFixture();
  it("K5b opens only supported config files and personal skill trees", async () => {
    const allowed = [
      f.put("home/.claude.json", JSON.stringify({ mcpServers: { tool: { command: "sample" } }, hooks: MARKER })),
      f.put("home/.codex/config.toml", '[mcp_servers.tool]\ncommand = "sample"'),
      f.put("home/.grok/config.toml", '[mcp_servers.tool]\ncommand = "sample"'),
      ...[".claude", ".codex", ".grok", ".agents"].map(root => f.put(`home/${root}/skills/guide/SKILL.md`, GUIDE)),
    ];
    const permitted = new Set([f.home]);
    for (const file of allowed) {
      const parts = relative(f.home, file).split(/[\\/]/);
      for (let i = 1; i <= parts.length; i++) permitted.add(join(f.home, ...parts.slice(0, i)));
    }
    for (const root of ["", ".claude/", ".codex/", ".grok/", ".agents/"]) {
      for (const file of ["auth.json", ".credentials.json", "history.json", "hooks.json", "rules.json", "AGENTS.md", "CLAUDE.md"]) {
        f.put(`home/${root}${file}`, MARKER);
      }
      if (root) for (const file of ["auth.json", "AGENTS.md", "CLAUDE.md"]) f.put(`home/${root}skills/blocked/${file}`, MARKER);
    }
    for (const root of [".claude", ".codex", ".grok", ".agents"]) permitted.add(join(f.home, root, "skills", "blocked"));
    const results = await Promise.all((["fuigo", "claude", "codex", "grok"] as const).map(engine => f.read(engine)));
    expect(new Set(f.bytes)).toEqual(new Set(allowed));
    expect(f.opened.filter(path => !permitted.has(path))).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(MARKER);
  });

  it("opens MCP and skills independently and ignores inactive or unqualified sources", async () => {
    const cfg = f.put("home/.claude.json", JSON.stringify({ mcpServers: { tool: { command: "sample" } } }));
    const guide = f.put("home/.claude/skills/guide/SKILL.md", GUIDE);
    const realpathSync = vi.fn(f.fs.realpathSync);
    expect(await f.read("claude", { optedIn: undefined }, { ...f.fs, realpathSync })).toMatchObject({ status: "off" });
    expect(await f.read("claude", { engineHome: join(f.home, "alternate") }, { ...f.fs, realpathSync })).toMatchObject({ status: "unavailable" });
    expect(realpathSync).not.toHaveBeenCalled();
    expect(f.opened).toEqual([]);
    await f.read("claude", { scope: "mcp" });
    expect(f.bytes).toEqual([cfg]);
    expect(f.opened).not.toContain(join(f.home, ".claude"));
    f.opened.length = f.bytes.length = 0;
    await f.read("claude", { scope: "skills" });
    expect(f.bytes).toEqual([guide]);
    expect(f.opened).not.toContain(cfg);
  });
});
