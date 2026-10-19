// SPDX-License-Identifier: AGPL-3.0-or-later
// cloud-init user-data carries the enrollment token and the backup credentials. build host and Vultr serve it from
// 169.254.169.254 to any process on the host, and cloud-init keeps copies on disk. Both exposures are closed here.
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dir = new URL("../../deploy/cloud-home/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const scrub = new URL("murage-scrub-userdata", dir).pathname;

describe("metadata service is root only", () => {
  const nft = read("murage-egress.nft");
  const output = nft.slice(nft.indexOf("chain output {"), nft.indexOf("chain input {"));
  const rules = output.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#") && !l.startsWith("chain") && !l.startsWith("type") && l !== "}");
  it("drops 169.254.169.254 for every uid but root, as the very first output rule", () => {
    expect(rules[0]).toBe("meta skuid != 0 ip daddr 169.254.169.254 counter drop");
  });
  it("covers engines (murage-turn, pasta runs as that uid), the server, browsers, the egress proxy and the tunnel by uid, and never accepts the link-local range", () => {
    for (const line of rules) if (/accept|redirect/.test(line)) expect(line).not.toMatch(/169\.254/);
    // Everything link-local that is not the metadata address is also dropped for all uids except root and the server,
    // and the server may only reach control-plane endpoints.
    expect(output).toContain('meta skuid != { 0, "murage" } ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } counter drop');
    expect(output).toContain('meta skuid "murage" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } ip daddr != @cp_endpoints counter drop');
  });
  it("blocks the same address for browser bots forwarded from the mbh* veths", () => {
    expect(nft).toContain("169.254.0.0/16");
    expect(nft).toContain('iifname "mbh*" ip daddr @browser_non_global counter drop');
  });
  it("loads before any service that runs untrusted code", () => {
    expect(read("murage-egress.service")).toContain("Before=murage-home.service murage-proxy.service");
  });
});

describe("first boot destroys the cloud-init copies of the secrets", () => {
  it("is installed and enabled in the image, after the backup key is authorized", () => {
    const build = read("build-image.sh");
    expect(build).toContain("murage-scrub-userdata /usr/local/libexec/murage-scrub-userdata");
    expect(build).toContain("systemctl enable murage-backup-authorize.service murage-scrub-userdata.path");
    expect(read("murage-scrub-userdata.path")).toContain("PathExists=/var/lib/murage-home/credential");
    // Not wanted by multi-user.target: with After=cloud-final it would form an ordering cycle and never run.
    expect(read("murage-scrub-userdata.service")).not.toContain("[Install]");
    const unit = read("murage-scrub-userdata.service");
    expect(unit).toContain("After=cloud-final.service murage-volume.service murage-backup-authorize.service");
    expect(unit).toContain("ConditionPathExists=/var/lib/murage-home/credential");
    expect(read("murage-backup-authorize.service")).toContain("ConditionPathExists=/etc/murage-home/backup.bootstrap");
    // Wanted by multi-user.target, so it must never be ordered after cloud-final (After=multi-user.target): see unit-order.test.ts.
    expect(read("murage-backup-authorize.service")).toMatch(/^After=cloud-config\.service network-online\.target$/m);
    expect(read("murage-backup-authorize.service")).not.toMatch(/^(After|Before|Wants|Requires)=.*cloud-final/m);
  });
  const SECRET = "SECRET-enrollment-token-and-backup-password"; // secret-scan: fixture
  function tree() {
    const root = mkdtempSync(join(tmpdir(), "scrub-"));
    const inst = join(root, "var/lib/cloud/instances/i-123");
    for (const sub of ["scripts", "boothooks"]) mkdirSync(join(inst, sub), { recursive: true });
    mkdirSync(join(root, "run/cloud-init"), { recursive: true });
    mkdirSync(join(root, "etc/murage-home"), { recursive: true });
    mkdirSync(join(root, "var/lib/murage-home"), { recursive: true });
    const secret = [join(inst, "user-data.txt"), join(inst, "user-data.txt.i"), join(inst, "cloud-config.txt"), join(inst, "obj.pkl"),
      join(inst, "scripts/part-001"), join(inst, "boothooks/x"), join(root, "run/cloud-init/instance-data-sensitive.json"),
      join(root, "etc/murage-home/claim-user-data")]; // the warm-pool claim identity
    for (const f of secret) writeFileSync(f, SECRET);
    chmodSync(join(root, "etc/murage-home/claim-user-data"), 0o600); // as the served write_files creates it
    writeFileSync(join(root, "etc/murage-home/backup.key"), SECRET); // the home's own working copy must survive
    return { root, secret };
  }
  it("shreds user-data, its cached forms, scripts and instance-data, keeps /etc/murage-home, and disables cloud-init", () => {
    const { root, secret } = tree();
    try {
      writeFileSync(join(root, "var/lib/murage-home/credential"), "enrolled");
      execFileSync("sh", [scrub, root]);
      for (const f of secret) expect(existsSync(f)).toBe(false);
      expect(readFileSync(join(root, "etc/murage-home/backup.key"), "utf8")).toBe(SECRET);
      expect(existsSync(join(root, "etc/cloud/cloud-init.disabled"))).toBe(true);
      execFileSync("sh", [scrub, root]); // idempotent
    } finally { removeTempDirSync(root); }
  });
  it("removes a claim-user-data symlink without following it", () => {
    const { root } = tree();
    try {
      writeFileSync(join(root, "var/lib/murage-home/credential"), "enrolled");
      const target = join(root, "keep-me"); writeFileSync(target, SECRET);
      rmSync(join(root, "etc/murage-home/claim-user-data")); symlinkSync(target, join(root, "etc/murage-home/claim-user-data"));
      execFileSync("sh", [scrub, root]);
      expect(existsSync(join(root, "etc/murage-home/claim-user-data"))).toBe(false);
      expect(readFileSync(target, "utf8")).toBe(SECRET);
    } finally { removeTempDirSync(root); }
  });
  it("overwrites through the descriptor before unlinking (an fd held open sees the data gone)", () => {
    const { root } = tree();
    try {
      writeFileSync(join(root, "var/lib/murage-home/credential"), "enrolled");
      const held = openSync(join(root, "etc/murage-home/claim-user-data"), "r");
      try {
        execFileSync("sh", [scrub, root]);
        expect(existsSync(join(root, "etc/murage-home/claim-user-data"))).toBe(false);
        expect(fstatSync(held).size).toBe(0);
        const buffer = Buffer.alloc(SECRET.length); expect(readSync(held, buffer, 0, buffer.length, 0)).toBe(0);
      } finally { closeSync(held); }
    } finally { removeTempDirSync(root); }
  });
  it("refuses to overwrite a hardlinked claim file: the other name keeps its data, the claim name is removed", () => {
    const { root } = tree();
    try {
      writeFileSync(join(root, "var/lib/murage-home/credential"), "enrolled");
      const other = join(root, "other-name"); writeFileSync(other, SECRET, { mode: 0o600 });
      rmSync(join(root, "etc/murage-home/claim-user-data")); linkSync(other, join(root, "etc/murage-home/claim-user-data"));
      execFileSync("sh", [scrub, root], { stdio: "pipe" });
      expect(existsSync(join(root, "etc/murage-home/claim-user-data"))).toBe(false);
      expect(readFileSync(other, "utf8")).toBe(SECRET);
    } finally { removeTempDirSync(root); }
  });
  it("refuses to overwrite a claim file that is not mode 0600, and still removes its name", () => {
    const { root } = tree();
    try {
      writeFileSync(join(root, "var/lib/murage-home/credential"), "enrolled");
      const claim = join(root, "etc/murage-home/claim-user-data"); chmodSync(claim, 0o644);
      const held = openSync(claim, "r");
      try {
        execFileSync("sh", [scrub, root], { stdio: "pipe" });
        expect(existsSync(claim)).toBe(false);
        expect(fstatSync(held).size).toBe(SECRET.length);
      } finally { closeSync(held); }
    } finally { removeTempDirSync(root); }
  });
  it("leaves user-data alone until enrollment has finished (enrollment still needs the token to retry)", () => {
    const { root, secret } = tree();
    try {
      execFileSync("sh", [scrub, root]);
      for (const f of secret) expect(existsSync(f)).toBe(true);
      expect(existsSync(join(root, "etc/cloud/cloud-init.disabled"))).toBe(false);
    } finally { removeTempDirSync(root); }
  });
});
