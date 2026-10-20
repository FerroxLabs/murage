// SPDX-License-Identifier: AGPL-3.0-or-later
// r6 R1 to r9 (CLOUD-ENGINES-DESIGN.md): admission, liveness, release and tombstones. flock on root-owned
// files under LIVE_DIR is the state. The supervisor admits a turn (bot and workspace-owner locks shared,
// tombstone check, the entry exclusive) and hands the locks through the exec on fixed inheritable
// descriptors; release takes the locks exclusively, treats an entry as live while its lock is held OR its
// scope's cgroup directory exists, tombstones the id for good and erases the bot's trees and stores. The
// harness drives the real launcher Python in throwaway directories; the immutable ioctl is a seam.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcher, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-admission-"); });
afterEach(() => rig.dispose());

// Every fixture runs with the launcher's roots pointed at the rig and this vocabulary.
const prelude = `
import fcntl, signal, stat, subprocess, time
root=sys.argv[2]
m.LIVE_DIR=root+"/live"; m.TOMBSTONE_DIR=root+"/deleted"; m.WORKSPACE_ROOT=root+"/ws"; m.ENGINE_ROOT=root+"/engines"; m.CGROUP_ROOT=root+"/cgroup"
for d in (m.WORKSPACE_ROOT, m.ENGINE_ROOT, m.CGROUP_ROOT+"/murage.slice/murage-turns.slice"): os.makedirs(d, exist_ok=True)
U=lambda n: "murage-turn-%016x.scope"%n
def req(bot, cwd=None, args=()): return {"bot":bot,"cwd":cwd or m.WORKSPACE_ROOT+"/"+bot,"args":list(args)}
def release(bot, **kw):
    try: m.bot_state_release({"mode":"bot-state-release","bot":bot}, **kw); return "ok"
    except m.Refusal as e: return str(e)
def admit(bot, unit, **kw):
    try: return m.admit(req(bot, **kw), unit, bot)
    except m.Refusal as e: return str(e)
def cgroup(unit): return m.slice_cgroup_path(m.TURN_SLICE, unit)
out=[]
`;
const run = (source: string) => rig.py(prelude + source + "\nprint(json.dumps(out))", rig.root);
const result = (source: string) => JSON.parse(run(source)) as unknown[];

describe("admission against release (r6 R1 fixture 3)", () => {
  it("a turn's shared locks refuse release both ways, and a dead holder's locks are gone", () => {
    expect(result(`
out.append(admit("alpha", U(1)))                      # held SH on bot-alpha, ws-alpha, EX on the entry
out.append(release("alpha"))                          # refused: bot-alpha is shared-locked
out.append(os.path.exists(m.TOMBSTONE_DIR+"/alpha"))  # a refusal tombstones nothing
# release of beta holding EX: a later admission of beta is refused
dfd=m.live_dir_fd(); ex=m.live_lock("bot-beta", dfd); fcntl.flock(ex, fcntl.LOCK_EX|fcntl.LOCK_NB)
out.append(admit("beta", U(2)))
os.close(ex); os.close(dfd)
# a holder that dies drops its locks: release proceeds against the dead turn
r,w=os.pipe(); pid=os.fork()
if pid==0:
    os.close(r); admit("gamma", U(3)); os.write(w,b"1"); time.sleep(30); os._exit(0)
os.close(w); os.read(r,1)
out.append(release("gamma"))
os.kill(pid, signal.SIGKILL); os.waitpid(pid,0)
out.append(release("gamma"))
out.append(sorted(os.listdir(m.LIVE_DIR)))
`)).toEqual([
      expect.objectContaining({ fds: 3, names: ["bot-alpha", "ws-alpha", "murage-turn-0000000000000001.scope"], bot: "alpha", roots: ["alpha"] }),
      "Cloud bot state is in use", false,
      "Cloud bot state is being released",
      "Cloud bot state is in use", "ok",
      ["bot-alpha", "bot-beta", "bot-gamma", "murage-turn-0000000000000001.scope", "store-gamma", "ws-alpha", "ws-gamma"],
    ]);
  });
  it("cross-workspace: B's turn in A's pinned workspace blocks release of A through ws-A and of B through bot-B; two releases of one bot", () => {
    expect(result(`
os.makedirs(m.WORKSPACE_ROOT+"/alpha/threads/t", exist_ok=True)
out.append(admit("beta", U(4), cwd=m.WORKSPACE_ROOT+"/alpha/threads/t")["roots"])
out.append(release("alpha")); out.append(release("beta"))
out.append(admit("delta", U(5))["names"]); out.append(release("delta"))
out.append(release("epsilon")); out.append(release("epsilon"))
out.append(os.path.exists(m.TOMBSTONE_DIR+"/epsilon"))
`)).toEqual([["alpha"], "Cloud bot state is in use", "Cloud bot state is in use", ["bot-delta", "ws-delta", "murage-turn-0000000000000005.scope"], "Cloud bot state is in use", "ok", "ok", true]);
  });
});

describe("tombstones (r7 fixture 10, r8 fixture 17)", () => {
  it("a release completed while an admission was parked makes that admission refuse, for good: no admit mode exists", () => {
    expect(result(`
out.append(release("alpha"))
out.append(admit("alpha", U(6)))
out.append(m.bot_state_query({"mode":"bot-state-query","bot":"alpha"})["tombstoned"])
out.append(m.bot_state_query({"mode":"bot-state-query","bot":"beta"})["tombstoned"])
out.append(hasattr(m, "bot_state_admit"))
out.append(m.scope_plan({"mode":"bot-state-admit","bot":"alpha"}) is not None)   # not an unscoped root mode: it is just a (refused) turn
try: m.verify_admission({"fds":1,"names":[U(7)],"bot":"alpha","roots":[]}, U(7), "alpha"); out.append("verified")
except (m.Refusal, ValueError) as e: out.append(str(e))
`)).toEqual(["ok", "Cloud bot was deleted", true, false, false, true, "Cloud turn admission descriptor is missing"]);
  });
  it("the tombstone and its directory are written and fsynced before anything is cleared, and a bad id never reaches a lock", () => {
    expect(result(`
calls=[]; real=os.fsync
m.os.fsync=lambda fd: calls.append(stat.S_ISDIR(os.fstat(fd).st_mode)) or real(fd)
os.makedirs(m.WORKSPACE_ROOT+"/alpha", exist_ok=True); open(m.WORKSPACE_ROOT+"/alpha/f","w").close()
out.append(release("alpha")); m.os.fsync=real
out.append(calls); out.append(os.path.exists(m.WORKSPACE_ROOT+"/alpha"))
for bad in ("../x", "a/b", "", "x"*65, 5):
    try: m.bot_state_release({"mode":"bot-state-release","bot":bad}); out.append("ran")
    except ValueError as e: out.append(str(e))
out.append(sorted(os.listdir(m.LIVE_DIR)))
`)).toEqual(["ok", [false, true], false, "Invalid cloud bot state request", "Invalid cloud bot state request", "Invalid cloud bot state request", "Invalid cloud bot state request", "Invalid cloud bot state request", ["bot-alpha", "store-alpha", "ws-alpha"]]);
  });
});

describe("liveness is lock held OR cgroup present (r7 fixture 11, r9 retention)", () => {
  it("an entry whose holder is dead stays live while its scope's cgroup directory exists; a dead supervisor changes nothing", () => {
    expect(result(`
r,w=os.pipe(); pid=os.fork()
if pid==0:
    os.close(r); admit("alpha", U(8)); os.write(w,b"1"); time.sleep(30); os._exit(0)
os.close(w); os.read(r,1)
os.makedirs(cgroup(U(8)))                    # the sandbox's descendants still live in the scope
os.kill(pid, signal.SIGKILL); os.waitpid(pid,0)   # the in-scope launcher and its supervisor are both gone
out.append(release("alpha"))
out.append(os.path.exists(m.LIVE_DIR+"/"+U(8)))
os.rmdir(cgroup(U(8)))
out.append(release("alpha"))
out.append(os.path.exists(m.LIVE_DIR+"/"+U(8)))
`)).toEqual(["Cloud bot state is in use", true, "ok", false]);
  });
  it("teardown unlinks the entry only once the cgroup is gone; an expired wait retains it and says so", () => {
    expect(result(`
admit("alpha", U(9)); os.makedirs(cgroup(U(9)))
clock=[0.0]
out.append(m.finish_admission(U(9), wait=1.0, sleep=lambda s: clock.__setitem__(0, clock[0]+s), clock=lambda: clock[0]))
out.append(os.path.exists(m.LIVE_DIR+"/"+U(9)))
out.append(release("alpha"))
os.rmdir(cgroup(U(9)))
out.append(m.finish_admission(U(9), wait=1.0, sleep=lambda s: None, clock=lambda: 0.0))
out.append(os.path.exists(m.LIVE_DIR+"/"+U(9)))
`)).toEqual([false, true, "Cloud bot state is in use", true, false]);
  });
  it("names the slice chain the way systemd nests it", () => {
    expect(run(`out.append(m.slice_cgroup_path("murage-turns.slice", U(1), "/sys/fs/cgroup")); out.append(m.slice_cgroup_path("a.slice", "x.scope", "/c"))`))
      .toContain('["/sys/fs/cgroup/murage.slice/murage-turns.slice/murage-turn-0000000000000001.scope", "/c/a.slice/x.scope"]');
  });
});

describe("lock order and unwinding (r7 fixture 14, r9 lock classes)", () => {
  it("lifetime locks before anything else, in order; release probes entries one at a time and lets them go before the next acquisition; a failed ws acquisition releases bot", () => {
    expect(result(`
m.LOCK_TRACE=[]
os.makedirs(m.WORKSPACE_ROOT+"/beta", exist_ok=True)
admit("alpha", U(10), args=["--add-dir", m.WORKSPACE_ROOT+"/beta", "--add-dir", m.WORKSPACE_ROOT+"/alpha.task"])
out.append(list(m.LOCK_TRACE)); m.LOCK_TRACE[:]=[]
# a second admission of gamma whose ws lock (ws-zeta, held exclusively by a release) fails must let bot-gamma go again
dfd=m.live_dir_fd(); ex=m.live_lock("ws-zeta", dfd); fcntl.flock(ex, fcntl.LOCK_EX|fcntl.LOCK_NB)
out.append(admit("gamma", U(11), cwd=m.WORKSPACE_ROOT+"/zeta"))
probe=m.live_lock("bot-gamma", dfd); fcntl.flock(probe, fcntl.LOCK_EX|fcntl.LOCK_NB); out.append("bot-gamma free")   # raises if admit left it held
os.close(probe); os.close(ex); os.close(dfd); m.LOCK_TRACE[:]=[]
# release of a bot with two dead entries: bot, ws, store, then one probe each, released at once
for n in (12, 13):
    r,w=os.pipe(); pid=os.fork()
    if pid==0:
        os.close(r); admit("delta", U(n)); os.write(w,b"1"); time.sleep(30); os._exit(0)
    os.close(w); os.read(r,1); os.kill(pid, signal.SIGKILL); os.waitpid(pid,0)
out.append(release("delta")); out.append(list(m.LOCK_TRACE))
`)).toEqual([
      [["bot-alpha", "sh"], ["ws-alpha", "sh"], ["ws-beta", "sh"], ["murage-turn-000000000000000a.scope", "ex"]],
      "Cloud bot state is being released", "bot-gamma free",
      "ok",
      [["bot-delta", "ex"], ["ws-delta", "ex"], ["store-delta", "ex"], ["murage-turn-000000000000000c.scope", "sh"], ["murage-turn-000000000000000c.scope", "un"], ["murage-turn-000000000000000d.scope", "sh"], ["murage-turn-000000000000000d.scope", "un"]],
    ]);
  });
});

describe("roots fence (r7 fixture 15) and the request's roots", () => {
  it("a request admitted with roots [cwd] whose validated argv adds an --add-dir outside them refuses", () => {
    expect(result(`
a=admit("alpha", U(14))
try: m.check_roots(a, m.WORKSPACE_ROOT+"/alpha/threads/t", ["--add-dir", m.WORKSPACE_ROOT+"/alpha.task"]); out.append("ok")
except m.Refusal as e: out.append(str(e))
try: m.check_roots(a, m.WORKSPACE_ROOT+"/alpha", ["--add-dir="+m.WORKSPACE_ROOT+"/beta"]); out.append("ok")
except m.Refusal as e: out.append(str(e))
try: m.check_roots(a, m.ENGINE_ROOT+"/claudeAgent", []); out.append("home cwd is no root")
except m.Refusal as e: out.append(str(e))
out.append(m.request_roots({"cwd": m.ENGINE_ROOT+"/codex", "args": ["--add-dir", m.WORKSPACE_ROOT+"/zed.x/y"]}))
try: m.request_roots({"cwd": m.WORKSPACE_ROOT+"/../etc"}); out.append("ran")
except m.Refusal as e: out.append(str(e))
`)).toEqual(["ok", "Cloud turn roots differ from admission", "home cwd is no root", ["zed"], "Cloud turn workspace is invalid"]);
  });
});

describe("the handoff through the exec (r8 fixture 16, r9 fd remap)", () => {
  it("locks survive the supervisor's death once a child holds them across exec; the stand-in re-admits; killing it with no cgroup frees release; a child killed before exec frees it too", () => {
    const standIn = `import importlib.util,json,os,sys,time
spec=importlib.util.spec_from_file_location("l",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cfg=json.loads(sys.argv[2]); m.LIVE_DIR=cfg["live"]; m.TOMBSTONE_DIR=cfg["dead"]
try: m.verify_admission(cfg["admission"], cfg["unit"], cfg["bot"]); os.write(int(cfg["w"]), b"verified")
except Exception as e: os.write(int(cfg["w"]), str(e).encode())
time.sleep(60)`;
    writeFileSync(join(rig.root, "stand-in.py"), standIn);
    expect(result(`
launcher=sys.argv[1]
def supervisor(bot, unit, exec_standin):
    r,w=os.pipe(); pr,pw=os.pipe(); pid=os.fork()
    if pid==0:   # the supervisor: admit, fork the child, report the child's pid, then wait to be killed
        os.close(r); os.close(pr)
        a=admit(bot, unit); os.set_inheritable(pw, True)
        child=os.fork()
        if child==0:
            if exec_standin:
                cfg=json.dumps({"live":m.LIVE_DIR,"dead":m.TOMBSTONE_DIR,"admission":a,"unit":unit,"bot":bot,"w":pw})
                os.execv(sys.executable, [sys.executable, "-I", root+"/stand-in.py", launcher, cfg])
            time.sleep(60); os._exit(0)
        os.write(w, str(child).encode()); time.sleep(60); os._exit(0)
    os.close(w); os.close(pw); child=int(os.read(r,32)); os.close(r)
    os.kill(pid, signal.SIGKILL); os.waitpid(pid,0)       # the supervisor dies before any scope exists
    return child, pr
child, pr = supervisor("alpha", U(15), True)
out.append(os.read(pr, 64).decode())                        # the stand-in verified its inherited descriptors
out.append(release("alpha"))                                # refused: the stand-in holds the locks through its exec
os.kill(child, signal.SIGKILL)
for _ in range(500):
    try: os.kill(child, 0); time.sleep(0.02)
    except OSError: break
out.append(release("alpha"))                                # no lock, no cgroup: dead
child, pr = supervisor("beta", U(16), False)
os.kill(child, signal.SIGKILL)
for _ in range(500):
    try: os.kill(child, 0); time.sleep(0.02)
    except OSError: break
out.append(release("beta"))
`)).toEqual(["verified", "Cloud bot state is in use", "ok", "ok"]);
  });
  it("remaps without collisions: an unrelated descriptor on a target number keeps its identity at a new number, every lock lands on its own number", () => {
    expect(result(`
dfd=m.live_dir_fd()
low=os.open(root+"/unrelated", os.O_RDWR|os.O_CREAT, 0o600)
os.dup2(low, m.ADMISSION_FD+1); os.close(low); unrelated=m.ADMISSION_FD+1
inode=os.fstat(unrelated).st_ino
locks=[m.live_lock(n, dfd) for n in ("bot-alpha","ws-alpha",U(17))]
for fd in locks: fcntl.flock(fd, fcntl.LOCK_SH)
moved=m.remap_admission(locks)
out.append(list(moved.keys())); out.append(os.fstat(moved[m.ADMISSION_FD+1]).st_ino==inode)
for i,n in enumerate(("bot-alpha","ws-alpha",U(17))):
    fd=m.ADMISSION_FD+i
    out.append(os.fstat(fd).st_ino==os.stat(n, dir_fd=dfd).st_ino and not (fcntl.fcntl(fd, fcntl.F_GETFD) & fcntl.FD_CLOEXEC))
`)).toEqual([[9], true, true, true, true]);
  });
});

describe("bot-state-release erases (r5 fixture 9) and bot-state-query reports names only", () => {
  // the engine-store erase clears the immutable flag with FS_IOC_GETFLAGS/SETFLAGS, Linux ioctls (macOS answers ENOTTY)
  it.skipIf(process.platform !== "linux")("clears the flag on every MASK_NAMES directory under the bot's roots and nothing else, erases the trees, removes bots/<bot> under every engine", () => {
    const ws = join(rig.root, "ws");
    for (const d of ["alpha/.claude/x", "alpha/src/.codex", "alpha.task/.grok", "alphabet/.claude", "beta/.fuigo"]) mkdirSync(join(ws, d), { recursive: true });
    writeFileSync(join(ws, "alpha", ".claude", "x", "settings.json"), "{}");
    for (const e of ["codex", "claudeAgent"]) mkdirSync(join(rig.root, "engines", e, "bots", "alpha", ".codex"), { recursive: true });
    mkdirSync(join(rig.root, "engines", "codex", "bots", "beta"), { recursive: true });
    expect(result(`
cleared=[]
def fdpath(fd):
    # /proc/self/fd on Linux; macOS has no procfs and names an open file with fcntl F_GETPATH
    if os.path.isdir("/proc/self/fd"): return os.readlink("/proc/self/fd/%d"%fd)
    import fcntl; return fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\\0", 1)[0].decode()
def clear(fd): cleared.append(fdpath(fd)[len(root):])
out.append(release("alpha", clear=clear))
out.append(sorted(cleared))
out.append(sorted(os.listdir(m.WORKSPACE_ROOT)))
out.append(sorted(os.listdir(m.ENGINE_ROOT+"/codex/bots"))); out.append(os.listdir(m.ENGINE_ROOT+"/claudeAgent/bots"))
`)).toEqual(["ok", ["/ws/alpha.task/.grok", "/ws/alpha/.claude", "/ws/alpha/src/.codex"], ["alphabet", "beta"], ["beta"], []]);
    expect(existsSync(join(ws, "alphabet", ".claude"))).toBe(true);
  });
  it("query: the engine's C store wins over the bot's B store, a current naming a missing generation reads as signed out, timestamps are numbers, never a secret", () => {
    const store = (p: string, record: unknown, current = "3") => {
      mkdirSync(join(rig.root, "engines", p, "signin", "3"), { recursive: true });
      writeFileSync(join(rig.root, "engines", p, "signin", "3", "record.json"), JSON.stringify(record));
      writeFileSync(join(rig.root, "engines", p, "signin", "3", "token"), "sk-ant-oat01-" + "NEVER-REPORTED"); // secret-scan: fixture (a made-up token shape, built in two pieces so no vendor-prefixed literal sits in the file)
      writeFileSync(join(rig.root, "engines", p, "signin", "current"), current);
    };
    store("claudeAgent", { mode: "oauth-token", kind: "signin", expiresAt: 1800000000, files: ["token"] });
    store("codex", { mode: "apikey", kind: "enroll", files: ["key"] });
    store("codex/bots/alpha", { mode: "chatgpt", kind: "signin" });
    store("grokAgent/bots/alpha", { mode: "oauth", kind: "signin" });
    store("kimiAgent/bots/alpha", { mode: "oauth", kind: "signout" });
    store("opencodeGo", { mode: "api", kind: "enroll" }, "9");
    mkdirSync(join(rig.root, "engines", "fuigoAgent", "bots", "alpha", "signin", "current"), { recursive: true });
    writeFileSync(join(rig.root, "engines", "fuigoAgent", "bots", "alpha", "signin", "current", "record.json"), JSON.stringify({ mode: "oauth", kind: "refresh", expiresAt: "soon" }));
    const text = run(`out.append(m.bot_state_query({"mode":"bot-state-query","bot":"alpha"})); out.append(m.bot_state_query({"mode":"bot-state-query"}))`);
    expect(text).not.toContain("NEVER-REPORTED");
    expect(JSON.parse(text)).toEqual([
      { tombstoned: false, engines: {
        claudeAgent: { mode: "oauth-token", signedIn: true, expiresAt: 1800000000000 },
        codex: { mode: "apikey", signedIn: true, expiresAt: null },
        grokAgent: { mode: "oauth", signedIn: true, expiresAt: null },
        kimiAgent: { mode: "oauth", signedIn: false, expiresAt: null },
        opencodeGo: { mode: null, signedIn: false, expiresAt: null },
        fuigoAgent: { mode: "oauth", signedIn: true, expiresAt: null },
      } },
      { tombstoned: false, engines: {
        claudeAgent: { mode: "oauth-token", signedIn: true, expiresAt: 1800000000000 },
        codex: { mode: "apikey", signedIn: true, expiresAt: null },
        opencodeGo: { mode: null, signedIn: false, expiresAt: null },
      } },
    ]);
    expect(() => run(`m.bot_state_query({"mode":"bot-state-query","bot":"../x"})`)).toThrow(/Invalid cloud bot state request/u);
  });
  it("both modes are unscoped root modes, like engine-signin-cleanup, and a turn request's scope plan is unchanged", () => {
    expect(run(`out.append([m.scope_plan({"mode":"bot-state-release","bot":"a"}), m.scope_plan({"mode":"bot-state-query"}), m.scope_plan({"mode":"engine-signin-cleanup"})])`)).toContain("[null, null, null]");
    expect(readFileSync(launcher, "utf8")).toContain('elif request.get("mode") == "bot-state-release":');
  });
});
