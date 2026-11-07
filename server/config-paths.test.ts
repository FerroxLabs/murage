// S5-DATADIR-PATHS r4.1 sites 6 and 7 (D10, D11, D18): config.json paths under a recorded previous data root.
// This file owns its DATA_DIR (per-file HOME).
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR, loadConfig } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { configPathSeams, rebaseConfigPaths, REHOME_FAILED_TEXT, refusedCliIdsForTest } from "./config-paths.ts";
import { claudeAccountEnvironment, claudeAccountInfo } from "./claude-accounts.ts";
import { LocalSetupError } from "./local-setup-failure.ts";

const OLD = "/gone/old/.murage";
const configFile = () => join(DATA_DIR, "config.json");
function setup(instances: Record<string, unknown>): void {
  for (const name of ["config.json", ".murage-root.json", "providers"]) rmSync(join(DATA_DIR, name), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: OLD, previous: [] }));
  writeFileSync(configFile(), JSON.stringify({ instances }));
  bootDataRoots(); // the recorded root differs: OLD moves into previous (P1)
}
const saved = () => JSON.parse(readFileSync(configFile(), "utf8")).instances;
let uuid = 0;
beforeEach(() => { configPathSeams.uuid = () => `u${++uuid}`; configPathSeams.mkdir = path => mkdirSync(path, { mode: 0o700 }); });

it("D10: a Claude account configDir under the previous root is rebased in config.json; the env names the new folder", () => {
  setup({ claude2: { driver: "claudeAgent", displayName: "Work", config: { configDir: `${OLD}/providers/claude2` } } });
  expect(rebaseConfigPaths(() => {}).rebased).toBe(1);
  const dir = join(DATA_DIR, "providers", "claude2");
  expect(saved().claude2.config.configDir).toBe(dir);
  expect(claudeAccountEnvironment({}, dir).CLAUDE_CONFIG_DIR).not.toContain(OLD);
});

it("D11: a managed cli under the previous root is rebased; an unshaped one is refused, treated as missing, config.json unchanged", () => {
  const cli = `${OLD}/managed-engines/codex-1.2.3-abc/bin/codex`;
  setup({ codex: { driver: "codex", config: { cli } } });
  rebaseConfigPaths(() => {});
  expect(saved().codex.config.cli).toBe(join(DATA_DIR, "managed-engines", "codex-1.2.3-abc", "bin", "codex"));
  setup({ codex: { driver: "codex", config: { cli: `${OLD}/managed-engines/not-managed/codex` } } });
  const before = readFileSync(configFile());
  rebaseConfigPaths(() => {});
  expect(refusedCliIdsForTest()).toEqual(["codex"]);
  expect(readFileSync(configFile()).equals(before)).toBe(true);
  expect((loadConfig().instances as Record<string, { config: Record<string, unknown> }>).codex.config.cli).toBeUndefined();
});

it("D18: a refused configDir is re-homed to providers/<id>.<uuid> in one save; the env never names the old path", () => {
  setup({ claude2: { driver: "claudeAgent", displayName: "Work", config: { configDir: `${OLD}/providers/someone-else` } } });
  expect(rebaseConfigPaths(() => {}).rehomed).toBe(1);
  const fresh = saved().claude2.config.configDir as string;
  expect(fresh).toMatch(/providers[\\/]claude2\.u\d+$/);
  expect(lstatSync(fresh).isDirectory()).toBe(true);
  expect(claudeAccountEnvironment({}, fresh).CLAUDE_CONFIG_DIR).toBe(fresh);
});

it("D18: an existing dir at the fresh name -> the account stays unavailable, sign-in disabled, config.json unchanged, never the old path", () => {
  const old = `${OLD}/providers/someone-else-2`;
  setup({ claude3: { driver: "claudeAgent", displayName: "Home", config: { configDir: old } } });
  configPathSeams.mkdir = () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); };
  const before = readFileSync(configFile());
  expect(rebaseConfigPaths(() => {}).refused).toBe(1);
  expect(readFileSync(configFile()).equals(before)).toBe(true);
  let error: unknown; try { claudeAccountEnvironment({}, old); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(LocalSetupError);
  expect((error as Error).message).toBe(REHOME_FAILED_TEXT);
  const info = claudeAccountInfo("claude3", { driver: "claudeAgent", config: { configDir: old } } as never, "claude");
  expect(info.signInCommand).toBe("");
  expect(existsSync(join(DATA_DIR, "providers", "claude3.u1"))).toBe(false);
});

it("a user configDir outside any recorded root is kept as it is [control]", () => {
  setup({ claude4: { driver: "claudeAgent", displayName: "Mine", config: { configDir: "/Users/someone/.claude-work" } } });
  const before = readFileSync(configFile());
  expect(rebaseConfigPaths(() => {})).toEqual({ rebased: 0, rehomed: 0, refused: 0 });
  expect(readFileSync(configFile()).equals(before)).toBe(true);
});
