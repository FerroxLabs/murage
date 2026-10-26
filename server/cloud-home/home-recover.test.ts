// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");

it("has a recovery timer that re-arms after every run", () => {
  const timer = source("murage-home-recover.timer");
  expect(timer).toMatch(/^OnUnitInactiveSec=\d+s$/m);
  expect(timer).toMatch(/^OnBootSec=\d+s$/m);
  expect(timer).toMatch(/^WantedBy=timers\.target$/m);
});

it("installs and enables the recovery units in the image", () => {
  const build = source("build-image.sh");
  expect(build).toContain("deploy/cloud-home/murage-home-recover.service /etc/systemd/system/murage-home-recover.service");
  expect(build).toContain("deploy/cloud-home/murage-home-recover.timer /etc/systemd/system/murage-home-recover.timer");
  expect(build).toMatch(/^systemctl enable murage-home-recover\.timer$/m);
});

it("skips when home is active or the volume exited 78, otherwise starts home, proxy and the egress proxy", () => {
  const service = source("murage-home-recover.service");
  expect(service).toMatch(/^Type=oneshot$/m);
  expect(service).toMatch(/^User=root$/m);
  const conditions = service.match(/^ExecCondition=.*$/gm) ?? [];
  expect(conditions).toHaveLength(3);
  // The home's own envelope unwrap can end in terminal 78 after the volume unlocked.
  expect(conditions.some((c) => c.includes("ExecMainStatus") && c.includes("murage-home.service") && c.includes("grep -qx 78") && c.includes("'! "))).toBe(true);
  expect(conditions.some((c) => c.includes("is-active") && c.includes("murage-home.service") && c.includes("'! "))).toBe(true);
  expect(conditions.some((c) => c.includes("ExecMainStatus") && c.includes("murage-volume.service") && c.includes("grep -qx 78") && c.includes("'! "))).toBe(true);
  const starts = service.match(/^ExecStart=.*$/gm) ?? [];
  expect(starts).toEqual(["ExecStart=/usr/bin/systemctl start murage-home.service murage-proxy.service murage-egress-proxy.service",
    "ExecStart=/usr/bin/systemctl start --no-block murage-tunnel-token.service"]);
  // Skipped only when the home runs AND its tunnel connector was fetched (a first-boot tunnel-token dependency failure is retried here).
  expect(conditions.some((c) => c.includes("murage-tunnel-token.service") && c.includes("murage-home.service") && c.includes("&&"))).toBe(true);
  expect(service).not.toMatch(/Restart=/);
});

it("home pulls in the turn egress proxy itself (after enrollment nothing else starts it)", () => {
  const home = source("murage-home.service");
  expect(home).toMatch(/^Wants=.*\bmurage-egress-proxy\.service\b/m);
  expect(source("murage-egress-proxy.service")).toMatch(/^Before=.*\bmurage-home\.service\b/m);
  expect(home).toMatch(/^Wants=.*\bmurage-egress-dns\.service\b/m);
});

// The recovery wipe is the launcher's engine-signin-cleanup (erase_credential_at). Run the real
// function against hostile leftovers: it must neither block, follow, nor recurse.
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
function wipeFixture(setup: string): string {
  // Resolved: the launcher walks the home path with O_NOFOLLOW, and macOS os.tmpdir() sits behind the /var -> /private/var link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "home-recover-")));
  try {
    return execFileSync("python3", ["-I", "-c", `
import os, runpy, sys
m = runpy.run_path(sys.argv[1]); root = sys.argv[2]; owners = {os.getuid()}
os.chmod(root, 0o755)
os.makedirs(root + "/kimiAgent/.kimi-code/credentials")
${setup}
m["cleanup_engine_signins"]({"mode": "engine-signin-cleanup"}, root, owners, os.getuid())
assert not os.path.lexists(root + "/kimiAgent/.kimi-code/credentials")
print("ok")
`, launcher, root], { encoding: "utf8", timeout: 60_000 }).trim();
  } finally { removeTempDirSync(root); }
}

it("wipe removes a FIFO left in the credential store without opening it", () => {
  expect(wipeFixture('os.mkfifo(root + "/kimiAgent/.kimi-code/credentials/pipe")')).toBe("ok");
});

it("wipe unlinks a symlink to outside the tree and leaves the target untouched", () => {
  const out = wipeFixture(`
outside = root + "/outside"; os.mkdir(outside)
open(outside + "/keep", "w").write("keep")
os.symlink(outside, root + "/kimiAgent/.kimi-code/credentials/dirlink")
os.symlink(outside + "/keep", root + "/kimiAgent/.kimi-code/credentials/filelink")
m2 = m["cleanup_engine_signins"]
m2({"mode": "engine-signin-cleanup"}, root, owners, os.getuid())
assert open(outside + "/keep").read() == "keep"
os.makedirs(root + "/kimiAgent/.kimi-code/credentials")`);
  expect(out).toBe("ok");
});

it("wipe handles a 2,000-level-deep tree iteratively", () => {
  const out = wipeFixture(`
fd = os.open(root + "/kimiAgent/.kimi-code/credentials", os.O_RDONLY | os.O_DIRECTORY)
for _ in range(2000):
    os.mkdir("d", dir_fd=fd); nxt = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd); os.close(fd); fd = nxt
open_flags = os.O_WRONLY | os.O_CREAT
os.close(os.open("leaf", open_flags, 0o600, dir_fd=fd)); os.close(fd)`);
  expect(out).toBe("ok");
});

it("wipe is bounded by a deadline", () => {
  expect(readFileSync(launcher, "utf8")).toMatch(/CLEANUP_DEADLINE_SECONDS = \d+/);
  expect(existsSync(launcher)).toBe(true);
});
