import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, unlinkSync, linkSync, symlinkSync, utimesSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeDestinationKey } from "./opencode-destination-key.ts";
import { OpenCodeDestinationResolver, type DestinationContext } from "./opencode-destination.ts";
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, realpathSync: vi.fn(fs.realpathSync) };
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "x4-settle-")); roots.push(root);
  const write = (file: string, text = "{}") => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  const cli = join(root, "cli"); write(cli, "fixture");
  const cwd = join(root, "project"); mkdirSync(cwd);
  const env: Record<string, string> = { HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "test-home"), XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "data"), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed") };
  const key = new OpenCodeDestinationKey();
  const read = () => key.read(env, cwd, cli, Date.now() + 10_000);
  const ctx: DestinationContext = { env, cwd, cli, signal: new AbortController().signal, model: "p/m", memoryOff: true };
  return { root, cli, cwd, env, write, read, ctx };
}
it("realpath cache: content and mtime edits move the key", () => {
  const f = fixture(), path = join(f.cwd, "opencode.json"); f.write(path);
  const before = f.read().key;
  f.write(path, '{"model":"p/m"}'); utimesSync(path, 100, 100);
  expect(f.read().key).not.toBe(before);
});
it("realpath cache: file symlink retarget with equal size and mtime moves the key", () => {
  const f = fixture(), a = join(f.root, "a"), b = join(f.root, "b"), path = join(f.cwd, "opencode.json");
  f.write(a); linkSync(a, b); // Also equal inode/ctime: only the resolved name changes.
  symlinkSync(a, path); const before = f.read().key;
  symlinkSync(b, `${path}.next`); renameSync(`${path}.next`, path);
  expect(f.read().key).not.toBe(before);
});
it("realpath cache: parent symlink swap with identical file tuple moves the key", () => {
  const f = fixture(), a = join(f.root, "a"), b = join(f.root, "b"), parent = join(f.root, "parent");
  f.write(join(a, "opencode.json")); mkdirSync(b);
  linkSync(join(a, "opencode.json"), join(b, "opencode.json"));
  symlinkSync(a, parent, "dir"); f.env.OPENCODE_CONFIG = join(parent, "opencode.json");
  const before = f.read().key;
  symlinkSync(b, `${parent}.next`, "dir"); renameSync(`${parent}.next`, parent);
  expect(f.read().key).not.toBe(before);
});
it("realpath cache: stable reads make zero realpath calls and keep the key", () => {
  const f = fixture(), target = join(f.root, "target"); f.write(target, "fixture");
  f.write(join(f.cwd, "opencode.json"), JSON.stringify({ prompt: `{file:${target}}` }));
  const spy = vi.mocked(realpathSync); spy.mockClear();
  const before = f.read().key; expect(spy.mock.calls.length).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) {
    spy.mockClear(); expect(f.read().key).toBe(before); expect(spy).not.toHaveBeenCalled();
  }
});
it("realpath cache: tracks intermediate symlink targets before parent traversal", () => {
  const f = fixture(), a = join(f.root, "a"), b = join(f.root, "b"), hop = join(f.root, "hop");
  f.write(join(a, "opencode.json")); mkdirSync(join(a, "child")); mkdirSync(join(b, "child"), { recursive: true });
  linkSync(join(a, "opencode.json"), join(b, "opencode.json"));
  symlinkSync(a, hop, "dir");
  symlinkSync("hop/child/../opencode.json", join(f.root, "config"));
  f.env.OPENCODE_CONFIG = join(f.root, "config");
  const before = f.read().key;
  vi.mocked(realpathSync).mockClear(); expect(f.read().key).toBe(before); expect(realpathSync).not.toHaveBeenCalled();
  symlinkSync(b, `${hop}.next`, "dir"); renameSync(`${hop}.next`, hop);
  expect(f.read().key).not.toBe(before);
});
it("BUILD-FIX 2: a recent write gives probe, probe, probe, cache", async () => {
  const f = fixture(), path = join(f.cwd, "opencode.json"); f.write(path);
  const t0 = Math.max(statSync(path).ctimeMs, statSync(f.cli).ctimeMs);
  let now = t0;
  const probe = vi.fn(async () => { if (probe.mock.calls.length === 1) f.write(path, '{"$schema":"fixture"}'); return {}; });
  const resolver = new OpenCodeDestinationResolver(probe, () => now);
  const counts: number[] = [];
  for (const offset of [0, 1500, 10_000, 11_000]) { now = t0 + offset; await resolver.resolve(f.ctx); counts.push(probe.mock.calls.length); }
  expect(counts).toEqual([1, 2, 3, 3]);
});
it("BUILD-FIX 3: test-home .opencode edits move the key", () => {
  const f = fixture(), before = f.read().key; f.write(join(f.env.OPENCODE_TEST_HOME, ".opencode/opencode.json")); expect(f.read().key).not.toBe(before);
});
it("BUILD-FIX 3: real-home .opencode edits do not move it with a test home", () => {
  const f = fixture(), before = f.read().key; f.write(join(f.env.HOME, ".opencode/opencode.json")); expect(f.read().key).toBe(before);
  f.env.OPENCODE_TEST_HOME = ""; const empty = f.read().key; f.write(join(f.env.HOME, ".opencode/opencode.json"), '{"model":"p/m"}'); expect(f.read().key).toBe(empty);
});
it("BUILD-FIX 3: real XDG config edits still move the key", () => {
  const f = fixture(), before = f.read().key; f.write(join(f.env.XDG_CONFIG_HOME, "opencode/opencode.json")); expect(f.read().key).not.toBe(before);
});
it("BUILD-FIX 3: the managed override edits move the key", () => {
  const f = fixture(), before = f.read().key; f.write(join(f.env.OPENCODE_TEST_MANAGED_CONFIG_DIR, "opencode.json")); expect(f.read().key).not.toBe(before);
});
it("BUILD-FIX 4: planting and migrating the extensionless global config move the key", () => {
  const f = fixture(), file = join(f.env.XDG_CONFIG_HOME, "opencode/config"), before = f.read().key;
  f.write(file, 'model = "m"\nprovider = "p"\n'); const planted = f.read().key; expect(planted).not.toBe(before);
  unlinkSync(file); f.write(join(dirname(file), "config.json"), '{"model":"p/m"}'); expect(f.read().key).not.toBe(planted);
});
it.each(['{"p":{"type":"wellknown","key":"fixture","token":"fixture"}}', '{'])("BUILD-FIX 5: inline remote or unreadable auth never caches (%s)", async auth => {
  const f = fixture(); f.env.OPENCODE_AUTH_CONTENT = auth;
  const probe = vi.fn(async () => ({})), resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  await resolver.resolve(f.ctx); await resolver.resolve(f.ctx); expect(probe).toHaveBeenCalledTimes(2); expect(f.read().cacheable).toBe(false);
});
it("BUILD-FIX 5: rotating ordinary inline credentials leaves the key and cache alone", async () => {
  const f = fixture(); f.env.OPENCODE_AUTH_CONTENT = '{"p":{"type":"api","key":"one"}}';
  const before = f.read().key, probe = vi.fn(async () => ({})), resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  await resolver.resolve(f.ctx); f.env.OPENCODE_AUTH_CONTENT = '{"p":{"type":"api","key":"two"}}';
  expect(f.read().key).toBe(before); await resolver.resolve(f.ctx); expect(probe).toHaveBeenCalledTimes(1);
});

it("scans overlapping layers in either order and when referenced by two layers", () => {
  for (const order of ["layer-first", "target-first", "two-layers"]) {
    const f = fixture();
    const project = join(f.cwd, "opencode.json");
    const global = join(f.env.XDG_CONFIG_HOME, "opencode/opencode.json");
    const layer = order === "layer-first" ? project : global;
    const referrer = order === "layer-first" ? global : project;
    const nested = join(dirname(layer), "router-url");
    f.write(layer, JSON.stringify({ provider: { p: { options: { baseURL: "{file:./router-url}" } } }, description: "{env:ROUTER_NOTE}" }));
    f.write(referrer, JSON.stringify({ prompt: `{file:${layer}}` }));
    if (order === "two-layers") f.write(join(f.cwd, "opencode.jsonc"), JSON.stringify({ prompt: `{file:${layer}}` }));
    f.write(nested, "https://example.com/v1");
    const before = f.read(); expect(before.cacheable).toBe(true);
    f.write(nested, "https://api.fluxrouter.ai/v1");
    expect(f.read().key, order).not.toBe(before.key);
    const changed = f.read().key;
    f.env.ROUTER_NOTE = "changed";
    expect(f.read().key, `${order}: env dependency`).not.toBe(changed);
    expect(f.read().key).toBe(f.read().key);
  }
});
