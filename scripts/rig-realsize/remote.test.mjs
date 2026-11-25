// Owner: rig-realsize lane. Witness for ASTRA 1549 (copy-back race in remote.sh) and FABLE 1551 Medium 1 (empty copy-back).
// At a152b4c3d0 remote.sh copied the host evidence into a staging dir, checked that <evidence-root>/<id> did not exist, then
// ran mv. If another run created that id between the check and the mv, mv put this run's dir INSIDE the other run's dir and
// remote.sh still reported this run's exit (RED, 1) while a replay of the id read the other run's sealed GREEN. Now the local
// run dir is made with a non-recursive mkdir (exists = refused, exit 2, nothing written into it), the files are copied into
// it and the seal comes last. This runs the real remote.sh (a byte copy, so its ROOT is a scratch checkout) with ssh, rsync,
// docker and sleep replaced by local stand-ins: the "rig host" is a local dir, the host commands run in a local shell.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { writeCleanRun } from "./fixture.mjs";
import * as V from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rig-remote-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const checkout = join(scratch, "checkout");
mkdirSync(join(checkout, "scripts", "rig-realsize"), { recursive: true });
copyFileSync(join(HERE, "remote.sh"), join(checkout, "scripts", "rig-realsize", "remote.sh"));
writeFileSync(join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

const bin = join(scratch, "bin");
mkdirSync(bin);
const tool = (name, text) => { writeFileSync(join(bin, name), text); chmodSync(join(bin, name), 0o755); };
// ssh: the last argument is the host command; run it here and log it
tool("ssh", `#!/bin/sh\neval "cmd=\\\${$#}"\nprintf '%s\\n' "$cmd" >> "$FAKE_LOG"\nexec sh -c "$cmd"\n`);
// docker run: the rig "runs" by copying the prepared run into the out mount under its id, then exits with the prepared code
tool("docker", `#!/bin/sh
case "$1" in
  run) out=; id=; for a; do case "$a" in *:/out) out=\${a%:/out} ;; RIG_RUN_ID=*) id=\${a#RIG_RUN_ID=} ;; esac; done
       [ -z "\${FAKE_RUN:-}" ] || cp -R "$FAKE_RUN" "$out/$id"; exit "\${FAKE_EXIT:-1}" ;;
  ps) echo running ;;
esac
exit 0
`);
tool("sleep", `#!/bin/sh\nPATH=$REAL_PATH exec sleep 0.05\n`);
// rsync: uploads (--files-from) are dropped; a copy-back strips "host:" and copies (dir/ = its contents, top-level --exclude)
tool("rsync", `#!/usr/bin/env node
const { appendFileSync, cpSync, existsSync } = require("node:fs");
const { basename, relative } = require("node:path");
const args = process.argv.slice(2), pos = [], exclude = [];
let upload = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-e") i++;
  else if (a.startsWith("--files-from=")) upload = true;
  else if (a.startsWith("--exclude=")) exclude.push(a.slice(10).replace(/^\\//, ""));
  else if (!a.startsWith("-")) pos.push(a);
}
if (upload) process.exit(0);
const src = pos[0].replace(/^[^/]*:/, ""), dst = pos[1];
appendFileSync(process.env.FAKE_LOG, "rsync " + JSON.stringify({ src: basename(src), exclude }) + "\\n");
if (!existsSync(src)) process.exit(23);
cpSync(src, dst, { recursive: true, filter: (p) => !exclude.includes(relative(src, p)) });
`);
// a concurrent creator: another run takes <root>/<id> just before this script's first mkdir or mv that names it
for (const name of ["mkdir", "mv"]) tool(name, `#!/bin/sh
if [ -n "\${RACE_TARGET:-}" ] && [ ! -e "$RACE_TARGET.raced" ]; then
  for a; do if [ "$a" = "$RACE_TARGET" ]; then : > "$RACE_TARGET.raced"; PATH=$REAL_PATH cp -R "$RACE_RUN" "$RACE_TARGET"; break; fi; done
fi
PATH=$REAL_PATH exec ${name} "$@"
`);

/** A sealed run with id runId, kept outside any evidence root as a template; GREEN or RED. */
function sealedRun(runId, red, seal = true) {
  const dir = V.openRun(mkdtempSync(join(scratch, "tpl-")), runId);
  writeCleanRun(dir, red ? (e) => ({ ...e, serverLog: `${e.serverLog}\n[mount-relay] mount unavailable mount="ops_metrics" cause=ipc` }) : undefined);
  if (seal) V.sealRun(dir, runId, V.verdictOfEvidence(dir).verdict);
  return dir;
}
/** One remote.sh run of id against a fresh local "host"; extra env sets the race and the prepared run. */
function remote(id, extra) {
  const t = mkdtempSync(join(scratch, "case-"));
  const out = join(t, "evidence"), host = join(t, "host"), log = join(t, "host.log");
  mkdirSync(join(host, "nm"), { recursive: true });
  const lock = spawnSync("sha256sum", [join(checkout, "pnpm-lock.yaml")], { encoding: "utf8" }).stdout.slice(0, 16);
  mkdirSync(join(host, "nm", lock, "node_modules"), { recursive: true });
  writeFileSync(log, "");
  const env = { PATH: `${bin}:${process.env.PATH}`, REAL_PATH: process.env.PATH, HOME: t, FAKE_LOG: log,
    RIG_HOST: "rig@rigbox", RIG_HOST_DIR: host, RIG_SSH_KEY: join(t, "key"), RIG_RUN_ID: id, ...extra({ out }) };
  const run = spawnSync("sh", [join(checkout, "scripts", "rig-realsize", "remote.sh"), out], { env, encoding: "utf8", timeout: 60_000 });
  return { exit: run.status, err: run.stderr, out, hostRun: join(host, "runs", id), log: readFileSync(log, "utf8") };
}
function replay(root, id) {
  const run = spawnSync(process.execPath, [join(HERE, "verdict.mjs"), root, id], { encoding: "utf8" });
  return { exit: run.status, verdict: /^RIG (\w+)/.exec(run.stdout)?.[1] ?? "none" };
}
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
  .map((d) => [join(d.parentPath, d.name).slice(dir.length), d.isFile() ? readFileSync(join(d.parentPath, d.name), "utf8") : "dir"]).sort());

it("another run taking the id during the copy-back: refused, exit 2, nothing written into that run, this run kept on the host", () => {
  const other = sealedRun("run-r", false);
  const r = remote("run-r", ({ out }) => ({ FAKE_RUN: sealedRun("run-r", true), FAKE_EXIT: "1", RACE_TARGET: join(out, "run-r"), RACE_RUN: other }));
  expect(existsSync(join(r.out, "run-r.raced"))).toBe(true); // the creator really ran
  expect(r.err).toContain("refused");
  expect(r.exit).toBe(2);
  // the other run's dir is exactly what it wrote: this run's evidence is not nested inside it
  expect(snapshot(join(r.out, "run-r"))).toEqual(snapshot(other));
  expect(replay(r.out, "run-r")).toMatchObject({ exit: 0, verdict: "GREEN" });
  expect(r.err).not.toContain("done exit");
  expect(existsSync(join(r.out, "run-r.rig-host-exit.txt"))).toBe(false);
  // this run's RED evidence is not lost: the host run dir stays
  expect(existsSync(join(r.hostRun, "out", "run-r", V.RUN_COMPLETE))).toBe(true);
  expect(r.log).not.toContain(`rm -rf ${r.hostRun}`);
});

it("an uncontested copy-back gives the run's own sealed verdict, and the seal is copied last, on its own", () => {
  const r = remote("run-ok", () => ({ FAKE_RUN: sealedRun("run-ok", true), FAKE_EXIT: "1" }));
  expect(r.exit).toBe(1);
  expect(replay(r.out, "run-ok")).toMatchObject({ exit: 1, verdict: "RED" });
  const copies = r.log.split("\n").filter((l) => l.startsWith("rsync ")).map((l) => JSON.parse(l.slice(6)));
  expect(copies).toEqual([{ src: "run-ok", exclude: [V.RUN_COMPLETE] }, { src: V.RUN_COMPLETE, exclude: [] }]);
  expect(readFileSync(join(r.out, "run-ok.rig-host-exit.txt"), "utf8").trim()).toBe("1");
  expect(existsSync(r.hostRun)).toBe(false);
});

it("a host exit 0 with no evidence dir for the run is exit 2, never 0, and leaves no local run dir", () => {
  const r = remote("run-empty", () => ({ FAKE_EXIT: "0" }));
  expect(r.exit).toBe(2);
  expect(existsSync(join(r.out, "run-empty"))).toBe(false);
  expect(replay(r.out, "run-empty")).toMatchObject({ exit: 2 });
});

it("a host exit 0 whose seal does not come back is exit 2, the local copy replays INVALID and the host run dir is kept", () => {
  const r = remote("run-noseal", () => ({ FAKE_RUN: sealedRun("run-noseal", false, false), FAKE_EXIT: "0" }));
  expect(r.err).toContain("could not copy the seal");
  expect(r.exit).toBe(2);
  expect(existsSync(join(r.out, "run-noseal", V.RUN_COMPLETE))).toBe(false);
  expect(replay(r.out, "run-noseal")).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(existsSync(join(r.hostRun, "out", "run-noseal"))).toBe(true);
});
