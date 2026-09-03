// The safety envelope, exercised against the one engine that needs it.
//
// Every test here operates on a fresh temp HOME. Nothing in this file may ever
// see the developer's real ~/.config/opencode/opencode.json — the whole point
// of the module under test is that a user's CLI config is their property, and
// a test rig that reads or writes the real one has already violated the thing
// it is checking. `MURAGE_DATA_DIR` redirects the receipts and snapshots the
// same way, so a run leaves nothing behind outside its tmpdir.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectorReceipt, resolveConfigTarget } from "./flux-connector.ts";
import {
  connectOpenCodeFlux,
  disconnectOpenCodeFlux,
  OPENCODE_CONNECTOR_TOOL,
  opencodeConnectorPaths,
  openCodeFluxStatus,
} from "./opencode-config.ts";

const KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_2 = "sk-flux-Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const rigs: string[] = [];

interface Rig {
  root: string;
  home: string;
  configDir: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "murage-flux-connector-"));
  rigs.push(root);
  const home = join(root, "home");
  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  return {
    root,
    home,
    configDir,
    configPath: join(configDir, "opencode.json"),
    // No HOME fallback to the real one: `opencodeConfigDir` reads env.HOME
    // first, and MURAGE_DATA_DIR keeps receipts/snapshots inside the rig.
    env: { HOME: home, MURAGE_DATA_DIR: join(root, "state") },
  };
}

afterEach(() => {
  while (rigs.length) rmSync(rigs.pop()!, { recursive: true, force: true });
});

/** A believable user config: four-space indent (not the two we would emit),
 *  `theme` before `provider` (not the order we would append in), and a
 *  provider of the user's own that must survive everything we do. */
const USER_CONFIG = `${JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    theme: "tokyonight",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
        models: { llama3: { name: "llama3 (Ollama)" } },
      },
    },
  },
  null,
  4,
)}\n`;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function fluxProvider(path: string): Record<string, any> | undefined {
  return (JSON.parse(read(path)) as any).provider?.flux;
}

describe("connect → disconnect leaves the user's config byte-identical", () => {
  it("round-trips a config that already had providers, formatting and key order", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);

    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(true);
    expect(installed.changed).toBe(true);
    expect(read(r.configPath)).not.toBe(USER_CONFIG);
    expect(fluxProvider(r.configPath)?.options.baseURL).toBe("https://api.fluxrouter.ai/v1");

    const removed = await disconnectOpenCodeFlux({ env: r.env });
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(read(r.configPath)).toBe(USER_CONFIG);
  });

  it("round-trips a config that had no provider section at all", async () => {
    const r = rig();
    // No `provider` key. A naive strip that leaves `"provider": {}` behind
    // fails this and only this.
    const original = '{\n  "theme": "tokyonight"\n}\n';
    writeFileSync(r.configPath, original);

    await connectOpenCodeFlux({ key: KEY, env: r.env });
    await disconnectOpenCodeFlux({ env: r.env });
    expect(read(r.configPath)).toBe(original);
  });

  it("round-trips a minified config without reformatting it", async () => {
    const r = rig();
    const original = '{"theme":"tokyonight"}';
    writeFileSync(r.configPath, original);

    await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(read(r.configPath)).not.toContain("\n");
    await disconnectOpenCodeFlux({ env: r.env });
    expect(read(r.configPath)).toBe(original);
  });

  it("removes only our block, keeping edits the user made after the install", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });

    const edited = JSON.parse(read(r.configPath)) as any;
    edited.provider.lmstudio = { npm: "@ai-sdk/openai-compatible", name: "LM Studio", options: {}, models: {} };
    edited.autoupdate = false;
    writeFileSync(r.configPath, `${JSON.stringify(edited, null, 4)}\n`);

    const removed = await disconnectOpenCodeFlux({ env: r.env });
    expect(removed.ok).toBe(true);
    const after = JSON.parse(read(r.configPath)) as any;
    expect(after.provider.flux).toBeUndefined();
    expect(after.provider.ollama.options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(after.provider.lmstudio.name).toBe("LM Studio");
    expect(after.autoupdate).toBe(false);
    expect(after.theme).toBe("tokyonight");
  });
});

describe("the snapshot is taken once, of the ORIGINAL file", () => {
  it("does not re-snapshot on a later install, so the pristine copy survives", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);

    const first = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(first.backupPath).not.toBeNull();
    expect(read(first.backupPath!)).toBe(USER_CONFIG);

    // The user edits something unrelated; then we re-install (a key rotation).
    const edited = JSON.parse(read(r.configPath)) as any;
    edited.theme = "catppuccin";
    writeFileSync(r.configPath, `${JSON.stringify(edited, null, 4)}\n`);

    const second = await connectOpenCodeFlux({ key: KEY_2, env: r.env });
    expect(second.ok).toBe(true);
    expect(second.backupPath).toBe(first.backupPath);
    // The load-bearing assertion: still the file as it was before we ever
    // touched it, not the already-modified one.
    expect(read(second.backupPath!)).toBe(USER_CONFIG);
    expect(read(second.backupPath!)).not.toContain("catppuccin");
  });

  it("records no snapshot when there was no config file to snapshot", async () => {
    const r = rig();
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(true);
    expect(installed.backupPath).toBeNull();
    expect(installed.rollbackCommand).toBeNull();
    expect(existsSync(r.configPath)).toBe(true);
  });

  it("hands back a copy-pasteable manual restore naming the REAL path", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    const real = resolveConfigTarget(r.configPath, r.configDir);
    expect(installed.rollbackCommand).toBe(`cp ${JSON.stringify(installed.backupPath!)} ${JSON.stringify(real)}`);
  });

  it("KNOWN LIMITATION — a hand-compacted nested object is re-expanded", async () => {
    // Indent width, trailing newline and key order round-trip exactly; nesting
    // that the user hand-collapsed onto one line does not, because the write
    // goes through JSON.parse/stringify. Stating it as a test rather than
    // letting the byte-identity claim above quietly over-promise.
    const r = rig();
    const compacted = '{\n  "provider": {\n    "ollama": { "name": "Ollama" }\n  }\n}\n';
    writeFileSync(r.configPath, compacted);
    await connectOpenCodeFlux({ key: KEY, env: r.env });
    await disconnectOpenCodeFlux({ env: r.env });
    const after = read(r.configPath);
    expect(after).not.toBe(compacted);
    // …but nothing is LOST, which is the property that actually matters.
    expect(JSON.parse(after)).toEqual(JSON.parse(compacted));
  });
});

describe("a drifted config is not clobbered", () => {
  it("refuses to rewrite a Flux block the user edited, and changes nothing", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });

    const edited = JSON.parse(read(r.configPath)) as any;
    edited.provider.flux.options.baseURL = "https://my-own-proxy.example/v1";
    const drifted = `${JSON.stringify(edited, null, 4)}\n`;
    writeFileSync(r.configPath, drifted);
    expect(openCodeFluxStatus(r.env).state).toBe("drifted");

    const again = await connectOpenCodeFlux({ key: KEY_2, env: r.env });
    expect(again.ok).toBe(false);
    expect(again.state).toBe("drifted");
    expect(again.reason).toContain("refusing to overwrite");
    // The user's edit is still exactly there.
    expect(read(r.configPath)).toBe(drifted);
  });

  it("refuses a Flux block we have no receipt for at all", async () => {
    const r = rig();
    const foreign = JSON.parse(USER_CONFIG) as any;
    foreign.provider.flux = { options: { baseURL: "https://someone-elses.example/v1", apiKey: "sk-theirs" } };
    const text = `${JSON.stringify(foreign, null, 4)}\n`;
    writeFileSync(r.configPath, text);

    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(false);
    expect(installed.state).toBe("drifted");
    expect(installed.reason).toContain("no record of");
    expect(read(r.configPath)).toBe(text);
  });

  it("POSITIVE CONTROL — an UNdrifted re-install is allowed and does rewrite", async () => {
    // Same shape as the refusal tests, minus the edit to our block. If this
    // ever goes red the refusals above prove nothing: they would be passing
    // because nothing can install, not because drift is detected.
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(fluxProvider(r.configPath)?.options.apiKey).toBe(KEY);

    const again = await connectOpenCodeFlux({ key: KEY_2, env: r.env });
    expect(again.ok).toBe(true);
    expect(again.state).toBe("routed");
    expect(fluxProvider(r.configPath)?.options.apiKey).toBe(KEY_2);
  });

  it("does not read a key rotation as drift — the receipt excludes the apiKey", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    const first = await connectOpenCodeFlux({ key: KEY, env: r.env });
    const second = await connectOpenCodeFlux({ key: KEY_2, env: r.env });
    expect(second.ok).toBe(true);
    const paths = opencodeConnectorPaths(r.env);
    expect(connectorReceipt(paths.manifestPath, OPENCODE_CONNECTOR_TOOL)!.managedHash).toBe(
      // identical: the hash covers provider.flux.options.baseURL only
      JSON.parse(readFileSync(paths.manifestPath, "utf8")).tools.opencode.managedHash,
    );
    expect(first.ok).toBe(true);
    expect(fluxProvider(r.configPath)?.options.apiKey).toBe(KEY_2);
  });

  it("treats an edit AROUND our block as not-drift, and still re-installs", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });

    const edited = JSON.parse(read(r.configPath)) as any;
    edited.provider.ollama.options.baseURL = "http://127.0.0.1:9999/v1";
    writeFileSync(r.configPath, `${JSON.stringify(edited, null, 4)}\n`);
    expect(openCodeFluxStatus(r.env).state).toBe("routed");

    const again = await connectOpenCodeFlux({ key: KEY_2, env: r.env });
    expect(again.ok).toBe(true);
    // their edit survived the rewrite
    expect(JSON.parse(read(r.configPath)).provider.ollama.options.baseURL).toBe("http://127.0.0.1:9999/v1");
  });

  it("refuses to write into a config it cannot parse rather than replacing it", async () => {
    const r = rig();
    const broken = '{"provider": {,,,}';
    writeFileSync(r.configPath, broken);
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(false);
    expect(installed.reason).toContain("not valid JSON");
    expect(read(r.configPath)).toBe(broken);
  });

  it("refuses when a key we would touch is not an object", async () => {
    const r = rig();
    const hostile = '{\n  "provider": "definitely-not-an-object"\n}\n';
    writeFileSync(r.configPath, hostile);
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(false);
    expect(installed.reason).toContain('"provider" is not an object');
    expect(read(r.configPath)).toBe(hostile);
  });
});

describe("a failed post-write verification rolls back", () => {
  it("restores the user's file byte-for-byte when the route does not answer", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);

    let sawFluxOnDisk = false;
    const installed = await connectOpenCodeFlux({
      key: KEY,
      env: r.env,
      verify: async () => {
        // Proves the probe runs AFTER the write — a probe that ran before
        // would be verifying the old file and could never catch a bad write.
        sawFluxOnDisk = Boolean(fluxProvider(r.configPath));
        return false;
      },
    });

    expect(sawFluxOnDisk).toBe(true);
    expect(installed.ok).toBe(false);
    expect(installed.rolledBack).toBe(true);
    expect(read(r.configPath)).toBe(USER_CONFIG);
    expect(openCodeFluxStatus(r.env).state).toBe("unconfigured");
    expect(connectorReceipt(opencodeConnectorPaths(r.env).manifestPath, OPENCODE_CONNECTOR_TOOL)).toBeNull();
  });

  it("deletes the file it created when there was nothing there before", async () => {
    const r = rig();
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env, verify: async () => false });
    expect(installed.rolledBack).toBe(true);
    expect(existsSync(r.configPath)).toBe(false);
    expect(openCodeFluxStatus(r.env).state).toBe("absent");
  });

  it("rolls back on a probe that throws, not just one that answers false", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    const installed = await connectOpenCodeFlux({
      key: KEY,
      env: r.env,
      verify: async () => {
        throw new Error("ECONNREFUSED api.fluxrouter.ai");
      },
    });
    expect(installed.rolledBack).toBe(true);
    expect(read(r.configPath)).toBe(USER_CONFIG);
  });

  it("POSITIVE CONTROL — a probe that succeeds leaves the write in place", async () => {
    // Without this, every rollback test above would pass on an implementation
    // that simply never wrote anything.
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env, verify: async () => true });
    expect(installed.ok).toBe(true);
    expect(installed.rolledBack).toBe(false);
    expect(read(r.configPath)).not.toBe(USER_CONFIG);
    expect(openCodeFluxStatus(r.env).state).toBe("routed");
  });
});

describe("a symlinked config cannot be used to write outside its directory", () => {
  it("refuses a config symlinked out of the opencode dir, and touches neither end", async () => {
    const r = rig();
    const outsideDir = join(r.root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, "secret.json");
    const secretBefore = '{"totally":"unrelated"}\n';
    writeFileSync(secret, secretBefore);
    symlinkSync(secret, r.configPath);

    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(false);
    expect(installed.reason).toContain("escapes");
    expect(read(secret)).toBe(secretBefore);
    // the link itself is still a link — not replaced by a regular file
    expect(lstatSync(r.configPath).isSymbolicLink()).toBe(true);
    // and no snapshot of someone else's file was taken
    expect(installed.backupPath).toBeNull();
  });

  it("refuses to disconnect through an escaping symlink too", async () => {
    const r = rig();
    const outsideDir = join(r.root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, "secret.json");
    writeFileSync(secret, '{"provider":{"flux":{"options":{"baseURL":"x"}}}}\n');
    symlinkSync(secret, r.configPath);

    const removed = await disconnectOpenCodeFlux({ env: r.env });
    expect(removed.ok).toBe(false);
    expect(removed.reason).toContain("escapes");
    expect(read(secret)).toBe('{"provider":{"flux":{"options":{"baseURL":"x"}}}}\n');
  });

  it("refuses a dangling symlink rather than replacing the link with a file", async () => {
    const r = rig();
    symlinkSync(join(r.root, "outside", "gone.json"), r.configPath);
    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(false);
    expect(installed.reason).toContain("no valid target");
    expect(lstatSync(r.configPath).isSymbolicLink()).toBe(true);
  });

  it("POSITIVE CONTROL — a symlink that stays inside the dir is written through", async () => {
    // The refusals above must be about ESCAPING, not about symlinks in
    // general: a dotfile manager that links opencode.json to a sibling is a
    // normal setup and must keep working.
    const r = rig();
    const real = join(r.configDir, "opencode.real.json");
    writeFileSync(real, USER_CONFIG);
    symlinkSync(real, r.configPath);

    const installed = await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(installed.ok).toBe(true);
    expect(lstatSync(r.configPath).isSymbolicLink()).toBe(true);
    expect(fluxProvider(real)?.options.apiKey).toBe(KEY);

    await disconnectOpenCodeFlux({ env: r.env });
    expect(read(real)).toBe(USER_CONFIG);
  });

  it("resolveConfigTarget is the single choke point, and it fails closed", () => {
    const r = rig();
    expect(() => resolveConfigTarget(r.configPath, r.configDir)).not.toThrow();
    expect(() => resolveConfigTarget(join(r.configDir, "..", "elsewhere.json"), r.configDir)).toThrow(/escapes/);
  });
});

describe("the receipt is what tells our block from the user's", () => {
  it("classifies absent / unconfigured / routed / drifted", async () => {
    const r = rig();
    expect(openCodeFluxStatus(r.env).state).toBe("absent");

    writeFileSync(r.configPath, USER_CONFIG);
    expect(openCodeFluxStatus(r.env).state).toBe("unconfigured");

    await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(openCodeFluxStatus(r.env).state).toBe("routed");

    const edited = JSON.parse(read(r.configPath)) as any;
    edited.provider.flux.options.baseURL = "https://elsewhere.example/v1";
    writeFileSync(r.configPath, `${JSON.stringify(edited, null, 4)}\n`);
    expect(openCodeFluxStatus(r.env).state).toBe("drifted");
  });

  it("records the exact bytes written, so a later edit is detectable at all", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });
    const receipt = connectorReceipt(opencodeConnectorPaths(r.env).manifestPath, OPENCODE_CONNECTOR_TOOL)!;
    expect(receipt.fileHash).toHaveLength(64);
    expect(receipt.managedHash).toHaveLength(64);
    expect(receipt.managedHash).not.toBe(receipt.fileHash);
    expect(receipt.baseUrl).toBe("https://api.fluxrouter.ai/v1");
    expect(receipt.configPath).toBe(resolveConfigTarget(r.configPath, r.configDir));
  });

  it("snapshots a drifted file before disconnecting it, so the edit is not lost", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    await connectOpenCodeFlux({ key: KEY, env: r.env });

    const edited = JSON.parse(read(r.configPath)) as any;
    edited.provider.flux.options.baseURL = "https://my-own-proxy.example/v1";
    const drifted = `${JSON.stringify(edited, null, 4)}\n`;
    writeFileSync(r.configPath, drifted);

    const removed = await disconnectOpenCodeFlux({ env: r.env });
    expect(removed.ok).toBe(true);
    expect(removed.driftBackupPath).toBeTruthy();
    expect(read(removed.driftBackupPath!)).toBe(drifted);
    expect(JSON.parse(read(r.configPath)).provider.flux).toBeUndefined();
  });

  it("disconnecting something we never installed is a no-op, not a truncation", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    const removed = await disconnectOpenCodeFlux({ env: r.env });
    expect(removed.removed).toBe(false);
    expect(read(r.configPath)).toBe(USER_CONFIG);
  });
});

describe("permissions", () => {
  it("creates a new config 0600 — it holds a bearer token", async () => {
    const r = rig();
    await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(statSync(r.configPath).mode & 0o777).toBe(0o600);
  });

  it("never widens an existing config's permissions", async () => {
    const r = rig();
    writeFileSync(r.configPath, USER_CONFIG);
    chmodSync(r.configPath, 0o600);
    await connectOpenCodeFlux({ key: KEY, env: r.env });
    expect(statSync(r.configPath).mode & 0o777).toBe(0o600);
  });
});
