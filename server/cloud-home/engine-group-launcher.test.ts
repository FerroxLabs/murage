// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const run = (cwd: string, walked: string) => execFileSync("python3", ["-I", "-c", `
import os, sys, runpy, types
# run_path returns a copy; patch the globals launch() actually resolves.
m = runpy.run_path(sys.argv[1])['launch'].__globals__
calls, walked, lookups = [], [], []
m['validate_request'] = lambda r, login=False: ("codex", "HOME", sys.argv[2], "cmd", [], {}, None, "atlas")
m['check_protected_hardlinks'] = lambda: None
m['open_directory'] = lambda path: path
m['anchor_mounts'] = lambda mounts: mounts
prepared = []
m['mount_turn_home'] = lambda uid, gid: calls.append(("home", uid, gid)) or ("/run/murage-turn/home", -1)
m['stage_turn_home'] = lambda home_fd, engine, turn_fd, gid, owners, ids, uid=None, bot=None, **k: prepared.append((home_fd, engine, gid, owners, uid, bot)) or {}
m['collect_turn_home'] = lambda *a, **k: calls.append(("collect",)) or []
m['run_turn'] = lambda child, collect, capture=None: (child(), 0)[1]
m['private_mount_namespace'] = lambda: None
m['turn_mount_args'] = lambda *a, **k: (["/usr/bin/bwrap", "--cap-drop", "ALL", "--", "/bin/true"], {"f0": "x"})
m['seccomp_filter'] = lambda: b"12345678"
plan = {}
def write_turn_dir(argv, blobs, gid):
    calls.append(("write", gid)); plan.update(argv=argv, blobs=dict(blobs)); return "/run/murage-turn/t-0123456789abcdef"
m['write_turn_dir'] = write_turn_dir
m['pwd'] = types.SimpleNamespace(getpwnam=lambda n: types.SimpleNamespace(pw_uid={"murage": 10, "murage-turn": 20}[n], pw_gid={"murage": 11, "murage-turn": 21}[n]))
def getgrnam(name):
    lookups.append(name); return types.SimpleNamespace(gr_gid={"murage-eng-codex": 4242, "murage-eng-pi": 4343, "murage-sandbox": 5151}[name])
m['grp'] = types.SimpleNamespace(getgrnam=getgrnam)
os.fwalk = lambda top, dir_fd=None, follow_symlinks=True: walked.append(dir_fd) or iter(())
os.setgroups = lambda groups: calls.append(("setgroups", list(groups)))
os.setgid = lambda gid: calls.append(("setgid", gid))
os.setuid = lambda uid: calls.append(("setuid", uid))
os.umask = lambda mask: 0
pasta_seen = []
def execve(path, argv, env):
    calls.append(("execve",)); pasta_seen.extend([path, argv, env]); raise SystemExit(0)
os.execve = execve
try: m['launch']({})
except SystemExit as e: assert e.code == 0
assert [p[1:] for p in prepared] == [("codex", 4242, (0, 20), 20, "atlas")], prepared
assert lookups == ["murage-eng-codex", "murage-sandbox"], lookups
assert calls == [("home", 20, 4242), ("write", 21), ("setgroups", [4242, 5151, 21]), ("setgid", 4242), ("setuid", 20), ("execve",)], calls
assert plan["argv"] == ["/usr/bin/bwrap", "--cap-drop", "ALL", "--seccomp", "@fd:seccomp", "--", "/bin/true"], plan
assert plan["blobs"] == {"f0": "x", "seccomp": b"12345678"}, plan
assert pasta_seen[0] == "/usr/bin/pasta" and pasta_seen[1][-2:] == ["--pasta-child", "/run/murage-turn/t-0123456789abcdef"], pasta_seen
assert walked == [w for w in sys.argv[3].split(",") if w], walked
print("engine group fixture passed")
`, launcher, cwd, walked], { encoding: "utf8" });
it("launch() makes the selected engine's group primary (murage-turn's group and the bwrap-gate group supplementary) and never re-groups the engine home", () => {
  expect(run("CWD", "CWD").trim()).toBe("engine group fixture passed");
});
it("launch() skips the group-widening walk entirely when cwd is the engine home", () => {
  expect(run("HOME", "").trim()).toBe("engine group fixture passed");
});
