// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// J5: the restore ops alert must reach murage-control on a REAL Cloud home, where the server is the murage uid and /var/lib/murage-home is root 0700
// (murage-enroll private_directory) with a root events/ (murage-miner-watch write_event). The uid-split block runs only under
// deploy/cloud-home/qualify/home-events-uidsplit.sh (root prepares the dirs exactly as enroll / the watcher / the supervisor do, then this file runs as uid 2001).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_EVENTS_DIR_NAME, homeEventSpoolFailures, homeEventsDir, resetHomeEventSpoolFailuresForTest, spoolHomeEvent } from "../home-events.ts";
import { HOME_EVENTS_FOLDER, prepareHomeEventsDir } from "./home-volume-spec.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();
afterEach(() => { resetHomeEventSpoolFailuresForTest(); vi.restoreAllMocks(); });

describe("J5 the server's ops-event spool", () => {
  it("a Cloud home spools under /data (the server owns it), never under the root-only /var/lib/murage-home", () => {
    expect(homeEventsDir({ MURAGE_TRUSTED_PROXY: "1" })).toBe("/data/.murage-events");
    expect(homeEventsDir({ MURAGE_TRUSTED_PROXY: "1", MURAGE_HOME_EVENTS_DIR: "/x" })).toBe("/x");
    expect(homeEventsDir({})).toBeUndefined();
    expect(HOME_EVENTS_FOLDER).toBe(HOME_EVENTS_DIR_NAME);
  });
  it("a failed spool write is logged and counted, never silent; no folder (desktop) is not a failure", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "j5-"));
    try {
      expect(spoolHomeEvent(undefined, "restore.stuck", 1)).toBeNull();
      expect(homeEventSpoolFailures()).toBe(0);
      expect(spoolHomeEvent(join(dir, "nope", "\0bad"), "restore.aborted", 2)).toBeNull();
      expect(homeEventSpoolFailures()).toBe(1);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain("restore.aborted");
    } finally { removeTempDirSync(dir); }
  });
  it("the supervisor prepares the folder as root before setuid: root owner, server group, 01770, idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "j5-"));
    try {
      const owners: number[][] = [];
      prepareHomeEventsDir(dir, 2001, (_fd: number, uid: number, gid: number) => { owners.push([uid, gid]); });
      expect(owners).toEqual([[0, 2001]]);
      expect(statSync(join(dir, ".murage-events")).mode & 0o7777).toBe(0o1770);
      prepareHomeEventsDir(dir, 2001, () => undefined);
    } finally { removeTempDirSync(dir); }
  });
  it("the supervisor refuses a symlink in the folder's place", () => {
    const a = mkdtempSync(join(tmpdir(), "j5-")), b = mkdtempSync(join(tmpdir(), "j5-"));
    try {
      symlinkSync(b, join(a, ".murage-events"), "dir");
      expect(() => prepareHomeEventsDir(a, 2001, () => undefined)).toThrow();
    } finally { removeTempDirSync(a); removeTempDirSync(b); }
  });
  it("wiring: bindHomeVolume prepares the folder (root), index resolves it through homeEventsDir, /api/health carries the failure count, the unit may write it, the backup excludes it", () => {
    const sup = readFileSync(root("server/cloud-home/home-volume-spec.ts"), "utf8");
    const call = sup.indexOf("prepareHomeEventsDir(dataDir, gid)");
    expect(call).toBeGreaterThan(sup.indexOf("export function bindHomeVolume"));
    expect(call).toBeLessThan(sup.indexOf("export function prepareHomeEventsDir"));
    const launcher = readFileSync(root("deploy/cloud-home/murage-home-launch.py"), "utf8");
    expect(launcher).toContain("    prepare_home_events_dir(data_dir, gid)");
    const main = launcher.slice(launcher.indexOf("def main():"));
    expect(main.indexOf("bind_home_volume(DATA")).toBeGreaterThan(-1);
    expect(main.indexOf("bind_home_volume(DATA")).toBeLessThan(main.indexOf("drop_privileges(identity)"));
    const index = readFileSync(root("server/index.ts"), "utf8");
    expect(index).toContain("const HOME_EVENTS_DIR = homeEventsDir(process.env);");
    expect(index).toMatch(/app: "murage",\s*\.\.\.homeEventsHealthFields\(process\.env\)/);
    expect(readFileSync(root("deploy/cloud-home/murage-control.service"), "utf8")).toContain("\nReadWritePaths=-/data/.murage-events\n");
    expect(readFileSync(root("server/data-dir-inventory.ts"), "utf8")).toContain('".murage-events": excluded(');
  });
});

const script = `
import importlib.machinery, importlib.util, json, sys
def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module
control = load("murage_control", sys.argv[1])
d = sys.argv[2]
open(d + "/restore.aborted-1700000000000.json", "w").write(json.dumps({"type": "restore.aborted", "at": 1700000000000}))
h1, c1 = control.collect_health(events=d, allowed_events=control.EVENT_TYPES)
h2 = control.with_spool_failed(None, 1700000000999)
import tempfile
root_dir, server_dir = tempfile.mkdtemp(), tempfile.mkdtemp()
control.EVENTS, control.SERVER_EVENTS = root_dir, server_dir
open(root_dir + "/abuse.mining_suspected-5.json", "w").write(json.dumps({"type": "abuse.mining_suspected", "at": 5}))
open(server_dir + "/restore.stuck-6.json", "w").write(json.dumps({"type": "restore.stuck", "at": 6}))
both = sorted(e["type"] for e in control.collect_health(allowed_events=control.EVENT_TYPES)[0]["events"])
class R:
    status = 200
    def __enter__(s): return s
    def __exit__(s, *a): return False
    def read(s, n): return json.dumps({"app": "murage", "eventSpoolFailures": 3}).encode()
class O:
    def open(s, req, timeout=0): return R()
rep = control.app_report("https://h.example", opener=O())
print(json.dumps({"h1": h1, "h2": h2, "rep": rep["spoolFailures"], "both": both, "clean": "spoolFailures" in control.app_report("https://h.example", opener=type("O", (), {"open": lambda s, r, timeout=0: type("R", (), {"status": 200, "__enter__": lambda s: s, "__exit__": lambda s, *a: False, "read": lambda s, n: b'{"app": "murage"}'})()})())}))
`;
describe("J5 murage-control carries the server's spool and the failure count", () => {
  it.skipIf(!hasPython)("reads the server folder, raises home.event_spool_failed from the app's count, and the Worker's strict schema accepts both", async () => {
    const { healthSchema } = await import(/* the Worker source is outside the server project */ root("cloudflare/control-plane/src/ops-monitor.ts")) as { healthSchema: { parse(v: unknown): unknown } };
    const d = mkdtempSync(join(tmpdir(), "j5-"));
    try {
      const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, root("deploy/cloud-home/murage-control"), d], { encoding: "utf8" }));
      expect(out.h1.events).toEqual([{ type: "restore.aborted", at: 1700000000000 }]);
      expect(out.h2.events).toEqual([{ type: "home.event_spool_failed", at: 1700000000999 }]);
      expect(out.both).toEqual(["abuse.mining_suspected", "restore.stuck"]); // the default scan reads the root folder AND the server folder
      expect(out.rep).toBe(3);
      expect(out.clean).toBe(false); // no failures: the app report keeps its old shape
      healthSchema.parse(out.h1); healthSchema.parse(out.h2);
      expect(readFileSync(root("deploy/cloud-home/murage-control"), "utf8")).toContain('SERVER_EVENTS = "/data/.murage-events"');
    } finally { removeTempDirSync(d); }
  });
});

// Real uid split: on only inside the root-prepared container (home-events-uidsplit.sh), where this file runs as uid 2001 and /var/lib/murage-home is a root 0700 directory.
const uidSplitRig = (() => { try { const s = statSync("/var/lib/murage-home"); return process.getuid?.() === 2001 && s.uid === 0 && (s.mode & 0o777) === 0o700; } catch { return false; } })();
describe.skipIf(!uidSplitRig)("J5 real uid split (server as a non-root uid against root-prepared dirs)", () => {
  it("is not root", () => { expect(process.getuid?.()).toBe(2001); });
  it("the old path is unreachable for this uid (the High finding): the write fails, and now says so", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(spoolHomeEvent("/var/lib/murage-home/events", "restore.aborted", 1700000000001)).toBeNull();
    expect(homeEventSpoolFailures()).toBe(1);
    expect(err).toHaveBeenCalled();
  });
  it("the resolved Cloud path takes the write as this uid, and the files are there for root", () => {
    const dir = homeEventsDir({ MURAGE_TRUSTED_PROXY: "1" })!;
    expect(spoolHomeEvent(dir, "restore.aborted", 1700000000002)).toBe("restore.aborted-1700000000002.json");
    expect(spoolHomeEvent(dir, "restore.stuck", 1700000000003)).toBe("restore.stuck-1700000000003.json");
    expect(readdirSync(dir).sort()).toEqual(["restore.aborted-1700000000002.json", "restore.stuck-1700000000003.json"]);
    expect(homeEventSpoolFailures()).toBe(0);
    expect(existsSync("/var/lib/murage-home/events")).toBe(false); // not even traversable for this uid
  });
  it("the server cannot read the enrollment state", () => {
    expect(() => readdirSync("/var/lib/murage-home")).toThrow();
  });
});
