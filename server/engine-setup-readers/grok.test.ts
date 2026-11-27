// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { GUIDE, MARKER, readerFixture } from "./fixture.ts";

describe.skipIf(process.platform === "win32")("Grok Build source", () => {
  const f = readerFixture();
  it.each([false, true])("K3 reads MCP and personal/shared skills (override %s)", async override => {
    const root = override ? "account" : ".grok";
    const config = f.put(`home/${root}/config.toml`, `[mcp_servers.tool]\ncommand = "sample"\n[hooks]\nvalue = "${MARKER}"\n[permission]\nvalue = "${MARKER}"`);
    f.put(`home/${root}/skills/guide/SKILL.md`, GUIDE);
    f.put("home/.agents/skills/shared-guide/SKILL.md", GUIDE);
    const grok = await f.read("grok", override ? { engineHome: join(f.home, root) } : {});
    expect(grok.servers.map(server => server.name)).toEqual(["tool"]);
    expect(grok.skills.map(({ name, root }) => ({ name, root }))).toEqual([
      { name: "guide", root: "personal" }, { name: "shared-guide", root: "shared" },
    ]);
    const codex = await f.read("codex", { scope: "skills" });
    expect(codex.skills).toEqual(grok.skills.filter(skill => skill.root === "shared"));
    expect(f.bytes).toContain(config);
    expect(JSON.stringify(grok)).not.toContain(MARKER);
    if (override) expect(f.opened.some(path => path.startsWith(join(f.home, ".grok")))).toBe(false);
  });

  it("K3 refuses an outside override before opening either account", async () => {
    f.put("outside/config.toml", '[mcp_servers.foreign]\ncommand = "sample"');
    expect(await f.read("grok", { engineHome: join(f.root, "outside") })).toMatchObject({ status: "outside-home", servers: [], skills: [] });
    expect(f.opened).toEqual([]);
  });
});
