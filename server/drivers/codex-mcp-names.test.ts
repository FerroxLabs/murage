// Reading the owner's own Codex config well enough to stay out of its way.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  codexConfigMcpServerNames,
  mcpServerNamesInToml,
  mountedMcpServerNames,
  TomlScanError,
  type DeclaredMcpServers,
} from "./codex-mcp-names.ts";

const declared = (...names: string[]): DeclaredMcpServers => ({ kind: "names", names: new Set(names) });

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "murage-codex-mcp-names-"));
  dirs.push(dir);
  return dir;
};

/** A HOME whose .codex/config.toml holds `toml`. */
const writeConfig = (toml: string): string => {
  const home = scratch();
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), toml);
  return home;
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

  it("collects the spellings that are not table headers at all", () => {
    // every one of these defines mcp_servers.fibery, and `-c` merges into it
    const spellings = [
      // dotted assignment at the root
      'mcp_servers.fibery.url = "https://x.test/mcp"\n',
      'mcp_servers.fibery = { url = "https://x.test/mcp" }\n',
      // quoted root key, and a quoted one with the dot inside the header
      '["mcp_servers".fibery]\nurl = "https://x.test/mcp"\n',
      "[ 'mcp_servers' . fibery ]\nurl = \"https://x.test/mcp\"\n",
      '"mcp_servers".fibery.url = "https://x.test/mcp"\n',
      // one inline table for the whole lot
      'mcp_servers = { fibery = { url = "https://x.test/mcp" } }\n',
      'mcp_servers = { "fibery" = { command = "uv" }, other = { command = "npx" } }\n',
      // keys under a plain [mcp_servers] header
      '[mcp_servers]\nfibery = { url = "https://x.test/mcp" }\n',
      '[mcp_servers]\nfibery.url = "https://x.test/mcp"\n',
      '[mcp_servers]\n"fibery".command = "uv"\n',
      // array-of-tables spelling
      '[[mcp_servers.fibery]]\nurl = "https://x.test/mcp"\n',
    ];
    for (const toml of spellings) {
      expect(mcpServerNamesInToml(toml), toml).toContain("fibery");
    }
  });

  it("still leaves comments, strings and unrelated tables alone", () => {
    const toml = `
model = "gpt-5"
# mcp_servers.commented.url = "https://nope.test"
instructions = """
mcp_servers.in_a_multiline_string.url = "https://nope.test"
[mcp_servers.also_in_here]
"""
literal = 'mcp_servers.in_a_literal.url = "https://nope.test"'
notify = ["notify-send", "codex # not a comment"]
[projects."/srv/mcp_servers.decoy"]
trust_level = "trusted"
[profiles.work]
model = "gpt-5"
[mcp_servers.real]
url = "https://real.test/mcp"
`;
    expect([...mcpServerNamesInToml(toml)]).toEqual(["real"]);
  });

  it("throws rather than reporting no servers when it cannot parse the file", () => {
    // if this returned an empty set, an unparsable config would read exactly
    // like a config with no MCP servers in it, and every colliding name would
    // keep its own mount name
    expect(() => mcpServerNamesInToml('[mcp_servers.fibery\nurl = "https://x.test"\n')).toThrow(TomlScanError);
    expect(() => mcpServerNamesInToml('model = "unterminated\n')).toThrow(TomlScanError);
    expect(() => mcpServerNamesInToml("mcp_servers = { fibery = { url = \"x\" }\n")).toThrow(TomlScanError);
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

    expect(codexConfigMcpServerNames({ HOME: home })).toEqual({ kind: "names", names: new Set(["home_one"]) });
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: explicit }))
      .toEqual({ kind: "names", names: new Set(["explicit_one"]) });
  });

  it("parses a full, ordinary Codex config without giving up on it", () => {
    // the cost of the walk being stricter than the old regex is that a config
    // it cannot parse is treated as unreadable and moves every server aside.
    // So an ordinary file has to go all the way through.
    const toml = `
model = "gpt-5"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
disable_response_storage = false
notify = ["notify-send", "Codex"]
hide_agent_reasoning = true

[sandbox_workspace_write]
network_access = false
writable_roots = [
  "/tmp",   # scratch
  "/var/folders",
]

[shell_environment_policy]
inherit = "core"
include_only = ["PATH", "HOME", "LANG"]
set = { CI = "1" }

[history]
persistence = "save-all"
max_bytes = 10_000_000

[tui]
notifications = true

[profiles.speedy]
model = "gpt-5-codex"
model_reasoning_effort = "low"

[projects."/Users/someone/src/thing"]
trust_level = "trusted"

[mcp_servers.fibery]
url = "https://mcp-eu-svc.fibery.io/mcp"
startup_timeout_sec = 30
bearer_token_env_var = "FIBERY_TOKEN"

[mcp_servers.local_notes]
command = "npx"
args = ["-y", "@example/notes-mcp", "--root", "~/notes"]
[mcp_servers.local_notes.env]
NOTES_TOKEN = "redacted"

[[experimental.instructions]]
text = """
a multi-line instruction with a stray bracket [mcp_servers.not_real]
and a quote " inside it
"""
`;
    const found = codexConfigMcpServerNames({ HOME: writeConfig(toml) });
    expect(found).toEqual({ kind: "names", names: new Set(["fibery", "local_notes"]) });
  });

  it("calls an absent config no servers, and an unreadable one unreadable", () => {
    const home = scratch();
    // nothing there: a file that does not exist declares nothing, and that is
    // an answer, not a gap
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "missing") }))
      .toEqual({ kind: "names", names: new Set() });

    // a directory where the file should be: readFileSync throws EISDIR. The
    // file IS there in some form and Murage cannot see inside it, so it must
    // not answer "no servers" — that answer lets every colliding name keep
    // its own mount and merge into whatever the owner wrote.
    mkdirSync(join(home, "as-dir"));
    mkdirSync(join(home, "as-dir", "config.toml"));
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: join(home, "as-dir") }).kind)
      .toBe("unreadable");

    // TOML this module cannot parse is the same kind of not-knowing
    const broken = join(home, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "config.toml"), '[mcp_servers.fibery\nurl = "https://x.test"\n');
    expect(codexConfigMcpServerNames({ HOME: home, CODEX_HOME: broken }))
      .toEqual({ kind: "unreadable", why: "unparsable" });
  });
});

describe("mountedMcpServerNames", () => {
  it("keeps a free name and moves a taken one aside, deterministically", () => {
    expect([...mountedMcpServerNames(["notes"], declared())]).toEqual([["notes", "notes"]]);
    expect(mountedMcpServerNames(["fibery"], declared("fibery")).get("fibery")).toBe("fibery_murage");
    expect(mountedMcpServerNames(["fibery"], declared("fibery", "fibery_murage")).get("fibery"))
      .toBe("fibery_murage2");
    // same inputs, same answer — codex keeps per-server state under this name
    expect(mountedMcpServerNames(["fibery"], declared("fibery")).get("fibery")).toBe("fibery_murage");
  });

  it("never mounts two of the bot's own servers under one name", () => {
    // the owner declares `fibery`; the bot happens to have BOTH `fibery` and a
    // server literally called `fibery_murage`. Allocating the alias against the
    // owner's file alone lands them both on `mcp_servers.fibery_murage`.
    const both = mountedMcpServerNames(["fibery", "fibery_murage"], declared("fibery"));
    expect(both.get("fibery_murage")).toBe("fibery_murage");
    expect(both.get("fibery")).not.toBe("fibery_murage");
    expect(new Set(both.values()).size).toBe(both.size);

    // the same in the other declaration order, and with the alias ladder
    // already partly occupied by the bot itself
    const laddered = mountedMcpServerNames(
      ["fibery_murage2", "fibery_murage", "fibery"],
      declared("fibery"),
    );
    expect(new Set(laddered.values()).size).toBe(3);
    expect(laddered.get("fibery")).toBe("fibery_murage3");
    expect(laddered.get("fibery_murage")).toBe("fibery_murage");
    expect(laddered.get("fibery_murage2")).toBe("fibery_murage2");

    // two colliding servers cannot be given the same alias either
    const twoCollisions = mountedMcpServerNames(["a", "a_murage"], declared("a", "a_murage"));
    expect(new Set(twoCollisions.values()).size).toBe(2);
    expect(twoCollisions.get("a")).toBe("a_murage2");
    expect(twoCollisions.get("a_murage")).toBe("a_murage_murage");
  });

  it("moves every server aside when the owner's config could not be read", () => {
    // not knowing which names are taken is not the same as knowing none are:
    // keeping the names would merge each `-c` override into whatever is in the
    // file Murage just failed to read, and inherit its approval mode
    const blind = mountedMcpServerNames(
      ["fibery", "notes"],
      { kind: "unreadable", why: "EACCES" },
    );
    expect([...blind]).toEqual([["fibery", "fibery_murage"], ["notes", "notes_murage"]]);
    expect(new Set(blind.values()).size).toBe(2);

    // and the aliases still dodge the bot's own names
    const blindWithSibling = mountedMcpServerNames(
      ["fibery", "fibery_murage"],
      { kind: "unreadable", why: "EACCES" },
    );
    expect(new Set(blindWithSibling.values()).size).toBe(2);
  });
});
