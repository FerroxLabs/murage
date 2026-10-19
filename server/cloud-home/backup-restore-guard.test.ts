// SPDX-License-Identifier: AGPL-3.0-or-later
// backup-restore-test.sh deletes /data, /srv/bk-repo and /restore as root. Its
// guard must refuse every host that is not the fresh VM its hcloud wrapper made.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const read = (p: string) => readFileSync(new URL(`../../deploy/cloud-home/qualify/${p}`, import.meta.url), "utf8");
const script = read("backup-restore-test.sh");
const guard = /# >>> disposable-host guard\n([\s\S]*?)# <<< disposable-host guard\n/.exec(script)![1];
const GUARDED = ["/etc/mcq-disposable-test-host", "/etc/murage-home/enrolled", "/data/home", "/etc/murage-home/identity.json"];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

/** Runs the real guard text with every guarded path moved under a temp root,
 *  creating `present` there first; reports whether the script would go on. */
function runGuard(present: string[]): { status: number | null; reached: boolean; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "murage-bk-guard-"));
  roots.push(root);
  for (const path of present) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (path === "/data/home") mkdirSync(join(root, path));
    else writeFileSync(join(root, path), "");
  }
  let body = guard;
  for (const path of GUARDED) body = body.split(`"${path}:`).join(`"${root}${path}:`);
  for (const path of GUARDED) expect(body).toContain(`"${root}${path}:`);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${body}echo REACHED`], { encoding: "utf8" });
  return { status: result.status, reached: result.stdout.includes("REACHED"), stderr: result.stderr };
}

describe("backup-restore-test.sh disposable-host guard", () => {
  it("sits at the entry point, before any delete", () => {
    const lines = script.split("\n");
    expect(lines.indexOf("set -euo pipefail") + 1).toBe(lines.indexOf("# >>> disposable-host guard"));
    expect(script.indexOf("# <<< disposable-host guard")).toBeLessThan(script.indexOf("rm -rf"));
  });

  it("refuses when the disposable-host marker is missing", () => {
    const run = runGuard([]);
    expect(run.status).toBe(3);
    expect(run.reached).toBe(false);
    expect(run.stderr).toContain("mcq-disposable-test-host is missing");
  });

  it("refuses an enrolled home even with the marker", () => {
    const run = runGuard(["/etc/mcq-disposable-test-host", "/etc/murage-home/enrolled"]);
    expect(run.status).toBe(3);
    expect(run.reached).toBe(false);
    expect(run.stderr).toContain("enrolled is present");
  });

  it("refuses a host holding home data in /data/home even with the marker", () => {
    const run = runGuard(["/etc/mcq-disposable-test-host", "/data/home"]);
    expect(run.status).toBe(3);
    expect(run.reached).toBe(false);
    expect(run.stderr).toContain("/data/home is present");
  });

  it("refuses a host built from the home image even with the marker", () => {
    const run = runGuard(["/etc/mcq-disposable-test-host", "/etc/murage-home/identity.json"]);
    expect(run.status).toBe(3);
    expect(run.reached).toBe(false);
  });

  it("goes on only on a marked host with no home on it", () => {
    const run = runGuard(["/etc/mcq-disposable-test-host"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.reached).toBe(true);
  });

  it("the hcloud wrapper marks only the VM it just created, before sending the test", () => {
    const wrapper = read("backup-restore-test-hcloud.sh");
    const mark = wrapper.indexOf("touch /etc/mcq-disposable-test-host");
    expect(mark).toBeGreaterThan(wrapper.indexOf("api -X POST https://api.hetzner.cloud/v1/servers"));
    expect(mark).toBeLessThan(wrapper.indexOf("bash /root/hc/t.sh"));
  });
});
