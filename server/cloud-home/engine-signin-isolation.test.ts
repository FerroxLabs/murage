// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const ROOT = "/data/engine-homes", TURN_HOME = "/run/fixture-turn/home";
/** Engine homes hold that engine's sign-in. A turn is planned with its own engine's home path as a mount point only, backed by
 * the launcher's turn tmpfs: no bind source is the disk home, the root or an ancestor, and no destination is another engine's. */
const drive = `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
out = {}
for engine in sorted(m["ENGINES"]):
    home = "${ROOT}/" + engine
    argv, blobs = m["turn_mount_args"](engine, [], home, home, "/opt/murage/bin/fixture", [], None, [], (10, 20), turn_home="${TURN_HOME}")
    refused = None
    try:
        m["turn_mount_args"](engine, [("/srv/fixture-src", home)], home, home, "/opt/murage/bin/fixture", [], None, [], (10, 20), turn_home="${TURN_HOME}")
    except m["Refusal"] as error:
        refused = str(error)
    out[engine] = {"argv": argv, "refused": refused}
print(json.dumps(out))
`;
type Plans = Record<string, { argv: string[]; refused: string | null }>;
const plans = (path: string): Plans => JSON.parse(execFileSync("python3", ["-I", "-c", drive, path], { encoding: "utf8" }));
const binds = (argv: string[]) => argv.flatMap((arg, i) => /^--(ro-)?bind(-try)?$/u.test(arg) ? [{ source: argv[i + 1]!, dest: argv[i + 2]! }] : []);
const ancestors = ["/", "/data"];
const leaks = (all: Plans) => Object.entries(all).flatMap(([engine, { argv }]) => binds(argv).filter(({ source, dest }) =>
  source === ROOT || source.startsWith(ROOT + "/") || ancestors.includes(source) ||
  ((dest === ROOT || dest.startsWith(ROOT + "/")) && dest !== `${ROOT}/${engine}` && !dest.startsWith(`${ROOT}/${engine}/`))).map(b => `${engine}:${b.source}->${b.dest}`));
it("a turn binds its own engine home path only to the launcher's turn tmpfs, never the disk home or another engine's", () => {
  const all = plans(launcher);
  expect(Object.keys(all).length).toBeGreaterThan(10);
  for (const [engine, { argv }] of Object.entries(all)) expect(binds(argv)).toContainEqual({ source: TURN_HOME, dest: `${ROOT}/${engine}` });
  expect(leaks(all)).toEqual([]);
});
it("a mount that names the whole engine home is refused", () => {
  for (const { refused } of Object.values(plans(launcher))) expect(refused).toBe("Cloud turn binds the whole engine home");
});
const source = readFileSync(launcher, "utf8");
const BIND_LOOP = "    for source, path in mounts:\n        if path == home:\n";
const mutants: Array<[string, string, string]> = [
  ["also binds the disk engine home", BIND_LOOP, `    argv += ["--bind", home, home]\n` + BIND_LOOP],
  ["also binds the whole engine-homes root", BIND_LOOP, `    argv += ["--bind", "${ROOT}", "${ROOT}"]\n` + BIND_LOOP],
  ["also binds the engine-homes parent", BIND_LOOP, `    argv += ["--bind", "/data", "/data"]\n` + BIND_LOOP],
  ["also binds another engine's home", BIND_LOOP, `    argv += ["--bind", turn_home, "${ROOT}/" + ("codex" if engine == "claudeAgent" else "claudeAgent")]\n` + BIND_LOOP],
];
for (const [name, from, to] of mutants) {
  it(`the witness catches a launcher that ${name} (mutant)`, () => {
    const dir = mkdtempSync(join(tmpdir(), "signin-mutant-"));
    try {
      expect(source).toContain(from);
      const mutant = join(dir, "launch.py"); writeFileSync(mutant, source.replace(from, to));
      expect(leaks(plans(mutant)).length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
it("the witness catches a launcher that stops refusing a whole-home mount (mutant)", () => {
  const dir = mkdtempSync(join(tmpdir(), "signin-mutant-"));
  try {
    const from = '        if path == home:\n            raise Refusal("Cloud turn binds the whole engine home")\n';
    expect(source).toContain(from);
    const mutant = join(dir, "launch.py"); writeFileSync(mutant, source.replace(from, ""));
    expect(Object.values(plans(mutant)).some(({ refused }) => refused === null)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real mounts: a throwaway engine-homes tree. validate_request chooses the home and judges the cwd, the mount plan is built as
// launch() builds it (the cwd opened with open_directory and bound at the cwd unless it is the home), and turn_mount_args plans
// the binds, for two engines side by side. The cwd rule is the only guard against binding another engine's home.
const PAIR = ["claudeAgent", "codex"];
const driveReal = `
import json, os, runpy, sys
m = runpy.run_path(sys.argv[1])
root, engine, manifest, command, cache, other = sys.argv[2:8]
req = {"engine": engine, "command": command, "args": ["--version"], "env": {}}
def check(r):
    return m["validate_request"](r, manifest, os.getuid(), root, cache)
res = {"home": check(dict(req))[1], "rejected": {}}
for label, bad in {"otherHome": root + "/" + other, "otherSub": root + "/" + other + "/work", "root": root, "parent": os.path.dirname(root)}.items():
    try:
        check(dict(req, cwd=bad))
        res["rejected"][label] = False
    except ValueError:
        res["rejected"][label] = True
_, h, c, cmd, args, _, render, _ = check(dict(req, cwd=res["home"] + "/work"))
os.close(m["open_directory"](c))
mounts = [("/run/murage-turn/0", c)] if c != h else []
argv, _ = m["turn_mount_args"](engine, mounts, h, c, cmd, args, render, [], (10, 20), turn_home="${TURN_HOME}")
res["argv"] = argv
res["cwd"] = c
print(json.dumps(res))
`;
type Real = { home: string; rejected: Record<string, boolean>; argv: string[]; cwd: string };
const runReal = (launcherPath: string) => {
  const dir = mkdtempSync(join(process.cwd(), ".signin-real-"));
  try {
    const root = join(dir, "engine-homes"), bytes = readFileSync("/usr/bin/true"), command = join(dir, "fixture-cli");
    writeFileSync(command, bytes, { mode: 0o755 });
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify(Object.fromEntries(PAIR.map(e => [e, [{ path: command, sha256: createHash("sha256").update(bytes).digest("hex") }]]))), { mode: 0o644 });
    for (const e of PAIR) { mkdirSync(join(root, e, "work"), { recursive: true }); writeFileSync(join(root, e, ".signin-token"), `${e}-secret`); }
    return PAIR.map(own => {
      const other = PAIR.find(e => e !== own)!;
      try {
        const run = JSON.parse(execFileSync("python3", ["-I", "-c", driveReal, launcherPath, root, own, manifest, command, join(dir, "cache"), other], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Real;
        return { own, other, root, run, crashed: "" };
      } catch (error) { return { own, other, root, run: null as Real | null, crashed: String((error as { stderr?: string }).stderr ?? error).split("\n").slice(-3).join(" ") }; }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
/** What a plan must not do: bind a source at the root, an ancestor or another engine's home, or bind anything at a destination
 * that is another engine's home, the root or an ancestor. */
const realLeaks = (r: ReturnType<typeof runReal>[number]) => {
  if (!r.run) return ["crashed"];
  const own = join(r.root, r.own), other = join(r.root, r.other), parent = dirname(r.root);
  const out = binds(r.run.argv).filter(({ source, dest }) => [source, dest].some(p => p === r.root || p === parent || p === "/" || p === other || p.startsWith(other + sep))).map(b => `${b.source}->${b.dest}`);
  if (r.run.home !== own) out.push(`home ${r.run.home}`);
  for (const [label, refused] of Object.entries(r.run.rejected)) if (!refused) out.push(`cwd accepted: ${label}`);
  return out;
};
it("real validate_request and mount plan: a cwd at the other engine's home, the root or its parent is refused, and no bind reaches them", () => {
  const all = runReal(launcher);
  expect(all.map(r => r.own)).toEqual(PAIR);
  for (const r of all) {
    expect(r.crashed).toBe("");
    expect(r.run!.home).toBe(join(r.root, r.own));
    expect(r.run!.rejected).toEqual({ otherHome: true, otherSub: true, root: true, parent: true });
    expect(r.run!.cwd).toBe(join(r.root, r.own, "work"));
    expect(binds(r.run!.argv)).toContainEqual({ source: "/run/murage-turn/0", dest: r.run!.cwd });
    expect(binds(r.run!.argv)).toContainEqual({ source: TURN_HOME, dest: join(r.root, r.own) });
    expect(realLeaks(r)).toEqual([]);
  }
});
const REAL_MUTANTS: Array<[string, string, string]> = [
  ["picks the other engine's home", 'home = checked_directory(engine_root + "/" + engine, engine_root)', 'home = checked_directory(engine_root + "/" + ("codex" if engine == "claudeAgent" else "claudeAgent"), engine_root)'],
  ["drops the separator from the home path", 'home = checked_directory(engine_root + "/" + engine, engine_root)', 'home = checked_directory(engine_root + engine, engine_root)'],
  ["lets a cwd outside the home sit under the engine-homes root", "checked_directory(cwd, home if inside else WORKSPACE_ROOT)", "checked_directory(cwd, home if inside else engine_root)"],
  ["accepts any cwd", "        checked_directory(cwd, home if inside else WORKSPACE_ROOT)\n", ""],
];
for (const [name, from, to] of REAL_MUTANTS) {
  it(`the real-mount witness catches a launcher that ${name} (mutant)`, () => {
    const dir = mkdtempSync(join(tmpdir(), "signin-mutant-"));
    try {
      expect(source).toContain(from);
      const mutant = join(dir, "launch.py"); writeFileSync(mutant, source.replace(from, to));
      const runs = runReal(mutant);
      // Only the missing separator may stop validate_request outright; the others must be caught by what they let through.
      if (!name.includes("separator")) expect(runs.map(r => r.crashed)).toEqual(["", ""]);
      expect(runs.flatMap(realLeaks).length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
