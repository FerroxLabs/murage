// SPDX-License-Identifier: AGPL-3.0-or-later
// LANE-G r3 / A1, the static pins: the one layout predicate in both seams (T-S4), every exec that can name slot bytes goes through
// exec_slot (T-P2), the image's trust and launcher deltas (T-L1', T-T3 build part, Astra C), the unit deltas (sec. 2) and the start
// script (sec. 7). The behaviour itself runs in home-commands.fixture.py (home-commands.test.ts).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const read = (name: string) => readFileSync(repo(name), "utf8");
const commands = read("deploy/cloud-home/murage-commands");
const launcher = read("deploy/cloud-home/murage-home-launch.py");
const turn = read("deploy/cloud-home/murage-turn-launch.py");
const build = read("deploy/cloud-home/build-image.sh");
const shared = (source: string) => source.slice(source.indexOf("# ==== shared with deploy/cloud-home/murage-home-launch.py"), source.indexOf("# ==== end shared ===="));

describe("one layout predicate, one seal walk (T-S4)", () => {
  it("keeps the shared block byte-identical in murage-commands and murage-home-launch", () => {
    const block = shared(commands);
    expect(block.length).toBeGreaterThan(5000);
    expect(shared(launcher)).toBe(block);
    for (const name of ["def layout_ok(state, current, env):", "def seal_walk_digest(dirfd, sealed):", "def verified_slot(env, name):", "def parse_update_state(raw):", "def read_trust(trust):", "def parse_manifest(raw, arch):"]) expect(block).toContain(name);
    // The predicate's phase table (A1.2): committed group needs current == installed; transitions allow exactly these.
    expect(block).toContain('allowed = {"flip": (live, candidate), "verify": (candidate,), "rollback": (live,) if inflight["restored"] else (live, candidate)}');
    expect(block).toContain('if candidate == live or phase not in allowed or current not in allowed[phase]:');
  });
  it("gates every slot on its signed manifest and seal, with no unsigned path (Astra C, T-T3, T-H4b)", () => {
    // verified_slot is the one integrity gate; nothing else reads a stored manifest or accepts a digest without the signature check.
    expect(commands.match(/def verified_slot\(env, name\)/gu)).toHaveLength(1);
    expect(commands).not.toMatch(/treeSha256.*installed|installed.*treeSha256/u);
    expect(commands).not.toMatch(/expected_digest/u);
    expect(launcher).not.toMatch(/expected_digest/u);
    // The only writer of `installed` is the commit, reachable only after wait_healthy returned True in the same drive (T-H4b).
    const writers = [...commands.matchAll(/state\["installed"\] = /gu)];
    expect(writers).toHaveLength(1);
    const verify = commands.slice(commands.indexOf('elif phase == "verify":'), commands.indexOf('elif phase == "rollback":'));
    expect(verify).toContain("if wait_healthy(ctx):");
    expect(verify.indexOf("if wait_healthy(ctx):")).toBeLessThan(verify.indexOf('state["installed"] = '));
    // Every Stuck raised by the drive passes through one stop (A1.3), and rollback stops at entry and after writing phase := rollback.
    expect(commands).toContain("except Stuck as stuck:\n            print(\"Self-service update stuck: \" + stuck.code, file=sys.stderr)\n            stop_writers(ctx)\n            raise");
    expect(commands).toMatch(/def enter_rollback\(ctx, state, reason\):[\s\S]*write_update_state\(ctx, state\)\n    stop_writers\(ctx\)/u);
    expect(commands).toMatch(/if not inflight\["restored"\]:\n\s+(?:#[^\n]*\n\s+)*if not stop_writers\(ctx\):\n\s+raise Stuck\("rollback_stop"\)/u);
    // Health is accepted only after this drive's own stop and grant_and_start of the previous slot (rollback stop gating).
    expect(commands).toMatch(/if not stop_writers\(ctx\):\n\s+raise Stuck\("rollback_stop"\)\n\s+if inflight\["rollbackAttempts"\] >= ROLLBACK_ATTEMPTS:[\s\S]*grant_and_start\(ctx, drive_id, previous\)\n\s+if wait_healthy\(ctx\):/u);
    // Counters are written before the one start they bound (Astra D / H6).
    for (const counter of ['inflight["verifyAttempts"] += 1', 'inflight["rollbackAttempts"] += 1']) {
      const at = commands.indexOf(counter);
      expect(at).toBeGreaterThan(-1);
      const after = commands.slice(at, at + 400);
      expect(after.indexOf("write_update_state(ctx, state)")).toBeLessThan(after.indexOf("grant_and_start("));
    }
    // No commandId exemption anywhere: starts come from grants only.
    expect(commands).not.toMatch(/recovery_pending\(ctx, /u);
    expect(commands).not.toMatch(/(?<![a-z_])start_home\(ctx, /u);
  });
});

describe("no release-slot byte executes with uid 0 (T-P2, sec. 1.3)", () => {
  it("routes every exec that can name slot bytes through exec_slot in both launchers", () => {
    for (const [name, source] of [["murage-turn-launch.py", turn], ["murage-home-launch.py", launcher]] as const) {
      const guard = source.slice(source.indexOf("def exec_slot(path, argv, env):"), source.indexOf("os.execve(path, argv, env)"));
      expect(guard, name).toContain("if os.getuid() == 0 or os.geteuid() == 0 or 0 in os.getgroups():");
      expect(guard, name).toContain("os._exit(1)");
      // The only os.execve left are exec_slot's own and, in the turn launcher, pasta after the turn user drop (not slot bytes); execvpe is gone.
      const execs = [...source.matchAll(/^.*os\.execve\(.*$/gmu)].map((m) => m[0].trim());
      expect(execs.filter((line) => line !== "os.execve(path, argv, env)" && line !== "os.execve(PASTA, pasta_argv(turn_dir), env)"), name).toEqual([]);
      expect(source, name).not.toContain("os.execvpe(");
    }
    // pasta_child's execv (inside pasta's user namespace, where the turn user is uid 0) is the one deliberate exception: not slot bytes (bwrap).
    expect(turn.match(/\bexecv\(argv\[0\], argv\)/gu)).toHaveLength(1);
    for (const site of ["exec_slot(argv[0], argv, os.environ)", "exec_slot(binary, [binary] + HOST_WARMUP, env)", 'exec_slot(node, [node, "--max-old-space-size=%d" % BROWSER_RESTORE_HEAP_MB, script] + argv, plan["env"])', "exec_slot(argv[0], argv, env)", "exec_slot(BROWSER_BINARY, [BROWSER_BINARY] + args, os.environ)", "exec_slot(found, sys.argv[2:], os.environ)"]) expect(turn).toContain(site);
    // The restore step's uid guard is unconditional (the drop flag only names whose setuid it is).
    expect(turn).toMatch(/if drop:\n\s+os\.setgroups\(\[\]\); os\.setgid\(gid\); os\.setuid\(uid\)\n\s+if os\.getuid\(\) == 0 or os\.geteuid\(\) == 0:\n\s+os\._exit\(1\)/u);
    // The self-inode check at the sudo entry (sec. 1.6), after the SUDO_UID gate.
    expect(turn.indexOf('raise ValueError("Cloud turn launcher requires the home server")\n    assert_image_launcher()')).toBeGreaterThan(-1);
    expect(turn).toContain('IMAGE_LAUNCHER = "/usr/local/libexec/murage-turn-launch"');
  });
  it("execs the slot supervisor through the verified descriptor after the drop, with an environment built from scratch", () => {
    expect(launcher).toContain('exec_slot(node, [node, "/proc/self/fd/%d/%s" % (dirfd, SUPERVISOR)], env)');
    const main = launcher.slice(launcher.indexOf("def main():"));
    expect(main.indexOf("drop_privileges(identity)")).toBeLessThan(main.indexOf("exec_supervisor(dirfd, env)"));
    expect(launcher).toMatch(/def supervisor_env\([\s\S]*env = \{"PATH": "\/usr\/local\/bin:\/usr\/bin:\/bin", "LANG": "C\.UTF-8", "MURAGE_CLOUD_SECRETS_FD": "3", "MURAGE_RELEASE_ROOT": releases \+ "\/" \+ slot,/u);
    expect(launcher).not.toContain("os.environ.copy()");
    expect(launcher).not.toContain("env=os.environ");
  });
});

describe("image and unit deltas (sec. 2, sec. 7)", () => {
  it("build-image.sh installs two slots, image-pinned launchers and a mandatory signed slot A; the unsigned fallback is gone", () => {
    expect(build).toContain("install -d -o root -g root -m 0755 /opt/murage-releases /opt/murage-releases/A /etc/murage-home /usr/local/libexec");
    expect(build).toContain("ln -s A /opt/murage-releases/current");
    expect(build).toContain("ln -s murage-releases/current /opt/murage");
    expect(build).toContain('git -C "$source_dir" archive "$revision" | tar -x -C /opt/murage-releases/A');
    expect(build).toContain("install -o root -g root -m 0755 deploy/cloud-home/murage-home-launch.py /usr/local/libexec/murage-home-launch");
    expect(build).toContain("chown -R root:root /opt/murage-releases");
    expect(build).toContain("chmod -R go-w /opt/murage-releases");
    expect(build).toMatch(/\[\[ -n \$\{MURAGE_RELEASE_CHANNEL_URL:-\} && -n \$\{MURAGE_RELEASE_PUBLIC_KEY:-\} && -n \$\{MURAGE_RELEASE_MANIFEST:-\} && -n \$\{MURAGE_RELEASE_MANIFEST_SIG:-\} \]\]/u);
    expect(build).not.toContain("/etc/murage-home/release-public-key.pem");
    expect(build).not.toContain("/etc/murage-home/release.json");
    expect(build).not.toMatch(/unsupported/u);
    expect(build).toContain('manifest = home.verify_manifest({"verify": home.verify_signature}, raw, signature, key)');
    expect(build).toContain('if digest != manifest["treeSha256"]:');
    expect(build).toContain('"minimumSequence": manifest["sequence"]');
    for (const seal of ["seal_tree /opt/murage-releases/A", "chattr +i /opt/murage-releases", "seal_tree /var/lib/murage-update /usr/lib/murage-home/trust",
      "chattr +i /usr/local/libexec/murage-turn-launch /usr/local/libexec/murage-browser-namespace /usr/local/libexec/murage-browser-network /usr/local/libexec/murage-home-launch /usr/local/libexec"]) expect(build).toContain(seal);
    expect(build).toContain('$(lsattr -d "/usr/local/libexec/$launcher" | cut -d\' \' -f1) == *i*');
    expect(build.indexOf("chattr +i /usr/local/libexec/murage-turn-launch")).toBeGreaterThan(build.lastIndexOf("install -o root -g root -m 0755 deploy/cloud-home/murage-commands /usr/local/libexec/murage-commands"));
  });
  it("declares one launcher ABI in launchers.txt and launcher-abi, and the installer reads it", () => {
    const abi = read("deploy/cloud-home/launcher-abi").trim();
    expect(abi).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    const lines = read("deploy/cloud-home/launchers.txt").split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines[0]).toBe(`abi ${abi}`);
    expect(lines.slice(1).map((l) => l.split(/\s+/u)[1]).sort()).toEqual(["murage-browser-namespace", "murage-browser-network", "murage-turn-launch"]);
    const installer = read("deploy/cloud-home/install-launchers.py");
    for (const gone of ["def stage(", "def prepare(", "def swap(", "def restore(", "def cleanup(", "def verify_links(", "LINK_TARGET"]) expect(installer).not.toContain(gone);
    for (const kept of ["def plan(", "def abi(", "def check_abi(", "def apply_modes(", "def install("]) expect(installer).toContain(kept);
    const probe = spawnSync("python3", ["-I", "-c", `import importlib.machinery,importlib.util,sys
l=importlib.machinery.SourceFileLoader("il",sys.argv[1]);s=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(s);l.exec_module(m)
print(m.abi(sys.argv[2]))`, repo("deploy/cloud-home/install-launchers.py"), repo("deploy/cloud-home")], { encoding: "utf8" });
    expect(probe.stdout.trim()).toBe(abi);
  });
  it("murage-home.service follows the updater by Wants= (never Requires=), leaves the inhibit to the launcher and treats 79 as final", () => {
    const unit = read("deploy/cloud-home/murage-home.service");
    expect(unit).toMatch(/^After=.*\bmurage-commands\.service\b/mu);
    expect(unit).toMatch(/^Wants=.*\bmurage-commands\.service\b/mu);
    expect(unit).not.toMatch(/^(Requires|BindsTo)=.*murage-commands/mu);
    expect(unit).not.toMatch(/^ConditionPathExists=/mu);
    expect(unit).toMatch(/^RestartPreventExitStatus=78 79$/mu);
    expect(unit).toMatch(/^ReadOnlyPaths=\/opt \/var\/lib\/murage-update$/mu);
    expect(unit).toMatch(/^ReadWritePaths=\/etc\/murage-home$/mu);
    expect(unit).not.toMatch(/^InaccessiblePaths=/mu);
    expect(read("deploy/cloud-home/murage-home-recover.service")).toContain("ConditionPathExists=!/var/lib/murage-home/recovery-inhibit");
    const runner = read("deploy/cloud-home/murage-commands.service");
    expect(runner).toMatch(/^ReadWritePaths=.*\/var\/lib\/murage-update/mu);
    expect(runner).toMatch(/^RuntimeDirectory=murage-update$/mu);
    expect(runner).toMatch(/^RuntimeDirectoryMode=0700$/mu);
  });
  it("start-home.sh hands over to the image launcher; the sudoers line is unchanged and names an image-owned regular file", () => {
    const start = read("deploy/cloud-home/start-home.sh");
    expect(start.trim().split("\n").at(-1)).toBe("exec /usr/bin/python3 -I /usr/local/libexec/murage-home-launch");
    expect(start).not.toContain("cloud-home-supervisor.js");
    const sudoers = read("deploy/cloud-home/murage-turn.sudoers");
    expect(sudoers).toMatch(/^murage ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/murage-turn-launch ""$/mu);
    expect(sudoers).toMatch(/^# .*image-owned regular file.*never a link into a release slot/mu);
    // The release script signs the tree digest and the launcher ABI (manifest v3) with the checkout's own code.
    const release = read("scripts/cloud-home-release.sh");
    expect(release).toContain('"format":"murage-cloud-home-release-v3"');
    expect(release).toContain('"treeSha256":"%s","launcherAbi":"%s"');
    expect(release).toContain("home.seal_walk_digest(fd, False)");
    expect(release).toContain('installer.check_abi(os.path.join(work, "check"), manifest["launcherAbi"])');
  });
  it("murage-commands drives the update only from the trust root, keeps --recover-update flagless and serves the gate", () => {
    expect(commands).toContain('TRUST = "/usr/lib/murage-home/trust"');
    expect(commands).not.toMatch(/path\(ctx, "config", "release/u);
    expect(commands).toContain('sys.argv[1:] not in ([], ["--recover-update"])');
    expect(commands).toContain("def gate_server(ctx):");
    expect(commands).toContain('HOME_CGROUP = "0::/system.slice/murage-home.service"');
    expect(launcher).toContain('COMMANDS_CGROUP = "0::/system.slice/murage-commands.service"');
    expect(commands).toContain("os.pidfd_open(pid)");
    expect(commands).toContain("socket.SO_PEERCRED");
    expect(launcher).toContain("socket.SO_PEERCRED");
  });
});
