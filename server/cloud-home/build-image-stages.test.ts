// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane G (r3 sec. 2, Grok ruling d, conditions 4 and 5): build-image.sh is two explicit stages. Stage 1 (MURAGE_IMAGE_STAGE=tree) builds the
// final tree once and stops, unsealed, with a marker; stage 2 (MURAGE_IMAGE_STAGE=seal) is only the signed-slot block onward and refuses
// without that marker. No stage set is a refusal, never a partial build. The image build itself needs root on Ubuntu, so the gating that
// matters is pinned three ways: the script really refuses with no stage (it checks the stage before anything else), the marker helper
// really refuses a missing, foreign or tampered tree, and the script's structure puts the marker check first in stage 2 with no pnpm after it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const repo = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const build = readFileSync(repo("deploy/cloud-home/build-image.sh"), "utf8");
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(cmd, args, { encoding: "utf8", env });
const revision = "a".repeat(40);

describe("build-image.sh stage gating", () => {
  it("fails closed with a clear message when no stage (or an unknown one) is set, before it changes anything", () => {
    for (const stage of [undefined, "", "all", "TREE", "tree,seal", "build"]) {
      const env = { ...process.env };
      delete env.MURAGE_IMAGE_STAGE;
      if (stage !== undefined) env.MURAGE_IMAGE_STAGE = stage;
      const ran = sh("bash", [repo("deploy/cloud-home/build-image.sh"), revision, "/nonexistent"], env);
      expect(ran.status, String(stage)).toBe(1);
      expect(ran.stdout, String(stage)).toContain('MURAGE_IMAGE_STAGE must be "tree"');
      expect(ran.stdout, String(stage)).toContain("no one-pass build");
    }
    // The stage is validated on line one of the work: before the root check, the os check, the apt setup or any download.
    const gate = build.indexOf("MURAGE_IMAGE_STAGE must be");
    for (const later of ["id -u", "/etc/os-release", "apt-get", "curl -fsSL", "pnpm install", "chattr"]) expect(build.indexOf(later), later).toBeGreaterThan(gate);
  });

  it("stage 1 builds with pnpm once, then writes the marker and exits before the signed-slot block; stage 2 starts with the marker check and never builds", () => {
    const stage1Start = build.indexOf("if [[ $image_stage = tree ]]; then");
    const mark = build.indexOf('image-stage.py" mark');
    const stage1End = build.indexOf("exit 0\nfi\n", mark);
    const check = build.indexOf('image-stage.py" check');
    const signedSlot = build.indexOf("Slot A is signed (LANE-G r3 sec. 2)");
    expect(stage1Start).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(stage1Start);
    expect(stage1End).toBeGreaterThan(mark);
    expect(check).toBeGreaterThan(stage1End);
    expect(signedSlot).toBeGreaterThan(check);
    const stage1 = build.slice(stage1Start, stage1End);
    expect(stage1).toContain("pnpm install --frozen-lockfile");
    expect(stage1).toContain('pnpm build');
    expect(stage1).toContain("chown -R root:root /opt/murage-releases");
    // The signed-slot inputs are not stage 1's: it never needs, reads or checks them.
    expect(stage1).not.toContain("MURAGE_RELEASE_MANIFEST");
    expect(stage1).not.toContain("chattr");
    expect(stage1).not.toContain("systemctl enable");
    const stage2 = build.slice(stage1End);
    for (const forbidden of ["pnpm", "corepack", "curl ", "git -C \"$source_dir\" archive", "apt-get -S", "ln -s", "useradd", "tar -x"]) {
      expect(stage2.includes(forbidden), `stage 2 must not contain ${forbidden}`).toBe(false);
    }
    // Everything the seal does is in stage 2, in this order: marker, inputs, verify + digest, install trust root, seal, enable units.
    const order = ['image-stage.py" check', "MURAGE_RELEASE_CHANNEL_URL:-", "home.verify_manifest(", 'if digest != manifest["treeSha256"]:', "seal_tree /opt/murage-releases/A", "systemctl enable murage-commands.service"];
    let last = -1;
    for (const part of order) {
      const at = stage2.indexOf(part);
      expect(at, part).toBeGreaterThan(last);
      last = at;
    }
    // The stage 1 marker is builder state: gone before the image is snapshotted.
    expect(stage2).toContain("rm -rf /var/lib/murage-image-build");
    expect(stage2.indexOf("rm -rf /var/lib/murage-image-build")).toBeGreaterThan(stage2.indexOf("systemctl enable murage-commands.service"));
  });

  it("the tree stage refuses to run twice on one host", () => {
    expect(build).toContain("[[ ! -e $stage_marker ]] ||");
    expect(build.indexOf("[[ ! -e $stage_marker ]]")).toBeLessThan(build.indexOf("pnpm install --frozen-lockfile"));
  });
});

describe("image-stage.py marker (what stage 2 checks before anything else)", () => {
  const work = mkdtempSync(join(tmpdir(), "murage-stage-"));
  afterAll(() => removeTempDirSync(work));
  const helper = repo("deploy/cloud-home/image-stage.py");
  const commands = repo("deploy/cloud-home/murage-commands");
  const tree = join(work, "A");
  const marker = join(work, "state", "stage1.json");
  const hostId = join(work, "machine-id");
  const run = (action: "mark" | "check", over: { rev?: string; host?: string; markerPath?: string } = {}) =>
    sh("python3", ["-I", helper, action, commands, tree, over.rev ?? revision, over.markerPath ?? marker, over.host ?? hostId]);

  it("refuses stage 2 without a stage 1 marker on this host", () => {
    mkdirSync(join(tree, "dist-server"), { recursive: true });
    mkdirSync(join(tree, "deploy"), { recursive: true });
    writeFileSync(join(tree, "dist-server/index.js"), "// server\n");
    writeFileSync(join(tree, "deploy/launchers.txt"), "abi 1\n");
    writeFileSync(hostId, "0123456789abcdef0123456789abcdef\n");
    const refused = run("check");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("no stage 1 marker on this host");
    expect(existsSync(marker)).toBe(false);
  });

  it("stage 1 marks the final tree; the marker is accepted for the same revision, host and tree and carries the digest", () => {
    const made = run("mark");
    expect(made.status, made.stdout + made.stderr).toBe(0);
    const record = JSON.parse(readFileSync(marker, "utf8")) as Record<string, string>;
    expect(Object.keys(record).sort()).toEqual(["format", "hostId", "machine", "revision", "treeSha256"]);
    expect(record.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.revision).toBe(revision);
    expect(run("check").status).toBe(0);
    // Stage 1 never reruns on a host that has a marker.
    const again = run("mark");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already completed");
  });

  it("refuses stage 2 for another revision, another host, or a marker that is not the helper's", () => {
    const rev = run("check", { rev: "b".repeat(40) });
    expect(rev.status).toBe(1);
    expect(rev.stderr).toContain("another revision");
    const otherHost = join(work, "other-machine-id");
    writeFileSync(otherHost, "ffffffffffffffffffffffffffffffff\n");
    const host = run("check", { host: otherHost });
    expect(host.status).toBe(1);
    expect(host.stderr).toContain("not completed on this host");
    const forged = join(work, "forged.json");
    writeFileSync(forged, JSON.stringify({ format: "murage-image-stage1-v1", revision, machine: "x86_64" }));
    expect(run("check", { markerPath: forged }).status).toBe(1);
    writeFileSync(forged, "not json");
    expect(run("check", { markerPath: forged }).status).toBe(1);
  });

  it("refuses stage 2 when the tree changed after stage 1: a changed file, an added file, a removed file, a changed link", () => {
    const original = readFileSync(join(tree, "dist-server/index.js"));
    writeFileSync(join(tree, "dist-server/index.js"), "// server, tampered\n");
    const changed = run("check");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("the tree changed after stage 1");
    writeFileSync(join(tree, "dist-server/index.js"), original);
    expect(run("check").status).toBe(0);
    writeFileSync(join(tree, "dist-server/extra.js"), "// added\n");
    expect(run("check").status).toBe(1);
    rmSync(join(tree, "dist-server/extra.js"));
    rmSync(join(tree, "deploy/launchers.txt"));
    expect(run("check").status).toBe(1);
    writeFileSync(join(tree, "deploy/launchers.txt"), "abi 1\n");
    expect(run("check").status).toBe(0);
  });
});
