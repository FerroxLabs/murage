// SPDX-License-Identifier: AGPL-3.0-or-later
// r5 R5.1 (CLOUD-ENGINES-DESIGN.md; placeholders are permanent, r9): a tmpfs mask is a mount on a dentry of the
// shared workspace, and Linux lets a writer in another namespace rmdir or rename that dentry (taking the mask
// with it). So before the privilege drop root places an immutable placeholder at every MASK_NAMES name in every
// workspace directory the plan binds, and bwrap mounts the r4 tmpfs over it. The immutable ioctl needs
// CAP_LINUX_IMMUTABLE in the initial user namespace, which this container user lacks, so the rig swaps the
// `set_immutable` seam for a recorder; the kernel behaviour itself is the real-home gate in negative-tests.sh.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_TURN_ENGINES, MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-placeholder-"); });
afterEach(() => rig.dispose());

const MASK_NAMES = [".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode"];
const argsFor = (engine: string, extra?: string) => (engine === "claudeAgent" || engine === "antigravity") && extra ? [...MINIMAL_ARGV[engine], "--add-dir", extra] : MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV];

// ensure_placeholder on <dir>/<name> with a recording seam; `race` is Python run as the after-mkdirat hook
// (r: the race counter, d: the directory fd, n: the name).
const ensure = (dir: string, name: string, race = "") => JSON.parse(rig.py(`
import stat
dfd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY)
recorded=[]; r={"calls":0}
race=sys.argv[4]
if race:
    def hook(d,n):
        r["calls"]+=1
        exec(race,{"os":os,"r":r,"d":d,"n":n})
    m.PLACEHOLDER_RACE=hook
try:
    created=m.ensure_placeholder(dfd,sys.argv[3],immutable=lambda fd: recorded.append(os.fstat(fd).st_ino))
    st=os.lstat(sys.argv[2]+"/"+sys.argv[3])
    out={"created":created,"mode":stat.S_IMODE(st.st_mode),"dir":stat.S_ISDIR(st.st_mode),"uid":st.st_uid,"ino":st.st_ino}
except ValueError as error:
    out={"error":str(error)}
out.update(recorded=recorded,races=r["calls"],me=os.getuid())
print(json.dumps(out))`, dir, name, race));

describe("fixture 1: MASK_NAMES is the union and every engine masks it", () => {
  it("is exactly the union of every engine's chain names", () => {
    expect(JSON.parse(rig.py(`print(json.dumps(list(m.MASK_NAMES)))`))).toEqual(MASK_NAMES);
  });

  it.each(CLOUD_TURN_ENGINES)("%s masks every name under cwd (and each add-dir), and its chain names are all in the union", engine => {
    const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`, extra = `${rig.workspaces}/other`;
    mkdirSync(extra);
    const plan = rig.plan(rig.request(engine, { cwd, args: argsFor(engine, extra) })).ok!;
    for (const name of MASK_NAMES) expect(plan.tmpfs).toContain(`${cwd}/${name}`);
    if (engine === "claudeAgent" || engine === "antigravity") for (const name of MASK_NAMES) expect(plan.tmpfs).toContain(`${extra}/${name}`);
    // antigravity alone also masks the two directories agy reads hooks from in each of its four customization roots (never a root itself)
    const agyDirs = engine === "antigravity" ? [".agents", ".agent", "_agents", "_agent"].flatMap(root => [`${root}/plugins`, `${root}/agents`]) : [];
    for (const path of plan.tmpfs.filter(path => path.startsWith(`${rig.workspaces}/`))) expect([...MASK_NAMES, ...agyDirs].some(name => path.endsWith(`/${name}`))).toBe(true);
    expect(plan.tmpfs).not.toContain(`${cwd}/.agents`);
  });

  it("gives Grok the chain shadows Fuigo has: .grok and .claude from cwd to the grant root, never the state home", () => {
    const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`;
    const plan = rig.plan(rig.request("grokAgent", { cwd })).ok!;
    for (const dir of [cwd, `${ws}/proj`, ws]) for (const name of [".grok", ".claude"]) expect(plan.tmpfs).toContain(`${dir}/${name}`);
    expect(plan.tmpfs).not.toContain(`${rig.home("grokAgent")}/.grok`);
    expect(Object.keys(plan.files)).toContain(`${rig.home("grokAgent")}/.grok/config.toml`);
  });
});

// ensure_placeholder sets the immutable flag with the Linux FS_IOC_SETFLAGS ioctl (ENOTTY elsewhere)
describe.skipIf(process.platform !== "linux")("fixture 2: ensure_placeholder", () => {
  it("makes an absent name a 0555 directory of the launcher's uid with the flag requested once", () => {
    const out = ensure(`${rig.workspaces}/ws`, ".claude");
    expect(out.error).toBeUndefined();
    expect([out.created, out.dir, out.mode, out.uid]).toEqual([true, true, 0o555, out.me]);
    expect(out.recorded).toEqual([out.ino]);
  });

  it("keeps an existing populated directory's owner, mode and content and freezes it", () => {
    const dir = `${rig.workspaces}/ws/.codex`;
    mkdirSync(dir, { mode: 0o750 }); writeFileSync(`${dir}/config.toml`, "model = \"owner\"\n");
    const out = ensure(`${rig.workspaces}/ws`, ".codex");
    expect([out.created, out.mode, out.uid]).toEqual([false, 0o750, out.me]);
    expect(existsSync(`${dir}/config.toml`)).toBe(true);
    expect(out.recorded).toEqual([out.ino]);
  });

  it.each([
    ["symlink", (path: string) => rig.py(`os.symlink("elsewhere",sys.argv[2])`, path)],
    ["file", (path: string) => writeFileSync(path, "x")],
    ["FIFO", (path: string) => rig.py(`os.mkfifo(sys.argv[2])`, path)],
  ])("refuses an existing %s with the r4 text and leaves it in place", (_kind, make) => {
    const path = `${rig.workspaces}/ws/.claude`;
    make(path);
    const before = lstatSync(path);
    const out = ensure(`${rig.workspaces}/ws`, ".claude");
    expect(out.error).toBe("Cloud turn mask path is not a plain directory: .claude");
    expect(out.recorded).toEqual([]);
    expect(lstatSync(path).ino).toBe(before.ino);
  });

  it("retries when the new directory is removed between mkdirat and verify, then succeeds", () => {
    const out = ensure(`${rig.workspaces}/ws`, ".grok", `if r["calls"]==1: os.rmdir(n,dir_fd=d)`);
    expect(out.error).toBeUndefined();
    expect(out.races).toBe(2);
    expect([out.dir, out.mode]).toEqual([true, 0o555]);
    expect(out.recorded.at(-1)).toBe(out.ino);
  });

  it("refuses as contested after 8 attempts that each lose the race", () => {
    const out = ensure(`${rig.workspaces}/ws`, ".grok", `os.rmdir(n,dir_fd=d)`);
    expect(out.error).toBe("Cloud turn mask path is contested: .grok");
    expect(out.races).toBe(8);
    expect(existsSync(`${rig.workspaces}/ws/.grok`)).toBe(false);
  });
});

// ensure_placeholder reads the inode flags with FS_IOC_GETFLAGS, a Linux ioctl (macOS answers ENOTTY): these three run on Linux only, like fixture 2.
it.skipIf(process.platform !== "linux")("fixture 3: a settings.json planted after the plan, then a rename of the placeholder, leaves the view on the tmpfs and the flag on the original inode", () => {
  const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`;
  const out = JSON.parse(rig.py(`
import errno,tempfile
cfg=json.loads(sys.argv[2])
m.MCP_PROXY_ROOT=cfg["proxyRoot"]; m.WORKSPACE_ROOT=cfg["workspaces"]
request=cfg["request"]
engine,home,cwd,command,args,env,render,_bot=m.validate_request(request,manifest_path=cfg["manifest"],manifest_uid=os.getuid(),engine_root=cfg["engineRoot"],cache_root=cfg["cache"])
frozen=set()
m.set_immutable=lambda fd: frozen.add(os.fstat(fd).st_ino)
m.ensure_placeholders(m.placeholder_dirs(engine,home,cwd,args))
turn_home=tempfile.mkdtemp(prefix="turn-home-",dir=cfg["root"])
argv,blobs=m.turn_mount_args(engine,[(cwd,cwd)],home,cwd,command,args,render,[],turn_home=turn_home)
mask=cwd+"/.claude"; original=os.lstat(mask).st_ino
def attempt(f):
    try: f(); return "OK"
    except OSError as e: return errno.errorcode[e.errno]
# The kernel refuses a rename of an immutable source with EPERM for every caller; the seam stands in for it here.
def rename(src,dst):
    if os.lstat(src).st_ino in frozen: raise PermissionError(errno.EPERM,"immutable")
    os.rename(src,dst)
def plant():
    # On the home the immutable flag refuses a write into the placeholder for every caller, root included; root passes the 0555 mode, so the seam stands in for the flag here as it does for the rename.
    if os.getuid()==0 and os.lstat(mask).st_ino in frozen: raise PermissionError(errno.EPERM,"immutable")
    with open(mask+"/settings.json","w") as f: f.write('{"apiKeyHelper":"/bin/true","hooks":{"Stop":[{"command":"/bin/true"}]}}')
results={"plant":attempt(plant),"rename":attempt(lambda: rename(mask,cwd+"/moved")),"recreate":attempt(lambda: os.mkdir(mask))}
options=argv[:argv.index("--")]
ops=[]
for i,a in enumerate(options):
    if a in ("--bind","--ro-bind"): ops.append(("host",options[i+2]))
    elif a=="--tmpfs": ops.append(("fresh",options[i+1]))
    elif a=="--ro-bind-data": ops.append(("rendered",options[i+2]))
view="none"
for kind,dest in ops:
    if mask+"/settings.json"==dest or (mask+"/settings.json").startswith(dest+"/"): view=kind
print(json.dumps({"results":results,"view":view,"original":original,"now":os.lstat(mask).st_ino,"frozen":sorted(frozen),"moved":os.path.lexists(cwd+"/moved")}))`,
  JSON.stringify({ request: rig.request("claudeAgent", { cwd }), proxyRoot: rig.proxyRoot, workspaces: rig.workspaces, manifest: rig.manifest, engineRoot: rig.engineRoot, root: rig.root, cache: `${rig.root}/digest-cache` })));
  // The container user cannot write a 0555 directory (EACCES); on the home the immutable flag makes it EPERM for root too.
  expect(["EACCES", "EPERM"]).toContain(out.results.plant);
  expect(out.results.rename).toBe("EPERM");
  expect(out.results.recreate).toBe("EEXIST");
  expect(out.moved).toBe(false);
  expect(out.view).toBe("fresh");
  expect(out.now).toBe(out.original);
  expect(out.frozen).toContain(out.original);
});

it.skipIf(process.platform !== "linux")("places a placeholder at every MASK_NAMES name under the cwd and under each --add-dir of a Claude turn", () => {
  const ws = `${rig.workspaces}/ws`, cwd = `${ws}/proj/sub`, extra = `${rig.workspaces}/other`, extra2 = `${ws}/proj`;
  mkdirSync(extra);
  const plan = rig.plan(rig.request("claudeAgent", { cwd, args: [...MINIMAL_ARGV.claudeAgent, "--add-dir", extra, `--add-dir=${extra2}`] }), { place: true }).ok!;
  const expected = [cwd, extra, extra2].flatMap(dir => MASK_NAMES.map(name => realpathSync(`${dir}`) + `/${name}`));
  expect(plan.placed.slice().sort()).toEqual(expected.slice().sort());
  for (const dir of [cwd, extra, extra2]) for (const name of MASK_NAMES) {
    const st = lstatSync(`${dir}/${name}`);
    expect([st.isDirectory(), st.mode & 0o7777]).toEqual([true, 0o555]);
    expect(plan.tmpfs).toContain(`${dir}/${name}`);
  }
});

it.skipIf(process.platform !== "linux")("places no placeholder in the engine home (cwd == home) and only the cwd's for an engine without --add-dir", () => {
  expect(rig.plan(rig.request("codex"), { place: true }).ok!.placed).toEqual([]);
  const cwd = `${rig.workspaces}/ws/proj`;
  const plan = rig.plan(rig.request("grokAgent", { cwd }), { place: true }).ok!;
  expect(plan.placed.slice().sort()).toEqual(MASK_NAMES.map(name => `${realpathSync(cwd)}/${name}`).sort());
});

it("the ownership walk never regroups or enters a MASK_NAMES entry", () => {
  const ws = `${rig.workspaces}/ws`;
  mkdirSync(`${ws}/proj/.claude`, { mode: 0o700 });
  writeFileSync(`${ws}/proj/.claude/settings.json`, "{}", { mode: 0o600 });
  mkdirSync(`${ws}/proj/sub/.codex`, { mode: 0o700 });
  writeFileSync(`${ws}/proj/sub/.codex/config.toml`, "", { mode: 0o600 });
  writeFileSync(`${ws}/proj/notes.md`, "owner", { mode: 0o600 });
  const modes = JSON.parse(rig.py(`
import stat
fd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY)
m.regroup_workspace(fd,os.getuid(),os.getgid()); os.close(fd)
print(json.dumps({p:stat.S_IMODE(os.lstat(sys.argv[2]+"/"+p).st_mode) for p in ["proj/notes.md","proj/.claude","proj/.claude/settings.json","proj/sub/.codex","proj/sub/.codex/config.toml"]}))`, ws));
  // The server-owned file outside a mask gains the group bits; nothing named in MASK_NAMES or inside one is touched.
  expect(modes).toEqual({ "proj/notes.md": 0o660, "proj/.claude": 0o700, "proj/.claude/settings.json": 0o600, "proj/sub/.codex": 0o700, "proj/sub/.codex/config.toml": 0o600 });
});

// MurageMain ruling 2026-10-22: .agents is not in MASK_NAMES (a customer repo keeps other tools' files there), but an antigravity turn
// still gets the immutable placeholder on it, so another namespace cannot rename it or unlink a mask target mid-turn.
describe.skipIf(process.platform !== "linux")("fixture 4: the antigravity .agents placeholder", () => {
  const place = (dir: string, engine: string, failFlag = false) => JSON.parse(rig.py(`
import stat
frozen=[]
def seam(fd):
    if sys.argv[4]=="1" and os.readlink("/proc/self/fd/%d"%fd).endswith("/.agents"): raise PermissionError(errno.EPERM,"no CAP_LINUX_IMMUTABLE")
    frozen.append(os.readlink("/proc/self/fd/%d"%fd))
import errno
m.set_immutable=seam
try:
    m.ensure_placeholders([sys.argv[2]],(),sys.argv[3]); error=None
except ValueError as e:
    error=str(e)
agents=sys.argv[2]+"/.agents"
print(json.dumps({"error":error,"frozen":frozen,"exists":os.path.lexists(agents)}))`, dir, engine, failFlag ? "1" : "0"));

  it("freezes .agents on an antigravity turn, keeps the owner's other files, and pre-creates the four mask targets", () => {
    const cwd = realpathSync(`${rig.workspaces}/ws/proj`);
    mkdirSync(`${cwd}/.agents/skills/x`, { recursive: true });
    writeFileSync(`${cwd}/.agents/other.md`, "keep");
    const out = place(cwd, "antigravity");
    expect(out.error).toBeNull();
    expect(out.frozen).toContain(`${cwd}/.agents`);
    for (const name of MASK_NAMES) expect(out.frozen).toContain(`${cwd}/${name}`);
    for (const leaf of ["hooks.json", "plugins.json"]) expect(lstatSync(`${cwd}/.agents/${leaf}`).isFile()).toBe(true);
    for (const leaf of ["plugins", "agents"]) expect(lstatSync(`${cwd}/.agents/${leaf}`).isDirectory()).toBe(true);
    expect(readFileSync(`${cwd}/.agents/other.md`, "utf8")).toBe("keep");
    expect(lstatSync(`${cwd}/.agents/skills/x`).isDirectory()).toBe(true);
  });

  it("refuses the turn when .agents cannot be made immutable", () => {
    const cwd = realpathSync(`${rig.workspaces}/ws/proj`);
    const out = place(cwd, "antigravity", true);
    expect(out.error).toMatch(/\.agents placeholder could not be made immutable|could not|Operation not permitted|no CAP/);
    expect(out.error).toContain(".agents");
  });

  it.each(["claudeAgent", "codex", "grokAgent"])("places no .agents placeholder for %s", engine => {
    const cwd = realpathSync(`${rig.workspaces}/ws/proj`);
    const out = place(cwd, engine);
    expect(out.error).toBeNull();
    expect(out.exists).toBe(false);
    expect(out.frozen.some((p: string) => p.endsWith("/.agents"))).toBe(false);
  });

  it("places .agents under the cwd and each --add-dir of an antigravity plan and leaves the rest of .agents visible", () => {
    const cwd = `${rig.workspaces}/ws/proj/sub`, extra = `${rig.workspaces}/other`;
    mkdirSync(extra); mkdirSync(`${cwd}/.agents/skills/x`, { recursive: true });
    writeFileSync(`${cwd}/.agents/other.md`, "keep");
    const plan = rig.plan(rig.request("antigravity", { cwd, args: argsFor("antigravity", extra) }), { place: true }).ok!;
    for (const dir of [cwd, extra]) expect(plan.placed).toContain(`${realpathSync(dir)}/.agents`);
    expect(plan.tmpfs).not.toContain(`${cwd}/.agents`);
    expect(readFileSync(`${cwd}/.agents/other.md`, "utf8")).toBe("keep");
    const other = rig.plan(rig.request("claudeAgent", { cwd, args: argsFor("claudeAgent", extra) }), { place: true }).ok!;
    expect(other.placed.some(p => p.endsWith("/.agents"))).toBe(false);
  });
});

// MurageMain ruling 2026-10-22 (the freeze lasts for the turn only): the .agents freeze is recorded in a root-owned ledger outside the
// workspace, released at turn end (success, error or Stop) together with whatever this launcher created, ref-counted between turns that
// share a directory, and swept after a crash. The immutable ioctls are recorders here (no CAP_LINUX_IMMUTABLE); the real flag is the home gate.
describe.skipIf(process.platform !== "linux")("fixture 5: the .agents freeze lasts for the turn only", () => {
  const PRE = `
import errno,signal,threading,time
res=sys.argv[2]
frozen=[];thawed=[];FAIL=[False]
m.set_immutable=lambda fd: frozen.append(os.readlink("/proc/self/fd/%d"%fd))
def thaw(fd):
    if FAIL[0]: raise PermissionError(errno.EPERM,"no CAP")
    thawed.append(os.readlink("/proc/self/fd/%d"%fd))
m.clear_immutable=thaw
def ledger():
    try: return json.load(open(m.AGY_LEDGER_DIR+"/ledger.json"))["freezes"]
    except FileNotFoundError: return {}
def ls(path):
    return sorted(os.listdir(path)) if os.path.isdir(path) else None
def done(**kw):
    kw.update(thawed=thawed,frozen=frozen,ledger=ledger())
    open(res,"w").write(json.dumps(kw))
def holder(name):
    return {"pid":os.getpid(),"start":m.proc_start(os.getpid()),"id":name}
`;
  let n = 0;
  const run = (source: string, ...args: string[]) => {
    const file = `${rig.root}/res-${n++}.json`;
    rig.py(PRE + source, file, ...args);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const mkcwd = (name: string) => { const cwd = `${realpathSync(`${rig.workspaces}/ws/proj`)}/${name}`; mkdirSync(cwd, { recursive: true }); return cwd; };
  const ALL = ["agents", "hooks.json", "plugins", "plugins.json"];

  it.each(["success", "error", "stop"])("ends the turn on %s: thaws .agents and deletes what the turn created, then the owner can add files", how => {
    const cwd = mkcwd(`turn-${how}`);
    const out = run(`
cwd,how=sys.argv[3:5]
seen={}
def body():
    seen["during"]=ls(cwd+"/.agents"); seen["held"]=len(ledger())
    if how=="error": raise RuntimeError("boom")
    if how=="stop":
        threading.Timer(0.3,lambda: os.kill(os.getpid(),signal.SIGTERM)).start()
        def child(): time.sleep(30); os._exit(0)
        return m.run_turn(child,lambda: None)
    return 0
try: status=m.run_frozen([cwd],(),"antigravity",body)
except RuntimeError: status="raised"
done(status=status,seen=seen,after=ls(cwd+"/.agents"))`, cwd, how);
    expect(out.seen.during).toEqual(ALL);
    expect(out.seen.held).toBe(4);               // one freeze per customization root
    expect(out.status).toBe({ success: 0, error: "raised", stop: 137 }[how]);
    expect(out.after).toBeNull();                       // the turn created .agents and it is empty again: removed
    expect(out.thawed).toContain(`${cwd}/.agents`);     // the flag was cleared
    expect(out.ledger).toEqual({});
    mkdirSync(`${cwd}/.agents`); writeFileSync(`${cwd}/.agents/mine.md`, "owner"); // the owner can add a file afterwards
    expect(readFileSync(`${cwd}/.agents/mine.md`, "utf8")).toBe("owner");
  });

  it("freezes all four customization roots for the turn, creates the missing ones, and removes what it created at the end", () => {
    const cwd = mkcwd("four-roots");
    mkdirSync(`${cwd}/.agent/skills`, { recursive: true }); writeFileSync(`${cwd}/.agent/note.md`, "keep");
    const out = run(`
cwd=sys.argv[3]
seen={}
def body():
    for root in m.AGY_ROOTS: seen[root]=ls(cwd+"/"+root)
m.run_frozen([cwd],(),"antigravity",body)
done(seen=seen,after={root: ls(cwd+"/"+root) for root in m.AGY_ROOTS})`, cwd);
    for (const root of [".agents", ".agent", "_agents", "_agent"]) {
      expect(out.thawed).toContain(`${cwd}/${root}`);
      expect(out.frozen).toContain(`${cwd}/${root}`);
    }
    expect(out.seen[".agents"]).toEqual(ALL);
    expect(out.seen["_agents"]).toEqual(ALL);
    expect(out.seen["_agent"]).toEqual(ALL);
    expect(out.seen[".agent"]).toEqual(["agents", "hooks.json", "note.md", "plugins", "plugins.json", "skills"]);
    expect(out.after).toEqual({ ".agents": null, "_agents": null, "_agent": null, ".agent": ["note.md", "skills"] });
    expect(out.ledger).toEqual({});
  });

  it("refuses the turn when a customization root is a link, and leaves nothing behind", () => {
    const cwd = mkcwd("root-link");
    mkdirSync(`${cwd}/elsewhere`); symlinkSync(`${cwd}/elsewhere`, `${cwd}/_agents`);
    const out = run(`
cwd=sys.argv[3]
try: m.ensure_placeholders([cwd],(),"antigravity"); error=None
except ValueError as e: error=str(e)
done(error=error,agents=ls(cwd+"/.agents"))`, cwd);
    expect(out.error).toContain("is not a plain directory");
    expect(out.agents).toBeNull();
    expect(out.ledger).toEqual({});
  });

  it("leaves an existing .agents in place, deletes only the targets it created, and lets the owner add a file", () => {
    const cwd = mkcwd("existing");
    mkdirSync(`${cwd}/.agents/skills/x`, { recursive: true }); writeFileSync(`${cwd}/.agents/other.md`, "keep");
    const out = run(`
cwd=sys.argv[3]
m.run_frozen([cwd],(),"antigravity",lambda: None)
done(after=ls(cwd+"/.agents"))`, cwd);
    expect(out.after).toEqual(["other.md", "skills"]);
    expect(out.thawed).toContain(`${cwd}/.agents`);
    writeFileSync(`${cwd}/.agents/new.md`, "owner");
    expect(readFileSync(`${cwd}/.agents/new.md`, "utf8")).toBe("owner");
    expect(readFileSync(`${cwd}/.agents/other.md`, "utf8")).toBe("keep");
  });

  it("never touches a pre-existing hooks.json, which the plan still masks with the empty hook table", () => {
    const cwd = mkcwd("hooks");
    mkdirSync(`${cwd}/.agents`); writeFileSync(`${cwd}/.agents/hooks.json`, '{"hooks":{"x":1}}');
    const plan = rig.plan(rig.request("antigravity", { cwd, args: MINIMAL_ARGV.antigravity }), { place: true }).ok!;
    expect(plan.files[`${cwd}/.agents/hooks.json`]).toBe("{}\n");
    const out = run(`
cwd=sys.argv[3]
m.run_frozen([cwd],(),"antigravity",lambda: None)
done(after=ls(cwd+"/.agents"))`, cwd);
    expect(readFileSync(`${cwd}/.agents/hooks.json`, "utf8")).toBe('{"hooks":{"x":1}}');
    expect(out.after).toEqual(["hooks.json"]);          // plugins.json, plugins/ and agents/ were ours and are gone
    // a directory in the place of the file is still refused, as before
    rmSync(`${cwd}/.agents/hooks.json`); mkdirSync(`${cwd}/.agents/hooks.json`);
    expect(rig.plan(rig.request("antigravity", { cwd, args: MINIMAL_ARGV.antigravity })).error).toBe("Cloud turn mask path is a directory: hooks.json");
  });

  it("keeps a created target the owner changed during the turn", () => {
    const cwd = mkcwd("changed");
    const out = run(`
cwd=sys.argv[3]
def body():
    open(cwd+"/.agents/hooks.json","w").write("{}")
    open(cwd+"/.agents/plugins/p.txt","w").write("x")
m.run_frozen([cwd],(),"antigravity",body)
done(after=ls(cwd+"/.agents"))`, cwd);
    expect(out.after).toEqual(["hooks.json", "plugins"]);
    expect(readFileSync(`${cwd}/.agents/plugins/p.txt`, "utf8")).toBe("x");
  });

  it("a crash then a restart leaves the folder clean (the ledger sweep)", () => {
    const cwd = mkcwd("crash");
    const crashed = run(`
cwd=sys.argv[3]
held=m.ensure_placeholders([cwd],(),"antigravity")   # the launcher dies here: no release
done(during=ls(cwd+"/.agents"))`, cwd);
    expect(crashed.during).toEqual(ALL);
    expect(Object.keys(crashed.ledger)).toHaveLength(4);
    expect(existsSync(`${cwd}/.agents`)).toBe(true);
    const swept = run(`
cwd=sys.argv[3]
n=m.agy_sweep()
done(cleaned=n,after=ls(cwd+"/.agents"))`, cwd);
    expect(swept.cleaned).toBe(4);
    expect(swept.after).toBeNull();
    expect(swept.thawed).toContain(`${cwd}/.agents`);
    expect(swept.ledger).toEqual({});
  });

  it("a cleanup failure is logged, kept in the ledger and retried by the next sweep", () => {
    const cwd = mkcwd("retry");
    run(`
cwd=sys.argv[3]
m.ensure_placeholders([cwd],(),"antigravity")
done()`, cwd);
    const failing = run(`
cwd=sys.argv[3]
FAIL[0]=True
try: m.agy_sweep(); error=None
except ValueError as e: error=str(e)
done(error=error,after=ls(cwd+"/.agents"))`, cwd);
    expect(failing.error).toContain("freezes remain");
    expect(failing.after).toEqual(ALL);
    expect(Object.keys(failing.ledger)).toHaveLength(4);
    const retried = run(`
cwd=sys.argv[3]
done(cleaned=m.agy_sweep(),after=ls(cwd+"/.agents"))`, cwd);
    expect(retried.cleaned).toBe(4);
    expect(retried.after).toBeNull();
    expect(retried.ledger).toEqual({});
  });

  it("a failed turn-end release does not raise: it is logged and left for the sweep", () => {
    const cwd = mkcwd("release-fails");
    const out = run(`
cwd=sys.argv[3]
def body(): FAIL[0]=True
m.run_frozen([cwd],(),"antigravity",body)
done(after=ls(cwd+"/.agents"))`, cwd);
    expect(out.after).toEqual(ALL);
    expect(Object.keys(out.ledger)).toHaveLength(4);
  });

  it("ref-counts two turns sharing a workspace: the first out leaves the freeze, the last out thaws and cleans", () => {
    const cwd = mkcwd("shared");
    const out = run(`
cwd=sys.argv[3]
dfd=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY)
a=m.agy_placeholder(dfd,cwd,holder=holder("a")); b=m.agy_placeholder(dfd,cwd,holder=holder("b"))
assert a[0]==b[0]
both=json.loads(json.dumps(ledger()))
m.agy_release([a])
first={"after":ls(cwd+"/.agents"),"thawed":list(thawed),"holders":[h["id"] for h in ledger()[a[0]]["holders"]]}
m.agy_release([b])
done(both=[h["id"] for h in both[a[0]]["holders"]],first=first,after=ls(cwd+"/.agents"))`, cwd);
    expect(out.both).toEqual(["a", "b"]);
    expect(out.first).toEqual({ after: ALL, thawed: [], holders: ["b"] });
    expect(out.after).toBeNull();
    expect(out.thawed).toEqual([`${cwd}/.agents`]);
    expect(out.ledger).toEqual({});
  });

  it("a dead holder does not keep a freeze alive: the live turn's release still cleans", () => {
    const cwd = mkcwd("dead-holder");
    const out = run(`
cwd=sys.argv[3]
dfd=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY)
dead=m.agy_placeholder(dfd,cwd,holder={"pid":4194000,"start":1,"id":"dead"})
live=m.agy_placeholder(dfd,cwd,holder=holder("live"))
m.agy_release([live])
done(after=ls(cwd+"/.agents"))`, cwd);
    expect(out.after).toBeNull();
    expect(out.ledger).toEqual({});
  });

  it("refuses the turn and leaves nothing behind when the flag cannot be set", () => {
    const cwd = mkcwd("refused");
    const out = run(`
cwd=sys.argv[3]
def deny(fd):
    if os.readlink("/proc/self/fd/%d"%fd).endswith("/.agents"): raise PermissionError(errno.EPERM,"no CAP")
m.set_immutable=deny
try: m.ensure_placeholders([cwd],(),"antigravity"); error=None
except ValueError as e: error=str(e)
done(error=error,after=ls(cwd+"/.agents"))`, cwd);
    expect(out.error).toContain("could not be made immutable");
    expect(out.after).toBeNull();
    expect(out.ledger).toEqual({});
  });
});
