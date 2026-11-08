// Rig-only: real debug config, real bot config preparation, no prompt/provider call.
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, chmodSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { OpenCodeDestinationResolver, probeOpenCodeDestination, type DestinationContext } from "./opencode-destination.ts";
import { recordEvents } from "./testing/events.ts";
import { destinationCandidates, OpenCodeDestinationKey } from "./opencode-destination-key.ts";
import { fluxDestination } from "./flux-destination.ts";
import { ensureDirs } from "./config.ts";
import { createOpenCodeDriver, isolateOpenCodeFromPersonalSetup, isolateOpenCodeGlobalInstructions, applyOpenCodeTurnPermission, ensureOpenCodeInjectModel } from "./drivers/acp/opencode-go.ts";
import { isolationStats, resetIsolationCache } from "./drivers/isolation-cache.ts";
import { resetScopeBookkeeping, scopeLockPath } from "./drivers/scoped-cli-home.ts";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cli = process.env.MURAGE_X4_REAL_OPENCODE;
  if (!cli || !isAbsolute(cli)) throw new Error("Set MURAGE_X4_REAL_OPENCODE to the absolute path of the real OpenCode binary on the rig; this test never skips.");
  expect(statSync(cli).isFile()).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "x4-real-")); dirs.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const home = join(root, "home"); mkdirSync(home);
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"), OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PURE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_CHANNEL_DB: "1" };
  const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  return { root, cwd, home, cli, env, write };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 2100));
// Test-only observation of the real resolver's key reads; no injected clock or
// production hook. Restore before timing so these extra stats are not measured.
function observeKeys() {
  const read = OpenCodeDestinationKey.prototype.read;
  const reads: { result: ReturnType<typeof read>; tuples: Record<string, string>; scope: string; injected: string; recent: string[]; config: any }[] = [];
  const spy = vi.spyOn(OpenCodeDestinationKey.prototype, "read").mockImplementation(function (this: OpenCodeDestinationKey, ...args) {
    const result = read.apply(this, args);
    const [env, cwd] = args;
    const tuples: Record<string, string> = {};
    const recent: string[] = [];
    for (const path of destinationCandidates(env, cwd)) {
      try {
        const st = statSync(path);
        if ((args[3] ?? Date.now()) - Math.max(st.mtimeMs, st.ctimeMs) <= 2000) recent.push(path);
        tuples[path] = JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, realpathSync(path)]);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        tuples[path] = "absent";
      }
    }
    const scope = join(env.OPENCODE_CONFIG_DIR!, "opencode.json");
    const config = tuples[scope] === "absent" ? undefined : JSON.parse(readFileSync(scope, "utf8"));
    reads.push({ result, tuples, scope, config, recent, injected: join(env.XDG_CONFIG_HOME!, "opencode/opencode.json") });
    return result;
  });
  return { reads, restore: () => spy.mockRestore() };
}
function assertFirstProbe(setup: string, adapter: boolean, reads: ReturnType<typeof observeKeys>["reads"]) {
  const [before, after, next] = reads;
  expect(before.result.cacheable).toBe(true);
  expect(after.result.cacheable).toBe(true);
  const changed = Object.keys(before.tuples).filter(path => before.tuples[path] !== after.tuples[path]);
  if (setup === "owner-scope") {
    // Turn 2: OpenCode added $schema to the generated scope during probe 1.
    expect(changed).toEqual([before.scope]);
    expect(before.config.$schema).toBeUndefined();
    expect(after.config).toEqual({ ...before.config, $schema: "https://opencode.ai/config.json" });
    expect(after.result.key).not.toBe(before.result.key);
  } else {
    expect(changed).toEqual([]);
    expect(after.result.key).toBe(before.result.key);
    // Adapter local-host turn 2: the first injection was written inside
    // sendTurn, after the test's wait; the unchanged key is still racy.
    // Preparation waits AFTER injection, so its first answer can be saved.
    expect(after.result.settled).toBe(!(adapter && setup === "local-host"));
    if (adapter && setup === "local-host") expect(after.recent).toEqual([after.injected]);
  }
  expect(next.result.key).toBe(after.result.key);
  expect(next.tuples).toEqual(after.tuples);
  expect(next.result.settled).toBe(true);
}
const preparationCounts = {
  empty: [1, 1, 1, 1],
  "owner-scope": [1, 2, 2, 2], // Turn 2: first probe's scoped $schema rewrite.
  "local-host": [1, 1, 1, 1],
};
const adapterCounts = {
  empty: [1, 1, 1, 1],
  "owner-scope": [1, 2, 2, 2], // Turn 2: first probe's scoped $schema rewrite.
  "local-host": [1, 2, 2, 2], // Turn 2: first injection was inside the 2 s freshness window.
};
it.each(["empty", "owner-scope", "local-host"] as const)("real bot preparation: %s settles and reports the whole common path", async setup => {
  const f = fixture(); ensureDirs(); resetIsolationCache(); resetScopeBookkeeping();
  const owner = join(f.root, "owner");
  if (setup === "owner-scope") f.write(join(owner, "opencode.json"), JSON.stringify({ model: "opencode/fixture", provider: { opencode: { options: { baseURL: "https://fixture.invalid/v1" } } } }));
  const probe = vi.fn(probeOpenCodeDestination), resolver = new OpenCodeDestinationResolver(probe);
  const keyReader = new OpenCodeDestinationKey();
  const counts: number[] = [], builds: number[] = [], parentMtimes: number[] = [], keys: string[] = [], overlays: (string | undefined)[] = [];
  const observation = observeKeys();
  let finalContext!: DestinationContext;
  for (let turn = 0; turn < 4; turn++) {
    // Rebuild from owner inputs exactly as a new bot turn does, never feed a prior scoped map back in.
    const env = { ...f.env };
    if (setup === "owner-scope") env.OPENCODE_CONFIG_DIR = owner;
    isolateOpenCodeFromPersonalSetup(env); applyOpenCodeTurnPermission(env);
    const model = setup === "local-host" ? ensureOpenCodeInjectModel("omlx::fixture", env) : "opencode/fixture";
    isolateOpenCodeGlobalInstructions(env, `x4-real-${setup}`);
    builds.push(isolationStats("opencode-config-scope").builds);
    parentMtimes.push(statSync(dirname(scopeLockPath(env.OPENCODE_CONFIG_DIR))).mtimeMs);
    overlays.push(env.OPENCODE_CONFIG_CONTENT);
    // A real wall-clock settle separates the racy-write rule from the injected-clock unit test.
    await settle();
    finalContext = { env, cwd: f.cwd, cli: f.cli, signal: new AbortController().signal, model, memoryOff: true };
    const answer = await resolver.resolve(finalContext);
    expect(fluxDestination(answer, "flux")).toBe("other");
    counts.push(probe.mock.calls.length); keys.push(observation.reads.at(-1)!.result.key);
  }
  observation.restore();
  assertFirstProbe(setup, false, observation.reads);
  expect(counts).toEqual(preparationCounts[setup]);
  expect(overlays.every(value => value === overlays[0])).toBe(true);
  expect(keys[2]).toBe(keys[1]); expect(keys[3]).toBe(keys[2]);
  if (setup === "owner-scope") {
    expect(builds).toEqual([1, 1, 1, 1]);
    expect(new Set(parentMtimes).size).toBeGreaterThan(1);
    f.write(join(owner, "opencode.json"), JSON.stringify({ model: "opencode/changed" }));
    const changed = { ...f.env, OPENCODE_CONFIG_DIR: owner }; isolateOpenCodeGlobalInstructions(changed, `x4-real-${setup}`);
    expect(isolationStats("opencode-config-scope").builds).toBe(2);
    expect(keyReader.read(changed, f.cwd, f.cli).key).not.toBe(keys[3]);
  }
  for (let n = 0; n < 20; n++) keyReader.read(finalContext.env, f.cwd, f.cli);
  const times: number[] = [];
  for (let n = 0; n < 1000; n++) {
    const start = performance.now(); keyReader.read(finalContext.env, f.cwd, f.cli); times.push(performance.now() - start);
  }
  const maxIndex = times.indexOf(Math.max(...times));
  const over5 = times.filter(ms => ms > 5).length;
  times.sort((a, b) => a - b);
  console.info(`X4_REAL setup=${setup} common_ms_p50=${times[499].toFixed(3)} common_ms_p95=${times[949].toFixed(3)} common_ms_p99=${times[989].toFixed(3)} common_ms_max=${times[999].toFixed(3)} max_sample_index_zero_based=${maxIndex} samples_over_5ms=${over5} probes=${JSON.stringify(counts)} memoDeps_builds=${JSON.stringify(builds)} scope_parent_mtime=${JSON.stringify(parentMtimes)}`);
  // MurageMain median-2 ms ruling: both middle samples stay under 2 ms (the old check read the upper middle).
  expect(times[499]).toBeLessThan(2); expect(times[500]).toBeLessThan(2);
}, 90_000);

it.each(["inline", "global", "project", "file", "env-empty", "endpoint", "model-api", "ancestor", "test-home", "managed", "config-dir", "explicit", "symlink"])("planted real config proof: %s", async layer => {
  const f = fixture();
  const config: any = { provider: { alias: { npm: "@ai-sdk/openai-compatible", models: { fixture: {} }, options: { baseURL: "https://api.fluxrouter.ai/v1" } } } };
  if (layer === "endpoint") config.provider.alias.options = { endpoint: "https://api.fluxrouter.ai/v1" };
  if (layer === "model-api") { delete config.provider.alias.options.baseURL; config.provider.alias.models.fixture.provider = { api: "https://api.fluxrouter.ai/v1" }; }
  if (layer === "env-empty") config.provider.alias.options.baseURL = "{env:X4_UNSET}";
  if (layer === "file") { f.write(join(f.cwd, "url"), "https://api.fluxrouter.ai/v1"); config.provider.alias.options.baseURL = "{file:./url}"; }
  const text = JSON.stringify(config);
  if (["inline", "env-empty", "endpoint"].includes(layer)) f.env.OPENCODE_CONFIG_CONTENT = text;
  else if (layer === "global") f.write(join(f.env.XDG_CONFIG_HOME, "opencode/opencode.json"), text);
  else if (layer === "ancestor") f.write(join(f.root, "opencode.json"), text);
  else if (layer === "test-home") f.write(join(f.home, ".opencode/opencode.json"), text);
  else if (layer === "managed") f.write(join(f.env.OPENCODE_TEST_MANAGED_CONFIG_DIR, "opencode.json"), text);
  else if (layer === "config-dir") { f.env.OPENCODE_CONFIG_DIR = join(f.root, "extra"); f.write(join(f.env.OPENCODE_CONFIG_DIR, "opencode.json"), text); }
  else if (layer === "explicit") { f.env.OPENCODE_CONFIG = join(f.root, "explicit.json"); f.write(f.env.OPENCODE_CONFIG, text); }
  else if (layer === "symlink") { const target = join(f.root, "linked.json"); f.write(target, text); symlinkSync(target, join(f.cwd, "opencode.json")); }
  else f.write(join(f.cwd, "opencode.json"), text);
  const resolver = new OpenCodeDestinationResolver();
  const answer = await resolver.resolve({ env: f.env, cwd: f.cwd, cli: f.cli, signal: new AbortController().signal, model: "alias/fixture", memoryOff: true });
  expect(fluxDestination(answer, "flux")).toBe(layer === "env-empty" ? "other" : "refuse-alias");
  // No ACP prompt is sent: the real executable is used only for debug config.

}, 30_000);

// Real bot adapter and real config probe; ACP replies come from the fixture so no
// prompt can reach a provider. The wrapper is pinned by the same launch path.
it.each(["empty", "owner-scope", "local-host"] as const)("real bot adapter: %s stops probing on stable turns", async setup => {
  const f = fixture(); ensureDirs(); resetIsolationCache(); resetScopeBookkeeping();
  const owner = join(f.root, "owner");
  if (setup === "owner-scope") f.write(join(owner, "opencode.json"), '{"provider":{"opencode":{"options":{"baseURL":"https://fixture.invalid/v1"}}}}');
  const log = join(f.root, "probes.log"), dump = join(f.root, "child.json"), wrapper = join(f.root, "engine");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  f.write(wrapper, `#!/bin/sh
if [ "$1" = debug ]; then
  echo probe >> ${quote(log)}
  exec ${quote(f.cli)} "$@"
fi
if [ "$1" = --version ]; then exec ${quote(f.cli)} "$@"; fi
exec ${quote(process.execPath)} --experimental-strip-types ${quote(join(process.cwd(), "server/testing/fake-acp-cli.ts"))} "$@"
`);
  chmodSync(wrapper, 0o755);
  const model = setup === "local-host" ? "omlx::fixture" : "opencode/fixture";
  const native = setup === "local-host" ? "omlx/fixture" : model;
  const env = { ...f.env, OPENCODE_API_KEY: "fixture-only", FAKE_ACP_MODELS: native, FAKE_ACP_DUMP: dump,
    ...(setup === "owner-scope" ? { OPENCODE_CONFIG_DIR: owner } : {}) };
  const driver = createOpenCodeDriver(async () => ({ default: native, options: [{ id: native, label: "Fixture" }] }));
  const instance = await driver.create({ instanceId: `x4-real-${setup}`, displayName: "X4 fixture", enabled: true, environment: env, config: { cli: wrapper, fullAuto: false } });
  const events = recordEvents(instance.adapter), counts: number[] = [], builds: number[] = [], mtimes: number[] = [];
  const observation = observeKeys();
  const messages: string[] = [];
  const info = vi.spyOn(console, "info").mockImplementation((...args) => { messages.push(args.map(String).join(" ")); });
  try {
    for (let n = 0; n < 4; n++) {
      await settle();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "x4-real", cwd: f.cwd, text: "Fixture response only", model });
      const done = await events.until(e => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      counts.push(readFileSync(log, "utf8").trim().split("\n").length);
      builds.push(isolationStats("opencode-config-scope").builds);
      const child = JSON.parse(readFileSync(dump, "utf8"));
      const scope = child.env.OPENCODE_CONFIG_DIR;
      expect(typeof scope).toBe("string"); mtimes.push(statSync(dirname(scopeLockPath(scope))).mtimeMs);
    }
    observation.restore();
    assertFirstProbe(setup, true, observation.reads);
    expect(counts).toEqual(adapterCounts[setup]);
    if (setup === "owner-scope") { expect(builds).toEqual([1, 1, 1, 1]); expect(new Set(mtimes).size).toBeGreaterThan(1); }
    // Probe turns ran with the key observer on; their time is the OpenCode
    // process (hundreds of ms), so the observer's few stats don't change it.
    const probeTimes = messages.filter(line => line.includes("opencode_dest ") && line.includes("source=probe")).map(line => Number(/ms=([0-9.]+)/.exec(line)?.[1]));
    // Cache-turn timing comes only from turns sent after the observer is
    // restored, so the printed ms are the resolver's own.
    const timedFrom = messages.length, probesBefore = counts.at(-1)!;
    for (let n = 0; n < 2; n++) {
      await settle();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "x4-real", cwd: f.cwd, text: "Fixture response only", model });
      const done = await events.until(e => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
    }
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(probesBefore);
    const common = messages.slice(timedFrom).filter(line => line.includes("source=cache")).map(line => Number(/ms=([0-9.]+)/.exec(line)?.[1]));
    expect(common.length).toBe(2);
    info.mockRestore();
    console.info(`X4_REAL_BOT setup=${setup} probe_turn_ms_observed=${JSON.stringify(probeTimes)} cache_turn_ms_unobserved=${JSON.stringify(common)} probes=${JSON.stringify(counts)} memoDeps_builds=${JSON.stringify(builds)} scope_parent_mtime=${JSON.stringify(mtimes)}`);
  } finally { observation.restore(); info.mockRestore(); events.stop(); await instance.dispose(); }
}, 120_000);

it.each(["project-edit", "same-size", "new-ancestor", "file-edit", "env-edit", "parent-link", "linked-target"])("real cached answer follows %s", async change => {
  const f = fixture();
  const safe = "https://api.safefoobar.ai/v1", flux = "https://api.fluxrouter.ai/v1";
  const config = (url: string) => JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { p: { npm: "@ai-sdk/openai-compatible", models: { m: {} }, options: { baseURL: url } } } });
  let file = join(f.cwd, "opencode.json");
  if (change === "parent-link" || change === "linked-target") {
    const a = join(f.root, "a"), b = join(f.root, "b"), link = join(f.root, "link");
    f.write(join(a, "opencode.json"), config(safe)); f.write(join(b, "opencode.json"), config(flux));
    symlinkSync(a, link); f.env.OPENCODE_CONFIG = join(link, "opencode.json"); file = join(a, "opencode.json");
  } else if (change === "new-ancestor") {
    f.env.OPENCODE_CONFIG_CONTENT = "{}";
  } else if (change === "env-edit") {
    f.env.X4_ROUTER_URL = safe; f.write(file, config("{env:X4_ROUTER_URL}"));
  } else if (change === "file-edit") {
    f.write(join(f.cwd, "url"), safe); f.write(file, config("{file:./url}"));
  } else f.write(file, config(safe));
  const probe = vi.fn(probeOpenCodeDestination), resolver = new OpenCodeDestinationResolver(probe);
  const ctx: DestinationContext = { env: f.env, cwd: f.cwd, cli: f.cli, signal: new AbortController().signal, model: "p/m", memoryOff: true };
  await settle(); expect(fluxDestination(await resolver.resolve(ctx), "flux")).toBe("other");
  await settle(); expect(fluxDestination(await resolver.resolve(ctx), "flux")).toBe("other");
  const settledCount = probe.mock.calls.length;
  await resolver.resolve(ctx); expect(probe).toHaveBeenCalledTimes(settledCount);
  if (change === "env-edit") f.env.X4_ROUTER_URL = flux;
  else if (change === "file-edit") f.write(join(f.cwd, "url"), flux);
  else if (change === "new-ancestor") f.write(join(f.root, "opencode.json"), config(flux));
  else if (change === "parent-link") { rmSync(join(f.root, "link")); symlinkSync(join(f.root, "b"), join(f.root, "link")); }
  else {
    const previous = statSync(file); f.write(file, config(flux));
    if (change === "same-size") { expect(statSync(file).size).toBe(previous.size); utimesSync(file, previous.atime, previous.mtime); }
  }
  expect(fluxDestination(await resolver.resolve(ctx), "flux")).toBe("refuse-alias");
  expect(probe).toHaveBeenCalledTimes(settledCount + 1);
}, 60_000);
