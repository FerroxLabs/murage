// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rig v5.9 round 2: the REAL keep-logs.sh and stage-keeper.sh run in temp dirs (bash + awk + GNU find), the hz-smooth.sh wiring read as text.
import { scrubCore, safeAccounting } from "./scrub-accounting.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, statSync, symlinkSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scrubAccounting } from "./smooth-config.mjs";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const dir = name => fileURLToPath(new URL(name, import.meta.url));
const KEEP = dir("./keep-logs.sh"), STAGER = dir("./stage-keeper.sh"), HZ = dir("./hz-smooth.sh");
const keepSource = readFileSync(KEEP, "utf8");
const names = ["keep-logs.sh", "keep-logs.mjs", "scrub-accounting.mjs"];
const digest = data => createHash("sha256").update(data).digest("hex");
const hash = digest(names.map(name => name + "/" + digest(readFileSync(dir("./" + name))) + "\n").join(""));
const bundle = () => {
  const r = spawnSync("tar", ["--format=ustar", "-cf", "-", "-C", dir("."), ...names]);
  expect(r.status, r.stderr?.toString()).toBe(0); return r.stdout;
};
const roots = [];
let currentTmp;
afterEach(() => {
  let failure;
  for (const base of roots.splice(0)) {
    const tmp = join(base, "tmp");
    try { expect(readdirSync(tmp), "private stages must be removed").toEqual([]); }
    catch (error) { failure ??= error; }
    finally { removeTempDirSync(base); }
  }
  if (failure) throw failure;
});
const fresh = () => {
  const base = mkdtempSync(join(tmpdir(), "keeper-test-")); roots.push(base);
  for (const d of ["lane/out", "lane/src", "host", "bin", "tmp"]) mkdirSync(join(base, d), { recursive: true });
  currentTmp = join(base, "tmp"); return base;
};
const sh = (args, opts = {}) => spawnSync("bash", args, { encoding: "utf8", timeout: 60_000, ...opts,
  env: { ...process.env, SMOOTH_NODE: process.execPath, TMPDIR: currentTmp, ...opts.env } });

describe("keep-logs.sh (P1-2, P1-3, P2-8)", () => {
  const keep = (files, id = "run1") => {
    const base = fresh(), out = join(base, "lane/out"), root = join(base, "host/logs");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
    const r = sh([KEEP, out, root, id]);
    const kept = name => { try { return readFileSync(join(root, id, name), "utf8"); } catch { return null; } };
    return { base, out, root, r, kept, listing: existsSync(root) ? readdirSync(root) : [] };
  };
  it("scrubs a well-formed server log and copies results untouched", () => {
    const k = keep({ "server-a.log": 'ok usage="1,2" cost=5 tokensIn: 7 done\nplain line\n', "results-a.json": '{"usage":1}' });
    expect(k.r.status).toBe(0);
    expect(k.kept("server-a.log")).toBe('ok usage="x" cost="x" tokensIn: "x" done\nplain line\n');
    expect(k.kept("results-a.json")).toBe('{"usage":1}');
  });
  it.each([
    ['usage="SECRET', "unterminated quote"], ["usage=[SECRET", "unterminated array"], ["usage={SECRET", "unterminated object"],
    ["usage={a]SECRET}", "mismatched"], ["usage={\\}SECRET}", "backslash outside quotes"], ["tokens=SEC'RET", "quote in scalar"],
    [`usage="${"S".repeat(600)}SECRET"`, "over the 512 budget"], [`usage=${"S".repeat(600)}SECRET`, "scalar over budget"],
  ])("%s (%s): sed-style pass-through is gone, nothing after the key survives and later lines are dropped", (line) => {
    const k = keep({ "server-a.log": `before\n${line}\nafter SECRET2\n` });
    expect(k.r.status).toBe(0);
    const text = k.kept("server-a.log");
    expect(text).toContain("before"); expect(text).toContain("[accounting value cut]");
    expect(text).not.toContain("SECRET"); expect(text).not.toContain("after");
  });
  it("a multi-line value cannot leak its later lines", () => {
    const k = keep({ "server-a.log": 'usage={\n  "in": 1,\n  "secret": "SECRET"\n}\n' });
    expect(k.kept("server-a.log")).not.toContain("SECRET");
  });
  it("JS and shell scrubbers agree on every fixture: neither emits the secret; valid forms match exactly", () => {
    const fixtures = ['usage=777 x', 'cost: "888" y', 'tokens={"a":[1,2]} z', "charge='9' q", 'cachedInput=654,', 'USAGE=5', 'x usage="SECRET', "usage=[SECRET",
      `usage="${"a".repeat(510)}" t`, `usage="${"a".repeat(511)}" SECRET`, "usage={\\}SECRET}", "usage=SEC\"RET", "usage={a]SECRET}"];
    for (const text of fixtures) {
      const js = scrubAccounting(text), shell = keep({ "server-a.log": text + "\n" }).kept("server-a.log").replace(/\n$/, "");
      expect(js, text).not.toContain("SECRET"); expect(shell, text).not.toContain("SECRET");
      if (!js.includes("[accounting value cut]")) expect(shell, text).toBe(js); else expect(shell, text).toContain("[accounting value cut]");
    }
  });
  it("scrubs the failed-turns JSONL and keeps one record per line", () => {
    const k = keep({ "failed-turns-a.jsonl": '{"kind":"first","usage":{"in":1},"error":"e usage=\\"x\\""}\n{"kind":"enriched","cost":5,"tokensIn":"777"}\n' });
    expect(k.r.status, k.r.stderr).toBe(0);
    const text = k.kept("failed-turns-a.jsonl");
    expect(text).not.toMatch(/777|"in":1|cost":5/); expect(text).toContain('usage=\\"x\\"'); expect(text.trim().split("\n")).toHaveLength(2);
    for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });
  it.each([
    ['{not JSON}', "invalid object"],
    ["not json SECRET", "a non-record line"],
  ])("a malformed journal (%s) fails the keep: exit 4, no archive, no partial dir, original untouched", (line) => {
    const original = line + "\n";
    const k = keep({ "server-a.log": "fine\n", "failed-turns-a.jsonl": original });
    expect(k.r.status).toBe(4);
    expect(k.listing).toEqual([]);                    // no <id> dir and no .keep-* temporary dir
    expect(readFileSync(join(k.out, "failed-turns-a.jsonl"), "utf8")).toBe(original);
  });
  it("a journal alone (no server log) is kept; neither is exit 3 with nothing published", () => {
    expect(keep({ "failed-turns-a.jsonl": '{"k":1}\n' }).r.status).toBe(0);
    const none = keep({ "results-a.json": "{}" });
    expect(none.r.status).toBe(3); expect(none.listing).toEqual([]);
  });
  it("refuses overlapping source and destination and an existing run id", () => {
    const base = fresh(), out = join(base, "lane/out");
    writeFileSync(join(out, "server-a.log"), "x\n");
    expect(sh([KEEP, out, join(out, "logs"), "r"]).status).toBe(2);         // logs root inside the out dir
    expect(sh([KEEP, out, base, "r"]).status).toBe(2);                      // out dir inside the logs root
    const root = join(base, "host/logs");
    expect(sh([KEEP, out, root, "r"]).status).toBe(0);
    expect(sh([KEEP, out, root, "r"]).status).toBe(2);
  });
  it("a failing copy publishes nothing (exit 4)", () => {
    const base = fresh(), out = join(base, "lane/out"), root = join(base, "host/logs");
    writeFileSync(join(out, "server-a.log"), "x\n"); writeFileSync(join(out, "results-a.json"), "{}"); chmodSync(join(out, "results-a.json"), 0o000);
    const r = sh([KEEP, out, root, "r"]);
    if (process.getuid?.() !== 0) { expect(r.status).toBe(4); expect(readdirSync(root)).toEqual([]); }
  });
});

describe("stage-keeper.sh (P1-5, P2-7)", () => {
  const docker = (base, mode) => {
    const body = { running: 'echo true', stopped: 'echo false', absent: 'echo "Error response from daemon: No such object: x" >&2; exit 1',
      absentLower: 'echo "error: no such object: mm-smooth-lab" >&2; exit 1',
      denied: 'echo "permission denied while trying to connect to the docker API" >&2; exit 1' }[mode];
    writeFileSync(join(base, "bin/docker"), `#!/bin/bash\n${body}\n`); chmodSync(join(base, "bin/docker"), 0o755);
  };
  const run = (base, action, { mode = "absent", expected = hash, input = bundle(), env = {}, host } = {}) => {
    docker(base, mode);
    return sh([STAGER, join(base, "lane"), host ?? join(base, "host"), "lab", expected, join(base, "lane/src"), "0123456789ab", action],
      { input, env: { ...process.env, PATH: `${join(base, "bin")}:${process.env.PATH}`, SMOOTH_OWNER: randomBytes(16).toString("hex"), SMOOTH_TXN: "a".repeat(32), TMPDIR: join(base, "tmp"), ...env } });
  };
  const evidence = base => writeFileSync(join(base, "lane/out/server-lab.log"), 'usage="1"\n');
  const orphans = base => { try { return readdirSync(join(base, "host/smoothness/logs")); } catch { return []; } };

  it("archive preserves the previous run through the REVIEWED keeper and leaves the lane lock for the launcher", () => {
    const base = fresh(); evidence(base);
    const r = run(base, "archive");
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("keeper-ready:0123456789ab");
    expect(orphans(base)).toHaveLength(1); expect(existsSync(join(base, "host/smoothness/locks/lab.d/preserved"))).toBe(true);
  });
  it("an unknown Docker state (daemon down, access denied) FAILS CLOSED: exit 4, nothing preserved, no lock", () => {
    const base = fresh(); evidence(base);
    const r = run(base, "archive", { mode: "denied" });
    expect(r.status).toBe(4); expect(r.stderr).toContain("unknown"); expect(orphans(base)).toEqual([]);
    expect(existsSync(join(base, "host/smoothness/locks/lab.d"))).toBe(false);
  });
  it("a missing container is not running; a running label exits 3", () => {
    const base = fresh(); evidence(base);
    expect(run(base, "archive", { mode: "absent" }).status).toBe(0);
    const lower = fresh(); evidence(lower);
    expect(run(lower, "archive", { mode: "absentLower" }).status).toBe(0); // the wording of the Docker 29 on the box
    const busy = fresh(); evidence(busy);
    expect(run(busy, "archive", { mode: "running" }).status).toBe(3);
  });
  it("a second launch while the lane lock is held is refused (exit 3) and does not release the first lock", () => {
    const base = fresh(); evidence(base);
    expect(run(base, "prepare").status).toBe(0);
    expect(run(base, "archive").status).toBe(3);
    expect(existsSync(join(base, "host/smoothness/locks/lab.d"))).toBe(true);
  });
  it("hash mismatch exits 4 and runs nothing", () => {
    const base = fresh(); evidence(base);
    expect(run(base, "archive", { input: keepSource + "# tampered\n" }).status).toBe(4);
    expect(orphans(base)).toEqual([]);
  });
  it("refuses roots that contain the stage: '/' and '//' (the old prefix test let '/' through)", () => {
    const base = fresh(); evidence(base);
    for (const host of ["/", "//", "/tmp"]) { const r = run(base, "archive", { host }); expect(r.status, host).toBe(4); expect(r.stderr, host).toMatch(/overlaps/); }
  });
  it("present needs the receipt written by prepare; a changed lane after prepare is re-archived, not trusted", () => {
    const base = fresh(); evidence(base);
    expect(run(base, "present").status).toBe(4);                                   // no receipt
    expect(run(base, "prepare").status).toBe(0); expect(orphans(base)).toHaveLength(1);
    writeFileSync(join(base, "lane/out/server-lab.log"), 'usage="2"\nnew activity\n');
    const r = run(base, "present");
    expect(r.status, r.stderr).toBe(0); expect(orphans(base)).toHaveLength(2);     // the changed lane was preserved again
    expect(existsSync(join(base, "host/smoothness/locks/lab.d/receipt"))).toBe(false); // consumed
  });
  it("present with an unchanged lane consumes the receipt and archives nothing more", () => {
    const base = fresh(); evidence(base);
    expect(run(base, "prepare").status).toBe(0);
    expect(run(base, "present").status).toBe(0); expect(orphans(base)).toHaveLength(1);
  });
  it("a failed archive releases the lock and leaves the lane alone (exit 4)", () => {
    const base = fresh(); writeFileSync(join(base, "lane/out/failed-turns-lab.jsonl"), "garbage SECRET\n");
    const r = run(base, "archive");
    expect(r.status).toBe(4); expect(existsSync(join(base, "host/smoothness/locks/lab.d"))).toBe(false);
    expect(readFileSync(join(base, "lane/out/failed-turns-lab.jsonl"), "utf8")).toBe("garbage SECRET\n");
  });
  it("cleanup precedence: a failed stage removal turns success into 4 and never masks a failure", () => {
    const base = fresh(); evidence(base);
    writeFileSync(join(base, "bin/rm"), '#!/bin/bash\ncase "$*" in *murage-keeper*) exit 1 ;; esac\nexec /bin/rm "$@"\n'); chmodSync(join(base, "bin/rm"), 0o755);
    expect(run(base, "archive").status).toBe(4);
    const failing = fresh(); evidence(failing);
    writeFileSync(join(failing, "bin/rm"), '#!/bin/bash\ncase "$*" in *murage-keeper*) exit 1 ;; esac\nexec /bin/rm "$@"\n'); chmodSync(join(failing, "bin/rm"), 0o755);
    expect(run(failing, "archive", { mode: "running" }).status).toBe(3);        // the original rc survives
    for (const b of [base, failing]) for (const f of readdirSync(join(b, "tmp"))) removeTempDirSync(join(b, "tmp", f));
  });
});

describe("hz-smooth.sh wiring (P1-1, P2-8, P2-9)", () => {
  const text = readFileSync(HZ, "utf8");
  it("runs the staged, hash-verified keeper before every replacement path and never the old checkout's keep-logs.sh before them", () => {
    const keeperAt = text.indexOf("keeper archive");
    for (const marker of ["git -C \"$top\" archive", "find $L/src -mindepth 1", "tar -xzf", "\"$SMOOTH_SYNC\" \"$sha\"", "rm -rf -- \"\\${L:?}/data\""]) {
      expect(text.indexOf(marker), marker).toBeGreaterThan(keeperAt);
    }
    expect(keeperAt).toBeGreaterThan(0); expect(text).toContain("stage-keeper");
    expect(text.slice(0, keeperAt)).not.toMatch(/\$L\/src\/scripts\/smoothness\/keep-logs\.sh/);
    expect(text).toContain("khash=");
  });
  it("implements prepare-only and receipt-consuming present modes", () => {
    expect(text).toContain("SMOOTH_PRESERVE_ONLY"); expect(text).toContain("keeper prepare"); expect(text).toContain("keeper present");
    expect(text.indexOf("keeper present")).toBeLessThan(text.indexOf("does not hold $sha"));
  });
  it("guards deletion on a preserved gate.log, rotates the old journal only after the keeper, and tags nothing else", () => {
    expect(readFileSync(dir("./follow-run.sh"), "utf8")).toContain('cp -p -- "$log"');
    expect(text).toContain('failed-turns-*.jsonl; do [ ! -f "\\$f" ] || mv --'); expect(text).toContain("/preserved");
    expect(text).toContain("trap release_lock EXIT");
  });
});

const token = () => randomBytes(16).toString("hex");
const P = "a".repeat(32), REV = "0123456789ab";
function executable(base, name, body) {
  const path = join(base, "bin", name); writeFileSync(path, "#!/bin/bash\n" + body + "\n"); chmodSync(path, 0o755); return path;
}
function rig() {
  const base = fresh();
  executable(base, "docker", 'printf "%s\\n" "$*" >> "$TEST_BASE/docker.calls"; echo "No such object" >&2; exit 1');
  writeFileSync(join(base, "lane/out/server-lab.log"), "before usage=777\n");
  const legacy = !readFileSync(STAGER, "utf8").includes("bundle.tar");
  const args = action => [STAGER, join(base, "lane"), join(base, "host"), "lab", legacy ? digest(keepSource) : hash, join(base, "lane/src"), REV, action];
  const env = (owner, extra = {}) => ({ ...process.env, SMOOTH_NODE: process.execPath, TMPDIR: join(base, "tmp"),
    TEST_BASE: base, PATH: join(base, "bin") + ":" + process.env.PATH, SMOOTH_OWNER: owner, SMOOTH_TXN: P, ...extra });
  const run = (action, owner = token(), extra = {}, input = legacy ? keepSource : bundle()) => sh(args(action), { input, env: env(owner, extra) });
  const lock = join(base, "host/smoothness/locks/lab.d");
  const archives = () => { const path = join(base, "host/smoothness/logs"); return existsSync(path) ? readdirSync(path) : []; };
  return { base, args, env, run, lock, archives };
}
const waitForFile = async path => {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) { if (Date.now() > deadline) throw Error("barrier timeout: " + path); await new Promise(r => setTimeout(r, 10)); }
};
function background(args, env, input = "") {
  const p = spawn("bash", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", s => { stdout += s; }); p.stderr.on("data", s => { stderr += s; });
  const done = new Promise((resolve, reject) => { p.on("error", reject); p.on("close", status => resolve({ status, stdout, stderr })); });
  p.stdin.end(input); return { p, done };
}

describe("rev 6 ownership and preservation", () => {
  // T2 red on rev 4: Docker is inspected before acquisition.
  it("T2 refuses a busy lane without inspecting Docker", () => {
    const r = rig(); expect(r.run("archive").status).toBe(0);
    const calls = readFileSync(join(r.base, "docker.calls"), "utf8");
    expect(r.run("archive").status).toBe(3);
    expect(readFileSync(join(r.base, "docker.calls"), "utf8")).toBe(calls);
  });
  // T3 red on rev 4: a 121-minute lock is expired automatically.
  it("T3 retains an aged owner", () => {
    const r = rig(); expect(r.run("archive").status).toBe(0);
    const owner = readFileSync(join(r.lock, "owner"), "utf8");
    const old = new Date(Date.now() - 121 * 60_000); utimesSync(r.lock, old, old);
    expect(r.run("archive").status).toBe(3); expect(readFileSync(join(r.lock, "owner"), "utf8")).toBe(owner);
  });
  // T5 red on rev 4: release has no token-qualified detachment.
  it("T5 wrong release preserves the owner and right break detaches it", () => {
    const r = rig(), a = token(); expect(r.run("archive", a).status).toBe(0);
    expect(r.run("release").status).not.toBe(0); expect(existsSync(r.lock)).toBe(true);
    expect(r.run("break", token(), { SMOOTH_BREAK_LOCK: a }).status).toBe(0);
    expect(existsSync(r.lock)).toBe(false);
    expect(existsSync(join(r.base, "host/smoothness/locks/lab.flock"))).toBe(true);
  });
  // T10 red on rev 4: snapshot metadata aliases changed bytes with restored mtime.
  it("T10 binds same-size changed bytes and results to the receipt", () => {
    const r = rig(); expect(r.run("prepare").status).toBe(0);
    const path = join(r.base, "lane/out/server-lab.log"), old = statSync(path);
    writeFileSync(path, readFileSync(path, "utf8").replace("before", "AFTERS")); utimesSync(path, old.atime, old.mtime);
    expect(r.run("present").status).toBe(0); expect(r.archives()).toHaveLength(2);
  });
  // T11 red on rev 4: a failed hash pipeline can produce a successful empty snapshot.
  it("T11 refuses an injected sha256sum failure before publication", () => {
    const r = rig(); executable(r.base, "sha256sum", "exit 1");
    expect(r.run("prepare").status).toBe(4); expect(r.archives()).toEqual([]); expect(existsSync(r.lock)).toBe(false);
  });
  // T12 red on rev 4: its native receipt does not bind a nonempty transaction token.
  it("T12 rejects wrong transaction, extra fields and revision after a prepare control", () => {
    const r = rig(); expect(r.run("prepare").status).toBe(0);
    const receipt = join(r.lock, "receipt"), original = readFileSync(receipt, "utf8");
    expect(r.run("present", token(), { SMOOTH_TXN: "b".repeat(32) }).status).toBe(4);
    expect(readFileSync(receipt, "utf8")).toBe(original);
    for (const text of [original.trimEnd() + " extra\n", original.replace(REV, "fedcba987654")]) {
      writeFileSync(receipt, text); expect(r.run("present").status).toBe(4);
    }
    writeFileSync(receipt, original); expect(r.run("present").status).toBe(0);
  });
  // T14 red on rev 4: global stray-stage cleanup can remove another test's stage.
  it("T14 cleans only its private TMPDIR and leaves an unrelated sentinel", () => {
    const r = rig(), sentinel = join(r.base, "murage-keeper.unrelated"); mkdirSync(sentinel);
    writeFileSync(join(sentinel, "keep"), "sentinel");
    expect(r.run("archive", token(), {}, Buffer.from("invalid")).status).toBe(4);
    expect(readdirSync(join(r.base, "tmp"))).toEqual([]);
    expect(readFileSync(join(sentinel, "keep"), "utf8")).toBe("sentinel");
  });
  // T16 red on rev 4: two presents can both read the receipt before either removes it.
  it("T16 a barrier releases two presents and exactly one becomes ready", async () => {
    const r = rig(); expect(r.run("prepare").status).toBe(0);
    const gate = join(r.base, "go"), consume = join(r.base, "consume-go"), started = [join(r.base, "one"), join(r.base, "two")];
    const owners = [token(), token()], legacy = !readFileSync(STAGER, "utf8").includes("bundle.tar");
    executable(r.base, "rm", 'case "$*" in */receipt*) touch "$TEST_BASE/read-$SMOOTH_OWNER"; while [ ! -f "$TEST_BASE/consume-go" ]; do sleep 0.01; done ;; esac; exec /bin/rm "$@"');
    const launch = i => background(["-c", 'touch "$1"; while [ ! -f "$2" ]; do sleep 0.01; done; shift 2; exec bash "$@"', "barrier", started[i], gate, ...r.args("present")], r.env(owners[i]), legacy ? keepSource : bundle());
    const children = [launch(0), launch(1)]; await Promise.all(started.map(waitForFile)); writeFileSync(gate, "");
    const readPaths = owners.map(o => join(r.base, "read-" + o));
    if (legacy) await Promise.all(readPaths.map(waitForFile));
    else {
      const deadline = Date.now() + 5000;
      while (!readPaths.some(existsSync)) { if (Date.now() > deadline) throw Error("claim barrier timeout"); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    writeFileSync(consume, "");
    const results = await Promise.all(children.map(c => c.done));
    expect(results.filter(c => c.status === 0)).toHaveLength(1);
    expect(results.filter(c => c.stdout.includes("keeper-ready:"))).toHaveLength(1);
    expect(existsSync(join(r.lock, "claim"))).toBe(true); expect(existsSync(join(r.lock, "receipt"))).toBe(false);
  });
  // T17 red on rev 4: it lacks the required serialized detachment and exact-owner release property.
  it("T17 required property: two breakers serialize and a delayed A release cannot remove B", async () => {
    const r = rig(), a = token(), b = token();
    expect(r.run("acquire", a).status).toBe(0);
    const gate = join(r.base, "break-go");
    // Both breakers reach a barrier before using the same persistent mutex.
    const breakers = [0, 1].map(i => background(["-c",
      'touch "$1"; while [ ! -f "$2" ]; do sleep 0.01; done; shift 2; exec bash "$@"', "barrier",
      join(r.base, "breaker-" + i), gate, ...r.args("break")], r.env(token(), { SMOOTH_BREAK_LOCK: a })));
    await Promise.all([0, 1].map(i => waitForFile(join(r.base, "breaker-" + i)))); writeFileSync(gate, "");
    const broken = await Promise.all(breakers.map(c => c.done));
    expect(broken.filter(c => c.status === 0)).toHaveLength(1);
    expect(r.run("acquire", b).status).toBe(0);
    const ownerB = readFileSync(join(r.lock, "owner"), "utf8");
    const releaseGate = join(r.base, "release-go"), ready = join(r.base, "release-ready");
    const delayed = background(["-c", 'touch "$1"; while [ ! -f "$2" ]; do sleep 0.01; done; shift 2; exec bash "$@"',
      "barrier", ready, releaseGate, ...r.args("release")], r.env(a));
    await waitForFile(ready); writeFileSync(releaseGate, "");
    expect((await delayed.done).status).not.toBe(0);
    expect(r.run("break", token(), { SMOOTH_BREAK_LOCK: a }).status).not.toBe(0);
    expect(readFileSync(join(r.lock, "owner"), "utf8")).toBe(ownerB);
  });
});

describe("rev 6 journal and selection", () => {
  const archive = files => {
    const base = fresh(), out = join(base, "lane/out"), root = join(base, "host/logs");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
    const result = sh([KEEP, out, root, "run", process.execPath]);
    return { base, out, root, result, read: name => readFileSync(join(root, "run", name), "utf8") };
  };
  // T6 red on rev 4: awk cannot scrub accounting in decoded JSON string values.
  it("T6 scrubs encoded quoted accounting", () => {
    const a = archive({ "failed-turns-a.jsonl": JSON.stringify({ error: 'usage="SECRET" tail' }) + "\n" });
    expect(a.result.status, a.result.stderr).toBe(0); expect(JSON.parse(a.read("failed-turns-a.jsonl"))).toEqual({ error: 'usage="x" tail' });
  });
  // T7 red on rev 4: replacing a scalar inside encoded JSON makes invalid JSON.
  it("T7 scalar accounting remains valid JSON", () => {
    const a = archive({ "failed-turns-a.jsonl": JSON.stringify({ error: "usage=777 tail" }) + "\n" });
    expect(a.result.status).toBe(0); expect(JSON.parse(a.read("failed-turns-a.jsonl")).error).toBe('usage="x" tail');
  });
  // T8 red on rev 4: a brace-shaped malformed journal is accepted.
  it.each(["{not JSON}\n", "{}\n\n{}\n"])("T8 malformed journal %j retains originals", text => {
    const a = archive({ "failed-turns-a.jsonl": text });
    expect(a.result.status).toBe(4); expect(readdirSync(a.root)).toEqual([]);
    expect(readFileSync(join(a.out, "failed-turns-a.jsonl"), "utf8")).toBe(text);
  });
  // T9 red on rev 4: awk does not recognize all whole-file whitespace boundaries.
  it("T9 whole-file newline, vertical-tab and form-feed accounting", () => {
    const a = archive({ "server-a.log": "usage\n=SECRET\ntokens\v=SECRET\ncost\f=SECRET\n" });
    expect(a.result.status).toBe(0); expect(a.read("server-a.log")).not.toContain("SECRET");
  });
  // T20 red on rev 4: escaped nested keys leak and non-object records pass incomplete validation.
  it("T20 recursively scrubs decoded keys, arrays and prototype-shaped data", () => {
    const a = archive({ "failed-turns-a.jsonl": '{"nested":[{"us\\u0061ge":{"secret":777},"__proto__":{"cost":888},"usage=SECRET tail":"value"}]}\n' });
    expect(a.result.status).toBe(0);
    const value = JSON.parse(a.read("failed-turns-a.jsonl")).nested[0];
    expect(value.usage).toBe("x"); expect(value.__proto__.cost).toBe("x"); expect(value['usage="x" tail']).toBe("value");
  });
  // T20 red on rev 4: it lacks parsed object and transformed-key collision checks.
  it.each(["null", "5", "true", "[]", '{"usage=1":"a","usage=2":"b"}'])("T20 rejects %s without publication", text => {
    const a = archive({ "failed-turns-a.jsonl": text + "\n" });
    expect(a.result.status).toBe(4); expect(readdirSync(a.root)).toEqual([]);
    expect(readFileSync(join(a.out, "failed-turns-a.jsonl"), "utf8")).toBe(text + "\n");
  });
  // F1 fails on 90b8e01c6: the keeper scrubs a production cut marker into "x".
  it("T21 archives the marker generated from malformed accounting, then revalidates it", () => {
    const malformed = 'usage="' + "SECRET".repeat(100);
    const generated = scrubCore(malformed);
    expect(generated).toBe("usage=[accounting value cut]");
    expect(safeAccounting(generated)).toBe(true);
    for (const error of [malformed, scrubAccounting(malformed)]) {
      const a = archive({ "failed-turns-a.jsonl": JSON.stringify({ error }) + "\n" });
      expect(a.result.status).toBe(0); expect(JSON.parse(a.read("failed-turns-a.jsonl")).error).toBe(generated);
    }
  });
  // T22 red on rev 4: both host paths use awk rather than an explicit Node executable.
  it("T22 explicit Node is required independently of PATH", () => {
    const r = rig();
    expect(r.run("archive", token(), { SMOOTH_NODE: join(r.base, "missing") }).status).toBe(4);
    expect(r.archives()).toEqual([]);
    const real = readFileSync(dir("./real-smooth.sh"), "utf8");
    expect(real.match(/bash "\$KEEP"[^\n]*"\$R\/node\/bin\/node"/g)).toHaveLength(2);
    expect(real.indexOf('"orphan-$RUN_ID" "$R/node/bin/node"')).toBeLessThan(real.indexOf('export PATH='));
  });
  // T23 red on rev 4: snapshot and keeper select different files and follow matching symlinks.
  it("T23 rejects selected symlinks and hashes newline names and non-log evidence", () => {
    const r = rig(), out = join(r.base, "lane/out");
    symlinkSync(join(out, "server-lab.log"), join(out, "server-link.log"));
    expect(r.run("prepare").status).toBe(4); expect(r.archives()).toEqual([]);
    rmSync(join(out, "server-link.log")); writeFileSync(join(out, "gate-a\nb.md"), "one");
    expect(r.run("prepare").status).toBe(0);
    writeFileSync(join(out, "gate-a\nb.md"), "two");
    expect(r.run("present").status).toBe(0); expect(r.archives()).toHaveLength(2);
  });
});

function launcherFixture() {
  const base = fresh(), host = join(base, "host"), lane = join(host, "smooth-lab"), source = join(base, "source"), nm = join(base, "nm");
  for (const path of [join(lane, "src"), join(lane, "out"), source, join(nm, "node_modules/.pnpm")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(nm, "pnpm-lock.yaml"), "lock");
  writeFileSync(join(lane, "out/server-lab.log"), "evidence");
  writeFileSync(join(lane, "out/failed-turns-lab.jsonl"), JSON.stringify({ error: 'usage="SECRET"', nested: { cost: 777 } }) + "\n");
  executable(base, "git", 'case "$*" in *--show-toplevel*) echo "$TEST_BASE" ;; *) echo 0123456789ab ;; esac');
  executable(base, "shasum", 'shift 2; exec sha256sum "$@"');
  executable(base, "ssh", 'while [[ "$1" = -* ]]; do shift 2; done; shift; exec bash -c "$*"');
  executable(base, "chown", "exit 0");
  executable(base, "setsid", 'printf "%s\\n" "$*" >> "$TEST_BASE/background"; exit 0');
  const sync = executable(base, "sync-tree", 'mkdir -p "$3"; printf lock > "$3/pnpm-lock.yaml"');
  writeFileSync(join(base, "run-count"), "0");
  executable(base, "docker", `
printf '%s\\n' "$*" >> "$TEST_BASE/docker.calls"
case "$1" in
  ps) exit 0 ;;
  run) count=$(cat "$TEST_BASE/run-count"); count=$((count + 1)); echo "$count" > "$TEST_BASE/run-count"; touch "$TEST_BASE/started"; printf '%064d\\n' "$count" ;;
  inspect) echo 'No such object' >&2; exit 1 ;;
  *) exit 0 ;;
esac`);
  const env = { ...process.env, TEST_BASE: base, PATH: join(base, "bin") + ":" + process.env.PATH,
    TMPDIR: join(base, "tmp"), SMOOTH_HOST_ROOT: host, SMOOTH_SOURCE: source, NODE_MODULES_FROM: nm,
    SMOOTH_SYNC: sync, SMOOTH_NODE: process.execPath };
  // The hz contract is /usr/local/bin/node; fake SSH maps that explicit host path to this test's Node.
  executable(base, "ssh", 'while [[ "$1" = -* ]]; do shift 2; done; shift; host_node=/usr/local/bin/node; command=${*//"$host_node"/$TEST_NODE}; old_root=/srv/murage-smooth; command=${command//"$old_root"/$TEST_HOST}; exec bash -c "$command"');
  env.TEST_NODE = process.execPath; env.TEST_HOST = host;
  const launch = extra => {
    const shell = spawnSync("zsh", ["--version"], { env, encoding: "utf8" });
    expect(shell.status, "hz requires zsh on PATH").toBe(0);
    return spawnSync("zsh", [HZ, "lab", REV], { env: { ...env, ...extra }, encoding: "utf8", timeout: 20_000 });
  };
  return { base, host, lane, env, launch };
}

describe("rev 6 launcher identity", () => {
  // T1 red on rev 4: a refused launch releases another invocation's lock in its EXIT trap.
  it("T1 the real launcher through fake SSH cannot release A when B is refused", () => {
    const f = launcherFixture(), lock = join(f.host, "smoothness/locks/lab.d");
    mkdirSync(lock, { recursive: true }); const owner = `v1 active ${P} ${token()} ${REV} 2026-11-07T00:00:00Z\n`;
    writeFileSync(join(lock, "owner"), owner);
    const result = f.launch();
    expect(result.status, result.stderr).toBe(3);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(owner);
    expect(existsSync(join(f.base, "docker.calls"))).toBe(false);
  });
  // T19 red on rev 4: docker's returned ID is discarded and SMOOTH_RUN_ID is not passed.
  it("T19 launch publishes the captured ID and common run ID before follower handoff", async () => {
    const f = launcherFixture(), result = f.launch();
    expect(result.status, result.stderr).toBe(0);
    const [runId, cid, owner] = readFileSync(join(f.lane, "run.id"), "utf8").trim().split("/");
    expect(cid).toBe("1".padStart(64, "0")); expect(owner).toMatch(/^[a-f0-9]{32}$/);
    expect(readFileSync(join(f.base, "docker.calls"), "utf8")).toContain("SMOOTH_RUN_ID=" + runId);
    await waitForFile(join(f.base, "background"));
    expect(readFileSync(join(f.base, "background"), "utf8")).toContain(runId + " " + cid + " " + owner);
  });
  // T19 red on rev 4: there is no checked run.id publication before handoff.
  it("T19 publication failure retains ownership and data without starting a follower", () => {
    const f = launcherFixture();
    executable(f.base, "mv", 'case "$*" in *run.id*) exit 1 ;; esac; exec /bin/mv "$@"');
    const result = f.launch();
    expect(result.status).not.toBe(0); expect(existsSync(join(f.lane, "data"))).toBe(true);
    expect(existsSync(join(f.host, "smoothness/locks/lab.d/owner"))).toBe(true);
    expect(existsSync(join(f.base, "background"))).toBe(false);
  });
});

function followerFixture(options = {}) {
  const r = rig(), cid = "1".padStart(64, "0"), owner = token(), runId = "run-" + owner;
  const lane = join(r.base, "lane"), runtime = join(r.base, "runtime");
  mkdirSync(runtime); mkdirSync(join(lane, "data"));
  writeFileSync(join(lane, "data/keep"), "data");
  for (const name of [...names, "stage-keeper.sh", "follow-run.sh"]) writeFileSync(join(runtime, name), readFileSync(dir("./" + name)));
  writeFileSync(join(lane, "run.id"), `${runId}/${cid}/${owner}\n`);
  executable(r.base, "docker", `
printf '%s\\n' "$*" >> "$TEST_BASE/docker.calls"
case "$1" in
  logs) echo gate; exit 0 ;;
  rm) [ "${options.rmFailure ? "yes" : "no"}" = no ] || exit 1; touch "$TEST_BASE/gone"; exit 0 ;;
  inspect)
    if [ -f "$TEST_BASE/gone" ] || [ "${options.absent ? "yes" : "no"}" = yes ]; then echo 'No such object' >&2; exit 1; fi
    case "$3" in
      *Id*) echo "${options.other ? "2".repeat(64) : cid}" ;;
      *) ${options.unknown ? "echo denied >&2; exit 1" : "echo " + (options.live ? "true" : "false")} ;;
    esac ;;
esac`);
  const run = (overrides = {}) => sh([dir("./follow-run.sh"), lane, join(r.base, "host"), "lab", REV, hash, runId, cid, owner, runtime],
    { env: r.env(token(), overrides) });
  return { ...r, lane, runtime, runId, cid, owner, follow: run };
}
describe("rev 6 follower refusal", () => {
  // T4 red on rev 4: an old follower ignores the newer run.id and operates on shared evidence.
  it("T4 a stale follower refuses before shared reads or stress access", () => {
    const r = followerFixture(); writeFileSync(join(r.lane, "run.id"), "newer/run/owner\n");
    writeFileSync(join(r.lane, "stress.pid"), "invalid; must never be read");
    expect(r.follow().status).toBe(4);
    expect(readFileSync(join(r.base, "docker.calls"), "utf8")).not.toContain("inspect");
    expect(r.archives()).toEqual([]); expect(readFileSync(join(r.lane, "data/keep"), "utf8")).toBe("data");
  });
  // T18 red on rev 4: disconnected logs and failed removal still authorize data deletion.
  it.each([{ live: true }, { unknown: true }, { other: true }, { rmFailure: true }, { keeperFailure: true }, { gateFailure: true }])(
    "T18 refuses cleanup for %j", options => {
      const r = followerFixture(options);
      if (options.keeperFailure) writeFileSync(join(r.lane, "out/failed-turns-a.jsonl"), "{not JSON}\n");
      if (options.gateFailure) executable(r.base, "cp", "exit 1");
      expect(r.follow().status).toBe(4);
      expect(readFileSync(join(r.lane, "data/keep"), "utf8")).toBe("data");
      if (options.live || options.unknown || options.other || options.keeperFailure || options.gateFailure)
        expect(readFileSync(join(r.base, "docker.calls"), "utf8")).not.toContain("\nrm ");
    });
  // G26 guard: repeated labels must preserve distinct archive and follower identities.
  it("G26 repeated labels retain distinct archives and refuse the prior run's follower", () => {
    const r = followerFixture();
    expect(r.follow().status).toBe(0);
    expect(r.archives()).toEqual([r.runId]); expect(existsSync(join(r.lane, "data"))).toBe(false);
    mkdirSync(join(r.lane, "data")); writeFileSync(join(r.lane, "data/keep"), "second run");
    writeFileSync(join(r.lane, "run.id"), "new-run/new-container/new-owner\n");
    expect(r.follow().status).toBe(4);
    expect(readFileSync(join(r.lane, "data/keep"), "utf8")).toBe("second run");
    expect(r.archives()).toEqual([r.runId]);
  });
});

function tarFixture(entries) {
  const parts = [];
  for (const [name, bytes = Buffer.from("extra"), type = "0", link = ""] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.fill(32, 148, 156); h.write(type, 156); h.write(link, 157, 100);
    h.write("ustar\0", 257); h.write("00", 263);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
// T13 red on rev 4: valid tar passes its hash check but is executed as a shell script.
it("T13 valid bundle archives; extra, changed, link, traversal, duplicate and missing entries refuse", () => {
  const legacy = !readFileSync(STAGER, "utf8").includes("bundle.tar");
  const control = rig(), trusted = bundle();
  const args = control.args("archive"); args[4] = legacy ? digest(trusted) : hash;
  const accepted = sh(args, { input: trusted, env: control.env(token()) });
  expect(accepted.status, accepted.stderr).toBe(0); expect(control.archives()).toHaveLength(1);
  const entries = names.map(n => [n, readFileSync(dir("./" + n))]);
  for (const variant of [
    [...entries, ["extra"]], entries.map(([n, b], i) => [n, i ? b : Buffer.concat([b, Buffer.from("# changed\n")])]),
    entries.map(([n, b], i) => i ? [n, b] : [n, Buffer.alloc(0), "2", "/outside"]),
    [...entries, ["../escape"]], [...entries, entries[0]], entries.slice(1),
  ]) {
    const r = rig(), bytes = tarFixture(variant);
    const failed = r.run("archive", token(), {}, bytes);
    expect(failed.status).toBe(4); expect(r.archives()).toEqual([]);
    expect(readFileSync(join(r.base, "lane/out/server-lab.log"), "utf8")).toContain("777");
  }
});

// G24 guard: injected failures must preserve privacy, cleanup and status precedence.
describe("G24 private stages and signal cleanup", () => {
  it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 143]])("G24 %s cleans its stage and preserves unrelated data", async (signal, code) => {
    const r = rig(), entered = join(r.base, "entered"), go = join(r.base, "go");
    executable(r.base, "docker", 'touch "$TEST_BASE/entered"; while [ ! -f "$TEST_BASE/go" ]; do sleep 0.01; done; echo false');
    const child = background(r.args("archive"), r.env(token()), bundle());
    await waitForFile(entered);
    const stages = readdirSync(join(r.base, "tmp")); expect(stages).toHaveLength(1);
    expect(statSync(join(r.base, "tmp", stages[0])).mode & 0o777).toBe(0o700);
    child.p.kill(signal); writeFileSync(go, "");
    expect((await child.done).status).toBe(code);
    expect(readdirSync(join(r.base, "tmp"))).toEqual([]);
    expect(readFileSync(join(r.base, "lane/out/server-lab.log"), "utf8")).toContain("777");
  });
  it("G24 published archive and manifest stay private", () => {
    const r = rig(); expect(r.run("archive").status).toBe(0);
    const archive = join(r.base, "host/smoothness/logs", r.archives()[0]);
    expect(statSync(archive).mode & 0o777).toBe(0o700);
    expect(statSync(join(archive, "manifest.json")).mode & 0o777).toBe(0o600);
  });
});

// G24 guard: fault injection must work even when the test process is root.
it.each(["copy", "serialize", "manifest", "publish"])("G24 %s failure publishes nothing and retains the input", fault => {
  const r = rig(), out = join(r.base, "lane/out"), root = join(r.base, "host/logs");
  writeFileSync(join(out, "results-a.json"), "{}");
  const hook = join(r.base, "fault.mjs");
  writeFileSync(hook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync, rename = fs.renameSync, stringify = JSON.stringify;
fs.writeFileSync = function(path, ...args) {
 const name = String(path);
 if ((${JSON.stringify(fault)} === 'copy' && name.includes('/archive/') && name.endsWith('results-a.json')) ||
     (${JSON.stringify(fault)} === 'manifest' && name.endsWith('manifest.json'))) throw Error('injected write');
 return write.call(this, path, ...args);
};
fs.renameSync = function(...args) { if (${JSON.stringify(fault)} === 'publish') throw Error('injected publish'); return rename.apply(this, args); };
JSON.stringify = function(value, ...args) { if (${JSON.stringify(fault)} === 'serialize' && value?.version === 2) throw Error('injected serialize'); return stringify(value, ...args); };
syncBuiltinESMExports();`);
  const result = sh([KEEP, out, root, "run", process.execPath], { env: { NODE_OPTIONS: `--import=${hook}` } });
  expect(result.status).toBe(4); expect(readdirSync(root)).toEqual([]);
  expect(readFileSync(join(out, "results-a.json"), "utf8")).toBe("{}");
});

// T22 red on rev 4: real orphan preservation runs awk before Node is added to PATH.
it("T22 real launcher uses its explicit Node for orphan journals before PATH setup", () => {
  const base = fresh(), real = join(base, "real"), out = join(real, "out"), logs = join(base, "logs");
  for (const path of [out, join(real, "node/bin"), join(real, "src/node_modules/.pnpm"), join(real, "src/scripts/smoothness")]) mkdirSync(path, { recursive: true });
  for (const name of names) writeFileSync(join(real, "src/scripts/smoothness", name), readFileSync(dir("./" + name)));
  const input = JSON.stringify({ error: 'usage="SECRET"', nested: { cost: 777 } }) + "\n";
  writeFileSync(join(out, "failed-turns-a.jsonl"), input);
  const node = join(real, "node/bin/node");
  writeFileSync(node, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TEST_BASE/node.calls"\ncase "$1" in *keep-logs.mjs) exec "$TEST_NODE" "$@" ;; *) exit 1 ;; esac\n`); chmodSync(node, 0o755);
  executable(base, "id", 'if [ "$1" = -un ]; then echo engine; else echo 2001; fi');
  executable(base, "pgrep", "exit 1");
  const env = { ...process.env, TEST_BASE: base, TEST_NODE: process.execPath, SMOOTH_REAL_DIR: real, SMOOTH_LOGS: logs, PATH: join(base, "bin") + ":" + process.env.PATH };
  sh([dir("./real-smooth.sh"), "lab"], { env });
  const orphan = readdirSync(logs).find(name => name.startsWith("orphan-")); expect(orphan).toBeTruthy();
  const record = JSON.parse(readFileSync(join(logs, orphan, "failed-turns-a.jsonl"), "utf8"));
  expect(record).toEqual({ error: 'usage="x"', nested: { cost: "x" } });
  expect(readFileSync(join(base, "node.calls"), "utf8").split("\n")[0]).toContain("keep-logs.mjs");
});

// G26 guard: exercise real launcher rotation, two followers and verified stress identities with one label.
it("G26 repeated-label launcher and follower lifecycle isolates journals, run IDs and stress", async () => {
  const f = launcherFixture(), dockerPath = join(f.base, "bin/docker"), launchDocker = readFileSync(dockerPath, "utf8");
  const seen = [];
  for (let round = 0; round < 2; round++) {
    writeFileSync(dockerPath, launchDocker);
    const launched = f.launch(); expect(launched.status, launched.stderr).toBe(0);
    const [runId, cid, owner] = readFileSync(join(f.lane, "run.id"), "utf8").trim().split("/");
    expect(seen).not.toContain(runId); seen.push(runId);
    if (round) expect(readdirSync(join(f.lane, "out")).some(name => name.startsWith("failed-turns-lab.jsonl.rotated-"))).toBe(true);
    writeFileSync(join(f.lane, "out/failed-turns-lab.jsonl"), JSON.stringify({ runId, error: "usage=777" }) + "\n");
    const stress = spawn("sleep", ["60"], { stdio: "pipe" });
    const stopped = new Promise(resolve => stress.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const stat = readFileSync(`/proc/${stress.pid}/stat`, "utf8"), start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
      writeFileSync(join(f.lane, "stress.pid"), `${runId} ${stress.pid} ${start}\n`);
      rmSync(join(f.base, "gone"), { force: true });
      executable(f.base, "docker", `case "$1" in
logs) echo gate ;;
rm) touch "$TEST_BASE/gone" ;;
inspect) if [ -f "$TEST_BASE/gone" ]; then echo 'No such object' >&2; exit 1; fi; case "$3" in *Id*) echo ${cid} ;; *) echo false ;; esac ;;
esac`);
      const runtime = join(f.host, "smoothness/runs", owner);
      const result = sh([dir("./follow-run.sh"), f.lane, f.host, "lab", REV, hash, runId, cid, owner, runtime], { env: { ...f.env, SMOOTH_NODE: process.execPath } });
      expect(result.status, result.stderr).toBe(0);
      expect((await stopped).signal).toBe("SIGTERM");
      const archived = JSON.parse(readFileSync(join(f.host, "smoothness/logs", runId, "failed-turns-lab.jsonl"), "utf8"));
      expect(archived).toEqual({ runId, error: 'usage="x"' });
      expect(existsSync(join(f.lane, "data"))).toBe(false);
    } finally { stress.kill("SIGTERM"); }
  }
  expect(seen[0]).not.toBe(seen[1]);
});

// G24 guard: physical overlap must reject a symlinked temporary root before inspection.
it("G24 resolves physical overlap in a symlinked TMPDIR", () => {
  const r = rig(), alias = join(r.base, "alias"); symlinkSync(join(r.base, "lane"), alias);
  const result = r.run("archive", token(), { TMPDIR: alias });
  expect(result.status).toBe(4); expect(result.stderr).toContain("overlaps");
  expect(existsSync(join(r.base, "docker.calls"))).toBe(false);
  expect(readdirSync(join(r.base, "lane")).some(name => name.startsWith("murage-keeper."))).toBe(false);
});

// T23 red on rev 4: receipt snapshots cover neither results nor recursive debug evidence.
it.each(["results-a.json", "gate-a b.md", "verdict-a.json", "debug/nested/event.jsonl"])("T23 receipt binds changed %s bytes", name => {
  const r = rig(), path = join(r.base, "lane/out", name);
  if (name.startsWith("debug/")) mkdirSync(join(r.base, "lane/out/debug/nested"), { recursive: true });
  writeFileSync(path, "one"); expect(r.run("prepare").status).toBe(0);
  const old = statSync(path); writeFileSync(path, "two"); utimesSync(path, old.atime, old.mtime);
  expect(r.run("present").status).toBe(0); expect(r.archives()).toHaveLength(2);
});

// T22 red on rev 4: hz preservation cannot scrub the same decoded journal fixture as the real Node path.
it("T22 hz explicit Node archives the shared encoded-key journal fixture", () => {
  const f = launcherFixture(), result = f.launch(); expect(result.status, result.stderr).toBe(0);
  const logs = join(f.host, "smoothness/logs"), orphan = readdirSync(logs).find(name => name.startsWith("orphan-"));
  expect(JSON.parse(readFileSync(join(logs, orphan, "failed-turns-lab.jsonl"), "utf8"))).toEqual({ error: 'usage="x"', nested: { cost: "x" } });
});

// T23 red on rev 4: newline and space filenames are encoded with ambiguous metadata lines.
it("T23 raw filename tuples distinguish a space from a newline with identical bytes", () => {
  const r = rig(), out = join(r.base, "lane/out"), space = join(out, "server-a b.log"), newline = join(out, "server-a\nb.log");
  writeFileSync(space, "same bytes"); expect(r.run("prepare").status).toBe(0);
  renameSync(space, newline); expect(r.run("present").status).toBe(0); expect(r.archives()).toHaveLength(2);
});

// T18 red on rev 4: a follower has no ownership timeout or verified stress identity refusal.
it("T18 ownership timeout and wrong stress identity retain all working data", () => {
  const busy = followerFixture(); expect(busy.run("acquire").status).toBe(0);
  const timeout = busy.follow({ SMOOTH_FOLLOW_WAIT_SECONDS: "0" });
  expect(timeout.status).toBe(4); expect(timeout.stderr).toContain("timeout");
  expect(readFileSync(join(busy.lane, "data/keep"), "utf8")).toBe("data");
  const wrong = followerFixture();
  writeFileSync(join(wrong.lane, "stress.pid"), `${wrong.runId} ${process.pid} 0\n`);
  expect(wrong.follow().status).toBe(4); expect(wrong.archives()).toEqual([]);
  expect(readFileSync(join(wrong.lane, "data/keep"), "utf8")).toBe("data");
});
// T18 red on rev 4: a failed idempotent removal is ignored when the container is gone.
it.each([false, true])("T18 already-gone container requires successful removal (%s)", rmFailure => {
  const r = followerFixture({ absent: true, rmFailure });
  expect(r.follow().status).toBe(rmFailure ? 4 : 0);
  expect(existsSync(join(r.lane, "data"))).toBe(rmFailure);
});

// F4 fails on 90b8e01c6: real-smooth ignores the lane owner and never publishes run.id.
it("F4 real launcher obeys the shared lane lock and publishes its owner identity", () => {
  const r = rig(), base = r.base, lane = join(base, "lane"), owner = token();
  for (const path of ["src/node_modules/.pnpm", "src/scripts/smoothness", "node/bin", "data"]) mkdirSync(join(lane, path), { recursive: true });
  for (const name of [...names, "stage-keeper.sh"]) writeFileSync(join(lane, "src/scripts/smoothness", name), readFileSync(dir("./" + name)));
  writeFileSync(join(lane, "data/sentinel"), "untouched");
  executable(base, "id", 'echo muragegate');
  executable(base, "pgrep", 'exit 1');
  executable(base, "git", 'echo 0123456789ab');
  const node = executable(base, "fixture-node", `
case "$1" in
  scripts/smoothness/smooth.mjs)
    cp "$SMOOTH_REAL_DIR/run.id" "$TEST_BASE/observed-run.id" || exit 9
    key=$(printf '%s' "$SMOOTH_REAL_DIR" | sha256sum); key=real-\${key:0:16}
    cp "$SMOOTH_HOST_ROOT/smoothness/locks/$key.d/owner" "$TEST_BASE/observed-owner" || exit 9
    printf '%s' "$SMOOTH_RUN_ID" > "$TEST_BASE/observed-env"
    printf evidence > "$SMOOTH_OUT/server-lab.log"
    exit 0 ;;
  scripts/smoothness/smooth-gate.mjs) exit 0 ;;
  *) exec "$TEST_NODE" "$@" ;;
esac`);
  symlinkSync(node, join(lane, "node/bin/node"));
  const launch = () => sh([dir("./real-smooth.sh"), "lab"], { env: { ...r.env(token()),
    SMOOTH_REAL_DIR: lane, SMOOTH_HOST_ROOT: join(base, "host"), SMOOTH_LOGS: join(base, "host/smoothness/logs"),
    SMOOTH_CTL: join(base, "ctl"), TEST_NODE: process.execPath } });
  expect(r.run("acquire", owner).status).toBe(0);
  const before = readFileSync(join(r.lock, "owner"), "utf8");
  const blocked = launch();
  expect(blocked.status, blocked.stderr).toBe(3);
  expect(readFileSync(join(r.lock, "owner"), "utf8")).toBe(before);
  expect(readFileSync(join(lane, "data/sentinel"), "utf8")).toBe("untouched");
  expect(existsSync(join(base, "observed-run.id"))).toBe(false);
  expect(r.run("release", owner).status).toBe(0);
  const started = launch();
  expect(started.status, started.stderr).toBe(0);
  const identity = readFileSync(join(lane, "run.id"), "utf8");
  expect(identity).toBe(readFileSync(join(base, "observed-run.id"), "utf8"));
  const [runId, processId, active] = identity.trim().split("/");
  expect(runId).toBe(readFileSync(join(base, "observed-env"), "utf8"));
  expect(processId).toMatch(/^pid-[0-9]+-[0-9]+$/);
  expect(active).toMatch(/^[a-f0-9]{32}$/);
  expect(readFileSync(join(base, "observed-owner"), "utf8").split(" ")[3]).toBe(active);
  expect(existsSync(r.lock)).toBe(false);
});

function realLockFixture() {
  const base = fresh(), home = join(base, "home"), real = join(home, "smooth-real"), host = join(home, "smoothness");
  for (const p of ["src/node_modules/.pnpm", "src/scripts/smoothness", "node/bin", "out", "data"]) mkdirSync(join(real, p), { recursive: true });
  for (const n of [...names, "stage-keeper.sh"]) writeFileSync(join(real, "src/scripts/smoothness", n), readFileSync(dir("./" + n)));
  writeFileSync(join(real, "src/.smooth-sha"), REV);
  executable(base, "id", 'echo muragegate');
  // Intercept the legacy absolute cleanup without ever touching a shared /tmp path.
  executable(base, "rm", 'for p in "$@"; do if [ "$p" = /tmp/smooth-ctl-real/prompts ]; then touch "$TEST_BASE/default-touched"; exit 0; fi; done; exec /bin/rm "$@"');
  const node = executable(base, "fixture-node", `case "$1" in
scripts/smoothness/smooth.mjs) touch "$TEST_BASE/entered"; while [ "$SMOOTH_LABEL" = first ] && [ -f "$TEST_BASE/hold" ]; do sleep 0.01; done; echo evidence > "$SMOOTH_OUT/server-lab.log" ;;
scripts/smoothness/smooth-gate.mjs) exit 0 ;;
*) exec "$TEST_NODE" "$@" ;;
esac`);
  symlinkSync(node, join(real, "node/bin/node"));
  const env = { ...process.env, HOME: home, TEST_BASE: base, TEST_NODE: process.execPath, TMPDIR: join(base, "tmp"), PATH: join(base, "bin") + ":" + process.env.PATH };
  for (const key of Object.keys(env)) if (key.startsWith("SMOOTH_")) delete env[key];
  const key = "real-" + digest(real).slice(0, 16), locks = join(host, "smoothness/locks"), lock = join(locks, key + ".d");
  const launch = (label = "first", extra = {}) => sh([dir("./real-smooth.sh"), label], { env: { ...env, ...extra } });
  return { base, home, real, host, env, key, locks, lock, launch };
}

// T-L1 red on 96f4301e5: different labels acquire different locks and erase the active run's files (L1/L2).
it("T-L1 cross-label launch preserves all active run files", async () => {
  const f = realLockFixture(); writeFileSync(join(f.base, "hold"), "");
  const env = { ...f.env, SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: join(f.base, "ctl") };
  const a = background([dir("./real-smooth.sh"), "first"], env);
  try {
    await waitForFile(join(f.base, "entered"));
    for (const p of ["data/sentinel", "out/sentinel"]) writeFileSync(join(f.real, p), p);
    const files = ["data/sentinel", "out/sentinel", "run.id", "gate.log"], before = files.map(p => readFileSync(join(f.real, p), "utf8"));
    const hz = sh([STAGER, f.real, f.host, "hz-label", hash, join(f.real, "src"), REV, "acquire"],
      { env: { ...env, SMOOTH_OWNER: token(), SMOOTH_TXN: P } });
    expect(hz.status, hz.stderr).toBe(3);
    // A symlink spelling must identify the same canonical directory too.
    const alias = join(f.base, "alias"); symlinkSync(f.real, alias);
    const b = f.launch("second", { ...env, SMOOTH_REAL_DIR: alias });
    expect(b.status, b.stderr).toBe(3);
    expect(files.map(p => readFileSync(join(f.real, p), "utf8"))).toEqual(before);
  } finally { rmSync(join(f.base, "hold"), { force: true }); await a.done; }
});

// T-L3 red on 96f4301e5: the default root is /root despite requiring an engine user (L3).
it("T-L3 defaults use the engine user's private home", () => {
  const f = realLockFixture();
  // Fail closed before any attempted access to a non-private host root.
  executable(f.base, "mkdir", 'for p in "$@"; do case "$p" in /srv/murage-smooth*) exit 91 ;; esac; done; exec /bin/mkdir "$@"');
  const r = f.launch(); expect(r.status, r.stderr).toBe(0);
  expect(statSync(f.host).mode & 0o777).toBe(0o700);
  expect(existsSync(join(f.real, "run.id"))).toBe(true);
  executable(f.base, "id", 'echo root'); expect(f.launch().status).toBe(2);
});

// T-L4 red on 96f4301e5: TERM after child acquisition skips release because owned is still zero (L4).
it("T-L4 TERM in acquisition handoff releases by prewritten token", async () => {
  const f = realLockFixture(), stager = join(f.real, "src/scripts/smoothness/stage-keeper.sh");
  renameSync(stager, stager + ".real");
  writeFileSync(stager, `#!/bin/bash\nbash "${stager}.real" "$@" || exit $?\nif [ "$7" = acquire ]; then touch "$TEST_BASE/acquired"; while [ ! -f "$TEST_BASE/reply" ]; do sleep 0.01; done; fi\n`);
  const child = background([dir("./real-smooth.sh"), "first"], { ...f.env, SMOOTH_HOST_ROOT: f.host });
  try {
    await waitForFile(join(f.base, "acquired")); child.p.kill("SIGTERM"); writeFileSync(join(f.base, "reply"), "");
    expect((await child.done).status).toBe(143);
    expect(readdirSync(f.locks).filter(n => n.endsWith(".d"))).toEqual([]);
  } finally { writeFileSync(join(f.base, "reply"), ""); child.p.kill("SIGTERM"); await child.done; }
});

// T-L4 red on 96f4301e5: there is no checked dead-pid reclamation (L4, including live-pid refusal).
it("T-L4 only a verifiably dead recorded pid permits reclamation", () => {
  const f = realLockFixture(), owner = token(); mkdirSync(f.lock, { recursive: true });
  mkdirSync(join(f.locks, "owners"));
  const original = `v1 active ${P} ${owner} ${REV} 2026-11-07T00:00:00Z\n`;
  writeFileSync(join(f.lock, "owner"), original);
  writeFileSync(join(f.locks, "owners", owner), `${process.pid}\n`);
  const extra = { SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: join(f.base, "ctl") };
  expect(f.launch("first", extra).status).toBe(3);
  expect(readFileSync(join(f.lock, "owner"), "utf8")).toBe(original);
  const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }); expect(dead.status).toBe(0);
  expect(existsSync(`/proc/${dead.stdout.trim()}`)).toBe(false);
  writeFileSync(join(f.locks, "owners", owner), dead.stdout);
  const again = f.launch("first", extra); expect(again.status, again.stdout + again.stderr).toBe(0); expect(existsSync(f.lock)).toBe(false);
});

// T-L5 red on 96f4301e5: inherited prompts survive and the unrelated default path is removed (L5).
it("T-L5 custom control cleanup never targets default prompts", () => {
  const f = realLockFixture(), ctl = join(f.base, "custom-ctl"); mkdirSync(join(ctl, "prompts"), { recursive: true });
  writeFileSync(join(ctl, "prompts/sentinel"), "private");
  const r = f.launch("first", { SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: ctl }); expect(r.status, r.stderr).toBe(0);
  expect(existsSync(join(ctl, "prompts"))).toBe(false); expect(existsSync(join(f.base, "default-touched"))).toBe(false);
});

// ---- relay 21 red-before tests (appended to keeper.test.mjs in an overlay copy; NOT in the rig commit yet) ----

// T-L1b red on 71a6038a4: the lock namespace lives under the caller-chosen host root, so a launcher or an hz label with a
// DIFFERENT host root takes a separate lock and erases the active run's files (Astra delta 2 finding 1).
it("T-L1b different host roots still exclude the same canonical directory", async () => {
  const f = realLockFixture(); writeFileSync(join(f.base, "hold"), "");
  const env = { ...f.env, SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: join(f.base, "ctl") };
  const otherHost = join(f.base, "other-host");
  const a = background([dir("./real-smooth.sh"), "first"], env);
  try {
    await waitForFile(join(f.base, "entered"));
    for (const p of ["data/sentinel", "out/sentinel"]) writeFileSync(join(f.real, p), p);
    const files = ["data/sentinel", "out/sentinel", "run.id", "gate.log"], before = files.map(p => readFileSync(join(f.real, p), "utf8"));
    // (1) the hz side with another host root
    mkdirSync(otherHost, { recursive: true });
    const hz = sh([STAGER, f.real, otherHost, "hz-label", hash, join(f.real, "src"), REV, "acquire"],
      { env: { ...env, SMOOTH_HOST_ROOT: otherHost, SMOOTH_OWNER: token(), SMOOTH_TXN: P } });
    expect(hz.status, "hz label with another host root: " + hz.stderr).toBe(3);
    // (2) a second real launcher with another host root
    const b = f.launch("second", { ...env, SMOOTH_HOST_ROOT: otherHost });
    expect(b.status, "real launcher with another host root: " + b.stderr).toBe(3);
    expect(files.map(p => readFileSync(join(f.real, p), "utf8"))).toEqual(before);
  } finally { rmSync(join(f.base, "hold"), { force: true }); await a.done; }
});

// T-L4b red on 71a6038a4: the owners marker is written (line 48) before the EXIT/INT/TERM/HUP traps (lines 57-59), and no
// lock exists yet, so a TERM in that window leaves the marker for good. The od shim fixes the owner token so the marker
// path is known; a FIFO at that path holds the launcher inside the marker write until the test sends TERM.
it("T-L4b TERM while the owners marker is being written leaves no marker behind", async () => {
  const f = realLockFixture();
  const O = "1".repeat(32), P2 = "2".repeat(32);
  executable(f.base, "od", `n=$(cat "$TEST_BASE/od.n" 2> /dev/null || echo 0); echo $((n+1)) > "$TEST_BASE/od.n"; if [ "$n" = 0 ]; then echo " ${"11 ".repeat(16)}"; else echo " ${"22 ".repeat(16)}"; fi`);
  const owners = join(f.locks, "owners"); mkdirSync(owners, { recursive: true });
  const marker = join(owners, O);
  expect(spawnSync("mkfifo", [marker]).status).toBe(0);
  const child = background([dir("./real-smooth.sh"), "first"], { ...f.env, SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: join(f.base, "ctl") });
  try {
    await new Promise(r => setTimeout(r, 700)); // the launcher is now blocked opening the FIFO
    child.p.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 300));
    const reader = spawn("timeout", ["3", "cat", marker], { stdio: "ignore" }); // lets a launcher that survived TERM go on
    await Promise.race([child.done, new Promise(r => setTimeout(r, 6000))]);
    reader.kill();
  } finally { child.p.kill("SIGKILL"); await child.done; }
  const left = spawnSync("find", [f.base, "-name", O], { encoding: "utf8" }).stdout.trim();
  expect(left, "marker left behind").toBe("");
});

// T-L1c red on fa8fefeba: the index's host-root line was read with default IFS, so a host root ending in a space was read back
// trimmed, pointed at a lock dir that does not exist, and a second launcher with another host root got in (Astra delta 3, High).
it("T-L1c a host root with a trailing space still excludes a launcher with another host root", async () => {
  const f = realLockFixture(); writeFileSync(join(f.base, "hold"), "");
  const spaced = join(f.base, "host spaced "); mkdirSync(spaced, { recursive: true });
  const env = { ...f.env, SMOOTH_HOST_ROOT: spaced, SMOOTH_CTL: join(f.base, "ctl") };
  const a = background([dir("./real-smooth.sh"), "first"], env);
  try {
    await waitForFile(join(f.base, "entered"));
    for (const p of ["data/sentinel", "out/sentinel"]) writeFileSync(join(f.real, p), p);
    const files = ["data/sentinel", "out/sentinel", "run.id", "gate.log"], before = files.map(p => readFileSync(join(f.real, p), "utf8"));
    const other = join(f.base, "other-host"); mkdirSync(other, { recursive: true });
    const b = f.launch("second", { ...env, SMOOTH_HOST_ROOT: other });
    expect(b.status, b.stderr).toBe(3);
    expect(files.map(p => readFileSync(join(f.real, p), "utf8"))).toEqual(before);
  } finally { rmSync(join(f.base, "hold"), { force: true }); await a.done; }
});

// T-L4c red on fa8fefeba: a real run that died under host root A (stale index, lock and dead-pid marker) blocked every launch under host
// root B for good; the dead owner is reclaimed across host roots, a live one is not (Codex round 4 delta 3, Medium).
it("T-L4c a verifiably dead owner under another host root is reclaimed, a live one is refused", () => {
  const f = realLockFixture(), owner = token(), hostA = join(f.base, "host-a"), locksA = join(hostA, "smoothness/locks");
  mkdirSync(join(f.real, ".lane-lock"), { recursive: true }); mkdirSync(join(locksA, "owners"), { recursive: true });
  mkdirSync(join(locksA, f.key + ".d"));
  const original = `v1 active ${P} ${owner} ${REV} 2026-11-07T00:00:00Z\n`;
  writeFileSync(join(locksA, f.key + ".d/owner"), original);
  writeFileSync(join(f.real, ".lane-lock/index"), `${f.key}\n${hostA}\n`);
  writeFileSync(join(locksA, "owners", owner), `${process.pid}\n`);
  const extra = { SMOOTH_HOST_ROOT: f.host, SMOOTH_CTL: join(f.base, "ctl") };
  expect(f.launch("first", extra).status).toBe(3);
  expect(readFileSync(join(locksA, f.key + ".d/owner"), "utf8")).toBe(original);
  const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }); expect(dead.status).toBe(0);
  expect(existsSync(`/proc/${dead.stdout.trim()}`)).toBe(false);
  writeFileSync(join(locksA, "owners", owner), dead.stdout);
  const again = f.launch("first", extra); expect(again.status, again.stdout + again.stderr).toBe(0);
  expect(existsSync(join(locksA, f.key + ".d"))).toBe(false);
});
