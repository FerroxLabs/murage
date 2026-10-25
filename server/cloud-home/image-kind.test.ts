// SPDX-License-Identifier: AGPL-3.0-or-later
// the staging-ops-ssh image kind. build-image.sh keeps sshd only on STAGING_OPS_SSH=1 and marks the image;
// image-release-check.sh fails a release image with any sshd or the marker; hz-live labels and verifies the kind.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dir = (name: string) => fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url));
const text = (name: string) => readFileSync(dir(name), "utf8");
const check = dir("image-release-check.sh");

describe("build-image.sh", () => {
  const build = text("build-image.sh");
  it("keeps sshd and writes the marker only when STAGING_OPS_SSH=1; the default branch purges nothing", () => {
    const keep = build.indexOf("if [[ ${STAGING_OPS_SSH:-} = 1 ]]; then");
    const fi = build.indexOf("\nfi\n", keep);
    expect(keep).toBeGreaterThan(0);
    expect(build.slice(keep, fi)).not.toMatch(/apt-get purge|rm -rf/);
    expect(build).toMatch(/^printf 'staging-ops-ssh\\n' > \/etc\/murage-image-kind$/m);
    expect(build).toMatch(/^rm -f \/etc\/murage-image-kind$/m);
    expect(build).toMatch(/^image_kind=customer$/m);
    expect(build).not.toMatch(/install -y[^\n]*openssh-server/);
  });
  it("only the exact value 1 keeps sshd, and the marker is written only on that branch", () => {
    expect(build.match(/STAGING_OPS_SSH/g)!.length).toBeGreaterThanOrEqual(2);
    expect(build.match(/> \/etc\/murage-image-kind/g)).toHaveLength(1);
  });
  it("does not purge sshd or run the release check itself: hz-live still needs ssh after build-image.sh", () => {
    expect(build).not.toMatch(/^\s*apt-get purge[^\n]*openssh-server/m);
    expect(build).not.toMatch(/^[^#\n]*image-release-check\.sh/m);
    expect(build).not.toMatch(/rm -rf[^\n]*\/root\/\.ssh/);
  });
});

describe("finalize-customer-image.sh", () => {
  const fin = text("finalize-customer-image.sh");
  it("purges sshd, then runs the release check on the same disk, then syncs", () => {
    const purge = fin.indexOf("apt-get purge -y --auto-remove openssh-server");
    const rmKeys = fin.indexOf("rm -rf /etc/ssh/sshd_config /etc/ssh/sshd_config.d /root/.ssh /etc/ssh/ssh_host_*");
    const gate = fin.indexOf('image-release-check.sh" /');
    const sync = fin.lastIndexOf("\nsync");
    expect(purge).toBeGreaterThan(0);
    expect(rmKeys).toBeGreaterThan(purge);
    expect(gate).toBeGreaterThan(rmKeys);
    expect(sync).toBeGreaterThan(gate);
    expect(fin).toMatch(/^set -euo pipefail$/m);
  });
});

describe("hz-live image publish", () => {
  const hz = text("qualify/hz-live.py");
  it("labels every snapshot with its kind, passes the flag through, and verifies the exact snapshot id", () => {
    expect(hz).toContain('"murage/image-kind": image_kind');
    expect(hz).toContain('image_kind = "staging-ops-ssh" if staging_ops_ssh else "unverified"');
    expect(hz).toContain('"STAGING_OPS_SSH=1 " if staging_ops_ssh else ""');
    expect(hz).toContain('"-stagingssh" if staging_ops_ssh');
    expect(hz).toContain("def cmd_verify_image(self, image_id, ssh_key");
    expect(hz).toContain('sub.add_parser("verify-image"');
  });
  it("the build step can never label an image customer: only the verify-image PASS path writes it", () => {
    expect(hz.match(/"murage\/image-kind": "customer"/g)).toHaveLength(1);
    const verify = hz.indexOf("def cmd_verify_image");
    expect(hz.indexOf('"murage/image-kind": "customer"')).toBeGreaterThan(verify);
    expect(hz).not.toMatch(/image_kind = [^\n]*"customer"/);
  });
  it("verify-image runs in rescue, mounts read-only, and deletes by exact id in a finally block", () => {
    const v = hz.slice(hz.indexOf("def cmd_verify_image"), hz.indexOf("def run(self, argv"));
    const order = ['"/servers"', "enable_rescue", "poweron", "mount -o ro,noload", "bash -s -- /mnt/img", "finally:", "delete_verifier(created", 'self.c.request("PUT", "/images/']
      .map((m) => v.indexOf(m));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("runs the sshd purge and release check LAST: after every other remote step, before the shutdown, and verify comes after", () => {
    const iBuild = hz.indexOf("deploy/cloud-home/build-image.sh");
    const iCheck = hz.indexOf("check = (");
    const iFinal = hz.indexOf('check += "; bash /run/finalize-customer-image.sh');
    const iRun = hz.indexOf("res = self.run(ssh + [check]");
    const iShut = hz.indexOf("/actions/shutdown");
    const iSnap = hz.indexOf("/actions/create_image");
    expect(iBuild).toBeGreaterThan(0);
    for (const [a, b] of [[iBuild, iCheck], [iCheck, iFinal], [iFinal, iRun], [iRun, iShut], [iShut, iSnap]]) expect(a).toBeLessThan(b);
    // no ssh call and no remote command after the check session
    const between = hz.slice(iRun + 20, iSnap);
    expect(between).not.toMatch(/ssh \+/);
    expect(hz.slice(iFinal - 200, iFinal)).toContain("if not staging_ops_ssh");
    // the finalize script is run from /run (the checkout under /build is deleted earlier in the same command)
    expect(hz).toContain("cp /build/murage/deploy/cloud-home/finalize-customer-image.sh /build/murage/deploy/cloud-home/image-release-check.sh /run/");
    expect(hz.indexOf("rm -rf /build")).toBeLessThan(hz.indexOf("; bash /run/finalize-customer-image.sh"));
    // nothing is appended to the check command after the finalize call
    expect(hz.slice(iFinal + 20, iRun).match(/check \+=/g)).toBeNull();
  });
});

describe("image-release-check.sh", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) removeTempDirSync(r); });
  const dpkg = (...pkgs: [string, string][]) => pkgs.map(([n, st]) => `Package: ${n}\nStatus: ${st}\nVersion: 1\n`).join("\n");
  function root(opts: { status?: string; files?: string[] } = {}) {
    const r = mkdtempSync(join(tmpdir(), "relcheck-")); roots.push(r);
    mkdirSync(join(r, "var/lib/dpkg"), { recursive: true });
    writeFileSync(join(r, "var/lib/dpkg/status"), opts.status ?? dpkg(["openssh-client", "install ok installed"], ["bash", "install ok installed"]));
    for (const f of opts.files ?? []) { mkdirSync(join(r, f, ".."), { recursive: true }); writeFileSync(join(r, f), "x\n"); }
    return r;
  }
  const run = (r: string, id = "12345") => spawnSync("bash", [check, r, id], { encoding: "utf8" });
  it("passes a customer image: client only, no daemon, no unit, no marker, and names the image id", () => {
    const res = run(root());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ok image=12345");
  });
  it("fails when openssh-server is installed, and when it is only removed-but-configured", () => {
    for (const st of ["install ok installed", "deinstall ok config-files"]) {
      const res = run(root({ status: dpkg(["openssh-client", "install ok installed"], ["openssh-server", st]) }));
      expect(res.status).toBe(1); expect(res.stdout).toContain("openssh-server package is present");
    }
  });
  it("passes a fully purged openssh-server stanza", () => {
    expect(run(root({ status: dpkg(["openssh-server", "purge ok not-installed"]) })).status).toBe(0);
  });
  it("fails on the daemon binary, config, host keys, root ssh dir, or any ssh listener unit", () => {
    for (const f of ["usr/sbin/sshd", "etc/ssh/sshd_config", "etc/ssh/ssh_host_ed25519_key", "root/.ssh/authorized_keys",
      "usr/lib/systemd/system/ssh.service", "usr/lib/systemd/system/ssh.socket", "etc/systemd/system/sshd.service", "lib/systemd/system/sshd.socket"]) {
      const res = run(root({ files: [f] }));
      expect(res.status, f).toBe(1);
    }
  });
  it("fails on the staging marker, whatever it says", () => {
    const res = run(root({ files: ["etc/murage-image-kind"] }));
    expect(res.status).toBe(1); expect(res.stdout).toContain("marker /etc/murage-image-kind");
    const r = root(); mkdirSync(join(r, "etc"), { recursive: true });
    writeFileSync(join(r, "etc/murage-image-kind"), "staging-ops-ssh\n");
    expect(run(r).status).toBe(1);
  });
  it("fails closed when the package database cannot be read", () => {
    const r = mkdtempSync(join(tmpdir(), "relcheck-")); roots.push(r);
    expect(run(r).status).toBe(1);
  });
  it("is read-only: it creates and changes nothing in the image", () => {
    const src = text("image-release-check.sh");
    expect(src).not.toMatch(/\b(rm|mv|cp|apt-get|dpkg --|systemctl|sed -i)\b/);
  });
});
