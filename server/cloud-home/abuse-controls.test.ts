// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../deploy/cloud-home/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();

describe("abuse controls in the home image", () => {
  it("drops outbound SMTP on 25, 465 and 587 unconditionally, ahead of every engine accept", () => {
    const nft = read("murage-egress.nft");
    const drop = nft.indexOf("tcp dport { 25, 465, 587 } counter drop");
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(nft.indexOf('meta skuid "murage-turn" meta skgid "murage-eng-antigravity" ip daddr 127.0.0.1 udp dport 5310'));
    // No accept rule anywhere names an SMTP port.
    for (const line of nft.split("\n")) if (/accept/.test(line)) expect(line).not.toMatch(/dport[^\n]*\b(25|465|587)\b/);
  });
  it("installs and enables the miner watcher in the image", () => {
    const build = read("build-image.sh");
    expect(build).toContain("murage-miner-watch.py /usr/local/libexec/murage-miner-watch");
    expect(build).toContain("systemctl enable murage-miner-watch.service");
    expect(read("murage-miner-watch.service")).toContain("ExecStart=/usr/bin/python3 -I /usr/local/libexec/murage-miner-watch");
  });
  it("never kills a process and never alerts directly: it only drops an event file for the heartbeat", () => {
    const src = read("murage-miner-watch.py");
    expect(src).not.toMatch(/os\.kill|signal\.|SIGKILL|subprocess|ALERT/);
    expect(src).toContain('EVENTS = "/var/lib/murage-home/events"');
    expect(src).toContain('"type": "abuse.mining_suspected"');
    expect(read("murage-miner-watch.service")).toContain("ReadWritePaths=/var/lib/murage-home");
  });
  it("installs the backup key-authorize helper, which is inert without its bootstrap file and shreds it after use", () => {
    expect(read("build-image.sh")).toContain("murage-backup-authorize /usr/local/libexec/murage-backup-authorize");
    const sh = read("murage-backup-authorize");
    expect(sh).toContain("[ -f \"$B\" ] || exit 0");
    expect(sh).toContain("install-ssh-key");
    expect(sh).toContain("shred -u \"$B\"");
    expect(sh).toContain("StrictHostKeyChecking=yes");
  });
  it.skipIf(!hasPython)("miner heuristic passes its own state-machine selftest", () => {
    expect(execFileSync("python3", ["-I", new URL("murage-miner-watch.py", dir).pathname, "--selftest"], { encoding: "utf8" })).toContain("selftest ok");
  });
});
