// Reading the owner's own Codex config well enough to stay out of its way.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { codexConfigMcpServerNames, mcpServerNamesInToml, mountedMcpServerNames } from "./codex-mcp-names.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "murage-codex-mcp-names-"));
  dirs.push(dir);
  return dir;
};

describe("mcpServerNamesInToml", () => {
  it("collects bare, quoted and sub-table headers and nothing else", () => {
    const toml = `
model = "gpt-5"
[mcp_servers.fibery]
url = "https://mcp-eu-svc.fibery.io/mcp"
  [ mcp_servers.google_ads-http ]
url = "https://example.test/mcp"
[mcp_servers."with space"]
command = "npx"
[mcp_servers.'single']
command = "npx"
[mcp_servers.nested.env]
TOKEN = "x"
[projects."/srv/mcp_servers.decoy"]
trust_level = "trusted"
# [mcp_servers.commented]
`;
    expect([...mcpServerNamesInToml(toml)].sort())
      .toEqual(["fibery", "google_ads-http", "nested", "single", "with space"]);
  });

  it("returns nothing for a config that declares no servers", () => {
    expect(mcpServerNamesInToml('model = "gpt-5"\n').size).toBe(0);
    expect(mcpServerNamesInToml("").size).toBe(0);
  });
});

describe("codexConfigMcpServerNames", () => {
  it("reads the Codex home this child will use, honouring CODEX_HOME over HOME", () => {
    const home = scratch();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.home_one]\nurl = "https://a.test"\n');
    const explicit = join(home, "elsewhere");
    mkdirSync(explicit);
    writeFileSync(join(explicit, "config.toml"), '[mcp_servers.explicit_one]\nurl = "https://b.test"\n');

    expect([...codexConfigMcpServerNames({ HOME: home })]).toEqual(["home_one"]);
    expect([...codexConfigMcpServerNames({ HOME: home, CODEX_HOME: explicit })]).toEqual(["explicit_one"]);
  });

  it("treats a missing or unreadable config as no servers, never as a failure", () => {
    const home = scratch();
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "missing") }).size).toBe(0);
    // a directory where the file should be: readFileSync throws EISDIR
    mkdirSync(join(home, "as-dir"));
    mkdirSync(join(home, "as-dir", "config.toml"));
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "as-dir") }).size).toBe(0);
  });
});

describe("mountedMcpServerNames", () => {
  it("keeps a free name and moves a taken one aside, deterministically", () => {
    expect([...mountedMcpServerNames(["notes"], new Set())]).toEqual([["notes", "notes"]]);
    expect(mountedMcpServerNames(["fibery"], new Set(["fibery"])).get("fibery")).toBe("fibery_murage");
    expect(mountedMcpServerNames(["fibery"], new Set(["fibery", "fibery_murage"])).get("fibery"))
      .toBe("fibery_murage2");
    // same inputs, same answer — codex keeps per-server state under this name
    expect(mountedMcpServerNames(["fibery"], new Set(["fibery"])).get("fibery")).toBe("fibery_murage");
  });

  it("never mounts two of the bot's own servers under one name", () => {
    // the owner declares `fibery`; the bot happens to have BOTH `fibery` and a
    // server literally called `fibery_murage`. Allocating the alias against the
    // owner's file alone lands them both on `mcp_servers.fibery_murage`.
    const both = mountedMcpServerNames(["fibery", "fibery_murage"], new Set(["fibery"]));
    expect(both.get("fibery_murage")).toBe("fibery_murage");
    expect(both.get("fibery")).not.toBe("fibery_murage");
    expect(new Set(both.values()).size).toBe(both.size);

    // the same in the other declaration order, and with the alias ladder
    // already partly occupied by the bot itself
    const laddered = mountedMcpServerNames(
      ["fibery_murage2", "fibery_murage", "fibery"],
      new Set(["fibery"]),
    );
    expect(new Set(laddered.values()).size).toBe(3);
    expect(laddered.get("fibery")).toBe("fibery_murage3");
    expect(laddered.get("fibery_murage")).toBe("fibery_murage");
    expect(laddered.get("fibery_murage2")).toBe("fibery_murage2");

    // two colliding servers cannot be given the same alias either
    const twoCollisions = mountedMcpServerNames(["a", "a_murage"], new Set(["a", "a_murage"]));
    expect(new Set(twoCollisions.values()).size).toBe(2);
    expect(twoCollisions.get("a")).toBe("a_murage2");
    expect(twoCollisions.get("a_murage")).toBe("a_murage_murage");
  });
});
