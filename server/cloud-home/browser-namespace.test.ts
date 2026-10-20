// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const helper = fileURLToPath(new URL("../../deploy/cloud-home/murage-browser-namespace.py", import.meta.url));
const fixture = fileURLToPath(new URL("./browser-namespace.fixture.py", import.meta.url));
for (const scenario of ["reuse", "identity", "registry", "stop", "retry", "creation", "fresh", "parent-race", "parent", "manager", "join", "join-child", "network-argv", "kill-scopes"]) {
  // the helper calls os.pidfd_open and os.pipe2, which Python has only on Linux
  it.skipIf(process.platform !== "linux")(`actual namespace helper: ${scenario} with privileged operations replaced`, () => {
    expect(execFileSync("python3", ["-I", fixture, helper, scenario], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })).toBe(`OK ${scenario}\n`);
  });
}
it("fresh helper exec precedes profile anchors and uses namespace cleanup rather than browser PID files", () => {
  const launcher = source("murage-turn-launch.py");
  expect(launcher.indexOf('namespace.ensure(request["bot"])')).toBeLessThan(launcher.indexOf('pins = [(open_directory(home), home)]'));
  expect(launcher.indexOf('pins = [(open_directory(home), home)]')).toBeLessThan(launcher.indexOf('mounts = anchor_mounts(pins)'));
  expect(launcher).not.toContain("name[:-4]");
  expect(launcher).toContain("namespace.join");
  expect(launcher).toContain('"--ro-bind-data", str(resolver), "/etc/resolv.conf"');
  const helperSource = source("murage-browser-namespace.py");
  expect(helperSource).toContain('os.chdir("/"); os.umask(0o077)');
  expect(helperSource).toContain('null = os.open("/dev/null", os.O_RDWR)');
  expect(helperSource).toContain('os.close(writefd); os.close(lock)  # Do NOT LOCK_UN');
  expect(helperSource).not.toContain("getppid");
  expect(helperSource).not.toContain("cgroup.procs");
  expect(source("murage-home.service")).toContain("KillMode=control-group");
  expect(source("murage-home.service")).toContain("TimeoutStopSec=30");
});
