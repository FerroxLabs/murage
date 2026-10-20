// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const envelope = JSON.stringify({ version: 2, machineId: "home-test", dataKey: Buffer.alloc(32, 1).toString("base64"), bootstrapSecret: Buffer.alloc(32, 2).toString("base64") });
// start-home.sh runs under the image's bash 5 and waits on its process substitution, which bash
// before 4.4 cannot do (`wait` answers 127, "not a child"). macOS ships bash 3.2 as /bin/bash, so
// use a bash 4.4+ from the host (Homebrew's on the macOS runners) and say so when there is none.
const modernBash = ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"].find(candidate => {
  const probe = spawnSync(candidate, ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: "utf8" });
  const [major, minor] = (probe.stdout ?? "").trim().split(" ").map(Number);
  return probe.status === 0 && (major > 4 || (major === 4 && minor >= 4));
});
const runsBoot = modernBash ? it : it.skip;
// Replace only immutable deployment paths. The actual bash control flow runs;
// the fake supervisor reads FD3, verifies non-export and returns no key bytes.
function boot(output: string, status: number) {
  const root = mkdtempSync(join(tmpdir(), "cloud-boot-"));
  try {
    const helper = join(root, "enroll"), node = join(root, "node"), config = join(root, "home.env");
    writeFileSync(helper, `#!/bin/bash\nif [[ \"\${1:-}\" == --envelope ]]; then\ncat <<'ENVELOPE'\n${output}\nENVELOPE\nexit ${status}\nfi\n`, { mode: 0o700 });
    writeFileSync(config, "MURAGE_CLOUD_MACHINE_ID=home-test\n");
    writeFileSync(node, `#!/usr/bin/python3\nimport os,json\nprint('supervisor entered',flush=True)\nv=json.load(os.fdopen(3))\nassert v['version']==2\nassert v['dataKey'] not in repr(dict(os.environ))\nassert v['bootstrapSecret'] not in repr(dict(os.environ))\nprint('supervisor started')\n`, { mode: 0o700 });
    const script = source("start-home.sh").replaceAll("/usr/local/libexec/murage-enroll", helper).replaceAll("/etc/murage-home/home.env", config).replaceAll("/usr/local/bin/node", node);
    return spawnSync(modernBash!, ["-c", script], { encoding: "utf8", timeout: 5000 });
  } finally { removeTempDirSync(root); }
}
runsBoot("launches with envelope only on FD3 (needs bash 4.4+)", () => { const result = boot(envelope, 0); expect(result.status).toBe(0); expect(result.stdout).toBe("supervisor entered\nsupervisor started\n"); expect(result.stderr).toBe(""); });
runsBoot.each([78, 1, 127])("preserves helper status %i and never execs with partial key (needs bash 4.4+)", status => { const result = boot(envelope, status); expect(result.status).toBe(status); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("AQEB"); if (status === 78) expect(result.stderr).toContain("stale generation"); });
runsBoot.each(["", "broken", "{}", envelope.replace('"version":2', '"version":1')])("refuses missing or malformed envelope before exec (needs bash 4.4+)", value => { const result = boot(value, 0); expect(result.status).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("AQEB"); });
it("systemd stops stale-generation restart", () => { expect(source("murage-home.service")).toContain("RestartPreventExitStatus=78"); });
it("permits only turn stub DNS before loopback drop", () => {
 const nft = source("murage-egress.nft");
 for (const protocol of ["udp", "tcp"]) {
  const rule = `meta skuid "murage-turn" ip daddr 127.0.0.53 ${protocol} dport 53 counter accept`;
  expect(nft).toContain(rule); expect(nft.indexOf(rule)).toBeLessThan(nft.indexOf('meta skuid "murage-turn" ip daddr 127.0.0.0/8 counter drop'));
 }
 expect(nft).toContain('meta skuid "murage-browser" ip daddr 127.0.0.0/8 counter drop');
});
it("bounds new external flows while exempting root/server/loopback from meters", () => {
 const nft = source("murage-egress.nft");
 const meters = nft.split("\n").filter(line => line.includes("update @browser_connections") || line.includes("update @uid_connections"));
 expect(meters).toHaveLength(2);
 for (const line of meters) { expect(line).toContain('oifname != "lo"'); expect(line).toContain('meta skuid != { 0, "murage" }'); }
 expect(meters[0]).toContain('meta skuid "murage-browser"'); expect(meters[0]).toContain('600/minute burst 300 packets');
 expect(meters[1]).toContain('meta skuid != { "murage-browser", "murage-egress" }'); expect(meters[1]).toContain('300/minute burst 180 packets');
 // Token bucket implications from actual policy values; no claim of kernel proof.
 for (const line of meters) { const [, rate, burst] = line.match(/(\d+)\/minute burst (\d+) packets/)!; const allowance = Number(rate) + Number(burst); expect(allowance).toBeGreaterThanOrEqual(480); expect(allowance).toBeLessThan(1000); }
 expect(nft).toContain('tcp dport { 25, 465, 587 } counter drop'); expect(nft).toContain('169.254.169.254 counter drop');
});

it("meters turn->proxy connections per engine gid and caps murage-egress overall, sized for all engines", () => {
 const nft = source("murage-egress.nft");
 expect(nft).toContain("set engine_connections { typeof meta skgid; flags dynamic,timeout; timeout 2m; }");
 const perEngine = nft.split("\n").filter(line => line.includes("update @engine_connections"));
 expect(perEngine).toHaveLength(1);
 expect(perEngine[0]).toContain('oifname "lo" meta skuid "murage-turn" ct state new'); expect(perEngine[0]).toContain("{ meta skgid timeout 2m limit rate over 120/minute");
 // The per-engine meter runs before the first engine accept, so over-rate flows drop.
 expect(nft.indexOf("update @engine_connections")).toBeLessThan(nft.indexOf('meta skuid "murage-turn" meta skgid "murage-eng-antigravity" ip daddr 127.0.0.1'));
 const overall = nft.split("\n").filter(line => line.includes("update @egress_connections"));
 expect(overall).toHaveLength(1);
 expect(overall[0]).toContain('oifname != "lo" meta skuid "murage-egress" ct state new');
 const [, rate] = overall[0].match(/over (\d+)\/minute/)!; const [, perRate] = perEngine[0].match(/over (\d+)\/minute/)!;
 expect(Number(rate)).toBeGreaterThan(Number(perRate)); expect(Number(rate)).toBeGreaterThanOrEqual(1000);
 // Browser flows are forwarded from the mbh* veth (no socket owner): metered per bot interface.
 expect(nft).toContain("update @browser_new_bot { iifname timeout 2m");
});
it("raises inotify limits for the shared murage-turn uid and pins the sudo environment", () => {
 const build = source("build-image.sh");
 expect(build).toContain("fs.inotify.max_user_instances = 2048"); expect(build).toContain("fs.inotify.max_user_watches = 524288");
 expect(build).toContain("/etc/sysctl.d/61-murage-inotify.conf");
 const sudoers = source("murage-turn.sudoers");
 expect(sudoers).toMatch(/^Defaults:murage env_reset, !setenv, closefrom_override$/m);
 expect(sudoers).toMatch(/^murage ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/murage-turn-launch ""$/m);
 expect(build).toMatch(/^visudo -cf \/etc\/sudoers\.d\/murage-turn$/m);
});
// d50ef6d7b made mount_setattr and quotactl_fd mandatory denies (arm/REVIEW-astra-seccomp.md): there is no optional list any
// more, so a libseccomp that cannot resolve either one fails the build. The one skip is umount, by exact name, because it has
// no syscall on x86_64 or aarch64 (umount2 is denied on both).
it("fails the seccomp build on any unknown syscall name; only umount, absent on every supported arch, is skipped", () => {
 const c = source("murage-seccomp.c");
 expect(c).not.toMatch(/__NR_SCMP_ERROR\) continue;/);
 expect(c).not.toMatch(/\boptional\[\]|is_optional\(/);
 expect(c).toMatch(/if \(nr < 0\) \{[^}]*_exit\(1\); \}/);
 const skipped = c.match(/absent_everywhere\[\] = \{([^}]*)\}/)![1].match(/"(\w+)"/g)!;
 expect(skipped).toEqual(['"umount"']);
 const deny = c.match(/deny\[\] = \{([^}]*)\}/)![1];
 for (const name of ["mount_setattr", "quotactl_fd", "umount2"]) expect(deny).toContain(`"${name}"`);
 // The skip is checked by name before the number, and every other name reaches the hard failure.
 expect(c.indexOf("is_absent_everywhere(deny[i])")).toBeLessThan(c.indexOf("if (nr < 0)"));
});
