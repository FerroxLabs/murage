// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-TRUST-V2 R4 on a Cloud home: the core renders typed lists, and the launcher validates
// them and writes Fuigo's store inside the turn's namespace, the only place its tmpfs home
// exists. These tests drive the real launcher Python on the build host through the shared rig.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudRenderFuigoSeed, fuigoSeedText, seedFuigoHome } from "../folder-trust-seed.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { launcherRig, type Rig } from "./engine-launch-fixture.ts";
import { TURN_RENDER, cloudTurnRenderContents } from "./turn-process.ts";

const onPosix = describe.skipIf(process.platform === "win32");
let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-seed-"); });
afterEach(() => { rig.dispose(); vi.unstubAllEnvs(); });
const unit = "murage-turn-0123456789abcdef.scope";
const SEED = "/tmp/murage-render-0123456789abcdef/trusted_folders.seed";
const scratch = "native/provider-turns/fuigoAgent-0123456789ab";
const route = { provider: "murage_0123456789abcdef", baseUrl: "https://fixture.example/v1", model: "fixture-model", apiKey: "fixture-route-key", protocol: "openai" };
const seeded = (seeds: Record<string, unknown>, extra: Record<string, unknown> = {}) => rig.request("fuigoAgent", { unit, scratch: [scratch], render: { route, ...seeds }, ...extra });
const ok = (request: Record<string, unknown>) => { const result = rig.plan(request); if (!result.ok) throw new Error(result.error); return result.ok; };
const refused = (request: Record<string, unknown>) => rig.plan(request).error;

onPosix("the launcher takes the seeds (R4)", () => {
  it("renders the source file, leaves the store itself writable, and starts through the seeding child", () => {
    const plan = ok(seeded({ fuigoDeclinedFolders: ["/w/no"], fuigoTrustedFolders: ["/w/yes"] }));
    const state = `${rig.home("fuigoAgent")}/${scratch}`;
    expect(plan.files[SEED]).toBe('[folders."/w/no"]\ntrusted = false\nconsent = 2\n\n[folders."/w/yes"]\ntrusted = true\nconsent = 2\n');
    expect(plan.files).not.toHaveProperty([`${state}/trusted_folders.toml`]);
    expect(plan.argv.slice(plan.argv.indexOf("--child-fuigo-seed"), plan.argv.indexOf("--child-fuigo-seed") + 3)).toEqual(["--child-fuigo-seed", SEED, state]);
    expect(plan.argv).not.toContain("--child");
  });
  it("a turn with no seeds keeps today's argv and files", () => {
    const plan = ok(rig.request("fuigoAgent", { unit, scratch: [scratch], render: { route } }));
    expect(plan.argv).toContain("--child");
    expect(plan.argv).not.toContain("--child-fuigo-seed");
    expect(plan.files).not.toHaveProperty([SEED]);
  });
  it("a path with a template token is data: plain, never scanned as a config", () => {
    expect(ok(seeded({ fuigoDeclinedFolders: ["/w/${odd}/{env:x}"] })).files[SEED]).toContain("${odd}");
  });
  it("writes raw UTF-8, never an escape TOML refuses", () => {
    expect(ok(seeded({ fuigoDeclinedFolders: ["/w/\u{1f600}é\"q"] })).files[SEED]).toContain('[folders."/w/\u{1f600}é\\"q"]');
  });
  it("refuses them for any other engine", () => {
    expect(refused(rig.request("codex", { render: { fuigoDeclinedFolders: ["/w/no"] } }))).toBe("Cloud turn render part is not allowed: fuigoDeclinedFolders");
  });
  it("seeds an unrouted turn into $HOME/.fuigo, bound from the launcher's turn tmpfs and from nothing on disk", () => {
    const plan = ok(rig.request("fuigoAgent", { unit, render: { fuigoDeclinedFolders: ["/w/no"], fuigoTrustedFolders: ["/w/yes"] } }));
    const state = `${rig.home("fuigoAgent")}/.fuigo`;
    expect(plan.files[SEED]).toBe('[folders."/w/no"]\ntrusted = false\nconsent = 2\n\n[folders."/w/yes"]\ntrusted = true\nconsent = 2\n');
    expect(plan.argv.slice(plan.argv.indexOf("--child-fuigo-seed"), plan.argv.indexOf("--child-fuigo-seed") + 3)).toEqual(["--child-fuigo-seed", SEED, state]);
    expect(plan.argv).not.toContain("--child");
    expect(plan.binds).toContainEqual([`${plan.turnHome}/.fuigo`, state]);
    expect(plan.binds.filter(([, target]: string[]) => target === rig.home("fuigoAgent"))).toEqual([[plan.turnHome, rig.home("fuigoAgent")]]);
    expect(plan.files).not.toHaveProperty([`${state}/trusted_folders.toml`]);
  });
  it("refuses the engine home as a key on an unrouted turn, and any seed on a sign-in", () => {
    expect(refused(rig.request("fuigoAgent", { unit, render: { fuigoTrustedFolders: [rig.home("fuigoAgent")] } }))).toBe("Cloud turn render seeds the engine home");
    expect(rig.plan(rig.request("fuigoAgent", { unit, render: { fuigoTrustedFolders: ["/w/yes"] } }), { login: true }).error).toBe("Cloud login request carries render");
  });
  it.each([
    ["relative", "w/no"], ["root", "/"], ["a control character", "/w/a\nb"], ["DEL", "/w/a\u007fb"], ["not canonical", "/w/a/../b"], ["a double slash", "//w/a"], ["over 4096 bytes", `/${"x".repeat(4096)}`], ["not a string", 7],
  ])("refuses the whole turn on a decline or a trust that is %s", (_name, path) => {
    for (const key of ["fuigoDeclinedFolders", "fuigoTrustedFolders"]) expect(refused(seeded({ [key]: [path] }))).toBe(`Cloud turn render ${key} holds a path that is not allowed`);
  });
  it("refuses a lone surrogate, the engine home, a repeat, a string in both lists, an empty list and over 1024 paths", () => {
    expect(refused(seeded({ fuigoDeclinedFolders: ["/w/\ud800"] }))).toMatch(/not (allowed|valid UTF-8)/u);
    expect(refused(seeded({ fuigoTrustedFolders: [rig.home("fuigoAgent")] }))).toBe("Cloud turn render seeds the engine home");
    expect(refused(seeded({ fuigoDeclinedFolders: ["/w/a", "/w/a"] }))).toBe("Cloud turn render fuigoDeclinedFolders is not allowed");
    expect(refused(seeded({ fuigoDeclinedFolders: ["/w/a"], fuigoTrustedFolders: ["/w/a"] }))).toBe("Cloud turn render seeds one path twice");
    expect(refused(seeded({ fuigoDeclinedFolders: [] }))).toBe("Cloud turn render fuigoDeclinedFolders is not allowed");
    expect(refused(seeded({ fuigoDeclinedFolders: Array.from({ length: 1025 }, (_v, index) => `/w/${index}`) }))).toBe("Cloud turn render fuigoDeclinedFolders is not allowed");
    expect(ok(seeded({ fuigoDeclinedFolders: Array.from({ length: 1024 }, (_v, index) => `/w/${index}`) })).files[SEED]).toContain('"/w/1023"');
  });
});

onPosix("the write inside the namespace (R4)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-seed-write-")); });
  afterEach(() => removeTempDirSync(dir));
  const write = (source: string, home: string) => rig.py(`m.write_fuigo_seed(sys.argv[2],sys.argv[3])`, source, home);

  it("leaves only the file, mode 0600, byte for byte", () => {
    const source = join(dir, "seed"), home = join(dir, "home");
    writeFileSync(source, "seed bytes");
    mkdirSync(home);
    write(source, home);
    expect(readdirSync(home)).toEqual(["trusted_folders.toml"]);
    expect(readFileSync(join(home, "trusted_folders.toml"), "utf8")).toBe("seed bytes");
    expect(statSync(join(home, "trusted_folders.toml")).mode & 0o777).toBe(0o600);
  });
  it("raises on a file already there, and changes nothing", () => {
    const source = join(dir, "seed"), home = join(dir, "home");
    writeFileSync(source, "seed bytes");
    mkdirSync(home);
    writeFileSync(join(home, "trusted_folders.toml"), "kept");
    expect(() => write(source, home)).toThrow(/already holds a trust file/u);
    expect(readFileSync(join(home, "trusted_folders.toml"), "utf8")).toBe("kept");
    expect(readdirSync(home)).toEqual(["trusted_folders.toml"]);
  });
  it("raises on a failed rename and leaves no temp file", () => {
    const source = join(dir, "seed"), home = join(dir, "home");
    writeFileSync(source, "seed bytes");
    mkdirSync(home);
    expect(() => rig.py(`
def refuse(*_args): raise OSError("fixture rename")
os.replace=refuse
m.write_fuigo_seed(sys.argv[2],sys.argv[3])`, source, home)).toThrow(/fixture rename/u);
    expect(readdirSync(home)).toEqual([]);
  });
  it("raises on an unreadable source, before anything is made", () => {
    const home = join(dir, "home");
    mkdirSync(home);
    expect(() => write(join(dir, "missing"), home)).toThrow();
    expect(existsSync(join(home, "trusted_folders.toml"))).toBe(false);
  });
});

onPosix("(3) the render and the launcher agree", () => {
  const home = { path: "/data/engine-homes/fuigoAgent/native/provider-turns/fuigoAgent-x", cloud: true };
  const rendered = async (rejects: Array<{ key: string; folder: string }>, trustKeys: string[] = []) => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const seed = await seedFuigoHome(home, { trustKeys, rejects, realCwd: "/w/cwd", policyGrant: false, cloudHome: "/data/engine-homes/fuigoAgent" });
    const env: NodeJS.ProcessEnv = {};
    cloudRenderFuigoSeed(env, seed);
    return { seed, env, render: cloudTurnRenderContents(env) };
  };

  it("K is rendered at key and folder before the Forget and gone after it, and the launcher's text is the desktop text", async () => {
    const before = await rendered([{ key: "/w/main", folder: "/w/cwd" }], ["/w/cwd/nested"]);
    expect(before.render).toEqual({ fuigoDeclinedFolders: ["/w/main", "/w/cwd"], fuigoTrustedFolders: ["/w/cwd/nested"] });
    expect(before.seed).toMatchObject({ declinesSeeded: true, chipKey: "/w/main" });
    expect(ok(seeded(before.render as Record<string, unknown>)).files[SEED]).toBe(fuigoSeedText(before.seed));
    const after = await rendered([]);
    expect(after.env[TURN_RENDER]).toBeUndefined();
    expect(after.seed).toMatchObject({ declinesSeeded: true, chipKey: null });
  });
  it("the core applies the path-of-cwd and skipped-decline rules before rendering", async () => {
    expect((await rendered([{ key: "/w/x", folder: "/w/cwd" }], ["/w"])).render.fuigoTrustedFolders).toBeUndefined();
    const skipped = await rendered([{ key: "/w/good", folder: "not/absolute" }], ["/w/other"]);
    expect(skipped.render).toEqual({ fuigoDeclinedFolders: ["/w/good"] });
    expect(skipped.seed.declinesSeeded).toBe(false);
  });
  it("a path the core would pass is never one the launcher refuses", async () => {
    const hard = '/w/a"b\\c ${x} \u{1f600}';
    const { render } = await rendered([{ key: hard, folder: hard }]);
    expect(refused(seeded(render as Record<string, unknown>))).toBeUndefined();
  });
});
