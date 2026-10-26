// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot ordering: the image's units, enabled exactly as build-image.sh enables them, next to the systemd and cloud-init
// units they order against, must form no ordering cycle. systemd breaks a cycle at boot by deleting one of its jobs (a
// cycle murage-backup-authorize -> cloud-final -> multi-user.target once deleted cloud-final, so runcmd never ran).
// The full check with the real Ubuntu units and `systemd-analyze verify` is qualify/unit-order-test.sh (container).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dir = fileURLToPath(new URL("../../deploy/cloud-home/", import.meta.url));
const checker = join(dir, "qualify/unit-order-check.py");
const repo = fileURLToPath(new URL("../../", import.meta.url));

// The ordering-relevant lines of the stock units (systemd 255 and cloud-init 26.1 on Ubuntu 24.04, copied from the
// packages; qualify/unit-order-test.sh checks against the real files).
const SYSTEM: Record<string, string> = {
  "sysinit.target": "[Unit]\nDefaultDependencies=no\nWants=local-fs.target\nAfter=local-fs.target\n",
  "local-fs-pre.target": "[Unit]\nDefaultDependencies=no\n",
  "local-fs.target": "[Unit]\nDefaultDependencies=no\nAfter=local-fs-pre.target\n",
  "basic.target": "[Unit]\nRequires=sysinit.target\nWants=sockets.target timers.target paths.target slices.target\nAfter=sysinit.target sockets.target paths.target slices.target\n",
  "sockets.target": "[Unit]\nDefaultDependencies=no\n", "timers.target": "[Unit]\nDefaultDependencies=no\n",
  "paths.target": "[Unit]\nDefaultDependencies=no\n", "slices.target": "[Unit]\nDefaultDependencies=no\n",
  "network-online.target": "[Unit]\nAfter=network.target\n", "network.target": "[Unit]\n",
  "time-sync.target": "[Unit]\nDefaultDependencies=no\n", "rc-local.service": "[Unit]\nAfter=network.target\n",
  "apt-daily.service": "[Unit]\n",
  "multi-user.target": "[Unit]\nRequires=basic.target\nAfter=basic.target\nAllowIsolate=yes\n",
  "cloud-init.target": "[Unit]\nAfter=multi-user.target\n",
  "cloud-config.target": "[Unit]\n",
  "cloud-init-network.service": "[Unit]\nDefaultDependencies=no\nAfter=systemd-networkd-wait-online.service\nBefore=network-online.target\n",
  "cloud-config.service": "[Unit]\nAfter=network-online.target cloud-config.target\nWants=network-online.target cloud-config.target\n",
  "cloud-final.service": "[Unit]\nAfter=network-online.target time-sync.target cloud-config.service rc-local.service\nAfter=multi-user.target\nBefore=apt-daily.service\nWants=network-online.target cloud-config.service\n",
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "unit-order-")); });
afterEach(() => { removeTempDirSync(root); });

function image(edit?: (name: string, text: string) => string) {
  const lib = join(root, "usr/lib/systemd/system"), etc = join(root, "etc/systemd/system");
  mkdirSync(lib, { recursive: true }); mkdirSync(etc, { recursive: true });
  for (const [name, text] of Object.entries(SYSTEM)) writeFileSync(join(lib, name), text);
  mkdirSync(join(lib, "cloud-init.target.wants"));
  for (const name of ["cloud-init-network.service", "cloud-config.service", "cloud-final.service"]) symlinkSync(`../${name}`, join(lib, "cloud-init.target.wants", name));
  symlinkSync("multi-user.target", join(lib, "default.target"));
  for (const name of readdirSync(dir).filter(f => /\.(service|timer|path|mount|slice)$/.test(f))) {
    if (edit) writeFileSync(join(etc, name), edit(name, readFileSync(join(dir, name), "utf8")));
    else copyFileSync(join(dir, name), join(etc, name));
  }
  // `systemctl enable` for exactly the units build-image.sh enables: one link per WantedBy=/RequiredBy= target.
  const enabled = [...readFileSync(join(dir, "build-image.sh"), "utf8").matchAll(/^systemctl enable (.+)$/gm)].flatMap(m => m[1].trim().split(/\s+/));
  expect(enabled).toContain("murage-backup-authorize.service");
  for (const name of enabled) {
    const install = readFileSync(join(etc, name), "utf8").split("[Install]")[1] ?? "";
    for (const [, kind, targets] of install.matchAll(/^(WantedBy|RequiredBy)=(.+)$/gm)) {
      for (const target of targets.trim().split(/\s+/)) {
        const links = join(etc, `${target}.${kind === "WantedBy" ? "wants" : "requires"}`);
        mkdirSync(links, { recursive: true }); symlinkSync(`../${name}`, join(links, name));
      }
    }
  }
}
const check = () => spawnSync("python3", ["-I", checker, "--root", root, "--dot", join(root, "boot.dot")], { encoding: "utf8" });

describe("image boot ordering", () => {
  it("has no ordering cycle in the boot transaction or in any image unit started on its own", () => {
    image();
    const result = check();
    expect(result.stdout + result.stderr).toMatch(/^unit-order-check: no ordering cycle in \d+ transactions \(default target multi-user\.target\)$/m);
    expect(result.status).toBe(0);
    const dot = readFileSync(join(root, "boot.dot"), "utf8");
    // The orderings the units' logic needs are all still there.
    for (const edge of [
      '"cloud-config.service" -> "murage-backup-authorize.service"', // bootstrap files are written before it runs
      '"murage-backup-authorize.service" -> "multi-user.target"', '"multi-user.target" -> "cloud-final.service"',
      '"cloud-config.service" -> "murage-volume.service"', '"murage-volume.service" -> "data.mount"',
      '"data.mount" -> "murage-home.service"', '"murage-egress.service" -> "murage-home.service"',
    ]) expect(dot).toContain(edge);
  });
  it("detects the cycle the image used to have (backup-authorize ordered after cloud-final)", () => {
    image((name, text) => name === "murage-backup-authorize.service" ? text.replace(/^After=cloud-config\.service/m, "After=cloud-final.service") : text);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ordering cycle (starting multi-user.target): cloud-final.service -> murage-backup-authorize.service -> multi-user.target -> cloud-final.service");
  });
  it("detects a cycle through a .path-triggered unit pulled into multi-user.target", () => {
    image((name, text) => name === "murage-scrub-userdata.service" ? text + "\n[Install]\nWantedBy=multi-user.target\n" : text);
    const etc = join(root, "etc/systemd/system");
    symlinkSync("../murage-scrub-userdata.service", join(etc, "multi-user.target.wants", "murage-scrub-userdata.service"));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ordering cycle .*murage-scrub-userdata\.service/);
  });

  // The build gate itself: the marked block of build-image.sh, run with bash -euo pipefail from the source checkout,
  // pointed at the fixture root instead of /, with systemd-analyze replaced by a stub (the test host has no systemd).
  const build = readFileSync(join(dir, "build-image.sh"), "utf8");
  const begin = build.indexOf("# >>> boot ordering gate"), end = build.indexOf("# <<< boot ordering gate");
  const block = build.slice(begin, end);
  function runGate(analyze: string | null) {
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    for (const tool of ["python3", "ls", "grep", "cat"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (!existsSync(join(bin, tool))) symlinkSync(found, join(bin, tool));
    }
    if (analyze !== null) writeFileSync(join(bin, "systemd-analyze"), `#!/bin/bash\n${analyze}\n`, { mode: 0o755 });
    const script = "set -euo pipefail\n" + block.replaceAll("--root / ", `--root '${root}' `).replaceAll("/etc/systemd/system", join(root, "etc/systemd/system"));
    return spawnSync("/bin/bash", ["-c", script], { cwd: repo, encoding: "utf8", env: { PATH: bin } });
  }
  it("build-image.sh runs the ordering gate after every unit is enabled", () => {
    expect(begin).toBeGreaterThan(build.lastIndexOf("\nsystemctl enable ")); expect(end).toBeGreaterThan(begin);
    expect(block).toContain("python3 -I -B deploy/cloud-home/qualify/unit-order-check.py --root / ||");
    image();
    expect(runGate("exit 0").status).toBe(0);
    expect(runGate("echo 'some unrelated unit warning' >&2; exit 1").status).toBe(0); // verify's exit 1 alone is not a cycle
  });
  it("re-adding After=cloud-final.service to murage-backup-authorize makes the build gate fail", () => {
    image((name, text) => name === "murage-backup-authorize.service" ? text.replace(/^After=cloud-config\.service/m, "After=cloud-final.service") : text);
    const result = runGate("exit 0"); // as at build time: verify without generators sees no cycle
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cloud-final.service -> murage-backup-authorize.service -> multi-user.target -> cloud-final.service");
    expect(result.stdout).toContain("boot ordering cycle in the image units; refusing to build");
  });
  it("fails the build when systemd-analyze reports a cycle", () => {
    image();
    const result = runGate("echo 'multi-user.target: Found ordering cycle on x.service/start'; exit 1");
    expect(result.status).toBe(1); expect(result.stdout).toContain("systemd ordering cycle in the image units; refusing to build");
  });
  it.each([["missing", null, 127], ["not executable", "exit 126", 126], ["killed", "kill -9 $$", 137]] as const)("fails the build when the verifier did not run (%s)", (_label, analyze, code) => {
    image();
    const result = runGate(analyze);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`systemd-analyze verify did not run (exit ${code}); refusing to build`);
  });
  it("fails the build when the graph checker cannot run", () => {
    image();
    rmSync(join(root, "usr/lib/systemd/system/multi-user.target")); rmSync(join(root, "usr/lib/systemd/system/default.target"));
    const result = runGate("exit 0");
    expect(result.status).toBe(1); expect(result.stdout).toContain("refusing to build");
  });
  it("murage-backup.service runs only after the backup key is installed, with no new cycle", () => {
    const unit = readFileSync(join(dir, "murage-backup.service"), "utf8");
    expect(unit).toMatch(/^After=data\.mount network-online\.target murage-backup-authorize\.service$/m);
    expect(unit).toMatch(/^Requires=data\.mount murage-backup-authorize\.service$/m);
    image();
    const result = check();
    expect(result.stdout).toContain("no ordering cycle"); expect(result.status).toBe(0);
  });
});
