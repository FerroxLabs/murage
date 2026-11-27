// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { GUIDE, MARKER, readerFixture } from "./fixture.ts";

describe.skipIf(process.platform === "win32")("Codex source", () => {
  const f = readerFixture();
  it("K1 plans two stdio servers and a link without copying raw values", async () => {
    f.put("home/.codex/config.toml", `model = "${MARKER}"
[profiles.sample]
model = "${MARKER}"
[history]
value = "${MARKER}"
[mcp_servers.first]
command = "sample"
args = [
  "hello, world", # comment
  'path with spaces',
]
[mcp_servers.first.env]
PATH = "/fixture/bin"
API_KEY = "${MARKER}"
[mcp_servers.second]
command = 'another'
[mcp_servers.link]
url = "https://example.test/mcp"
bearer_token_env_var = "FIXTURE_EXTERNAL_VALUE"
`);
    vi.stubEnv("FIXTURE_EXTERNAL_VALUE", MARKER);
    try {
      const result = await f.read("codex", { scope: "mcp" });
      expect(result.status).toBe("ready");
      expect(result.servers).toHaveLength(3);
      expect(result.servers.find(server => server.name === "first")).toMatchObject({
        needsKey: true, entry: { enabled: false, args: ["hello, world", "path with spaces"], env: { PATH: "/fixture/bin" }, pendingEnv: ["API_KEY"] },
      });
      expect(result.servers.find(server => server.name === "link")).toMatchObject({
        bearerEnv: "FIXTURE_EXTERNAL_VALUE", needsKey: true, entry: { enabled: false, pendingHeaders: ["Authorization"] },
      });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    } finally { vi.unstubAllEnvs(); }
  });

  it("K2 reads only the configured in-home instance", async () => {
    f.put("home/.codex/config.toml", '[mcp_servers.default]\ncommand = "sample"');
    const config = f.put("home/accounts/codex/config.toml", 'mcp_servers.alternate = { command = "sample" }');
    f.put("home/accounts/codex/skills/guide/SKILL.md", GUIDE);
    f.put("home/.codex/skills/decoy/SKILL.md", GUIDE);
    f.put("home/accounts/codex/skills/.system/bundled/SKILL.md", GUIDE);
    const result = await f.read("codex", { engineHome: join(f.home, "accounts", "codex") });
    expect(result.servers.map(server => server.name)).toEqual(["alternate"]);
    expect(result.skills.map(skill => skill.name)).toEqual(["guide"]);
    expect(f.bytes).toContain(config);
    expect(f.opened.some(path => path.includes("/.codex") || path.includes("/.system"))).toBe(false);
  });

  it.each(["outside", "relative"])("K2 refuses the %s override before any opens", async variant => {
    f.put("outside/config.toml", '[mcp_servers.foreign]\ncommand = "sample"');
    const engineHome = variant === "relative" ? "outside" : join(f.root, "outside");
    expect(await f.read("codex", { engineHome })).toMatchObject({ status: "outside-home", servers: [], skills: [] });
    expect(f.opened).toEqual([]);
  });
});
