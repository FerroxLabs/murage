// P3 fix: the Android build script ships the node_modules path it reads from
// capacitor.settings.gradle to the build host, so that path must never lead outside
// apps/mobile/node_modules (or, mirrored, outside the lane). No build runs here.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LIB = fileURLToPath(new URL("../scripts/android-cap-path.sh", import.meta.url));
const STORE = "node_modules/.pnpm/@capacitor+android@8.5.2_@capacitor+core@8.5.2/node_modules/@capacitor/android";
let dirs: string[] = [];

function fixture(projectDir: string | null, makeDirs: string[] = [STORE]) {
  const root = mkdtempSync(join(tmpdir(), "mm-cap-path-"));
  dirs.push(root);
  const here = join(root, "apps-mobile");
  mkdirSync(join(here, "android"), { recursive: true });
  mkdirSync(join(here, "node_modules"), { recursive: true });
  for (const d of makeDirs) mkdirSync(join(here, d, "capacitor"), { recursive: true });
  if (projectDir !== null) {
    writeFileSync(
      join(here, "android/capacitor.settings.gradle"),
      `include ':capacitor-android'\nproject(':capacitor-android').projectDir = new File('${projectDir}')\n`,
    );
  }
  return { root, here };
}

function capPath(here: string) {
  const r = spawnSync("bash", ["-c", 'source "$1" && cap_path "$2"', "_", LIB, here], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("P3: cap_path keeps the Capacitor path inside node_modules", () => {
  it("accepts the pnpm store path cap sync writes", () => {
    const { here } = fixture(`../${STORE}/capacitor`);
    expect(capPath(here)).toMatchObject({ status: 0, out: STORE });
  });

  it.each([
    ["a .. segment", "../node_modules/../../outside/capacitor", ["../outside"]],
    ["a trailing .. segment", "../node_modules/x/../../outside/capacitor", ["node_modules/x", "../outside"]],
    ["a shell metacharacter", "../node_modules/$(touch pwned)/capacitor", []],
    ["a semicolon", "../node_modules/a;rm -rf x/capacitor", []],
    ["a space", "../node_modules/a b/capacitor", ["node_modules/a b"]],
    ["a quote", "../node_modules/a'b/capacitor", []],
    ["a path outside node_modules", "../android/capacitor", ["android"]],
    ["a missing directory", "../node_modules/nope/capacitor", []],
  ])("rejects %s", (_name, projectDir, makeDirs) => {
    const { here } = fixture(projectDir, makeDirs);
    const r = capPath(here);
    expect(r.status).not.toBe(0);
    expect(r.out).toBe("");
  });

  it("rejects a symlink inside node_modules that resolves outside it", () => {
    const { root, here } = fixture(null, []);
    mkdirSync(join(root, "outside/capacitor"), { recursive: true });
    symlinkSync(join(root, "outside"), join(here, "node_modules/escape"));
    writeFileSync(
      join(here, "android/capacitor.settings.gradle"),
      "project(':capacitor-android').projectDir = new File('../node_modules/escape/capacitor')\n",
    );
    expect(capPath(here).status).not.toBe(0);
  });

  it("rejects two project paths and a missing settings file", () => {
    const { here } = fixture(`../${STORE}/capacitor`);
    writeFileSync(
      join(here, "android/capacitor.settings.gradle"),
      `x = new File('../${STORE}/capacitor')\ny = new File('../${STORE}/capacitor')\n`,
    );
    expect(capPath(here).status).not.toBe(0);
    rmSync(join(here, "android/capacitor.settings.gradle"));
    expect(capPath(here).status).not.toBe(0);
  });

  it("accepts this checkout's real path", () => {
    const { status, out } = capPath(fileURLToPath(new URL("..", import.meta.url)));
    expect(status).toBe(0);
    expect(out).toMatch(/^node_modules\/\.pnpm\/@capacitor\+android@/);
  });

  it("is what the build script uses, with the lane and path quoted in remote commands", () => {
    const script = readFileSync(fileURLToPath(new URL("../scripts/android-remote.sh", import.meta.url)), "utf8");
    expect(script).toContain('CAP=$(cap_path "$HERE")');
    expect(script).not.toMatch(/ssh "\$HOST" "[^"]*\$(LANE|CAP)\b/);
    expect(script).not.toMatch(/-v \$LANE/);
  });
});
