// SPDX-License-Identifier: AGPL-3.0-or-later
// r5 R5.1 (CLOUD-ENGINES-DESIGN.md; placeholders are permanent, r9): a tmpfs mask is a mount on a dentry of the
// shared workspace, and Linux lets a writer in another namespace rmdir or rename that dentry (taking the mask
// with it). So before the privilege drop root places an immutable placeholder at every MASK_NAMES name in every
// workspace directory the plan binds, and bwrap mounts the r4 tmpfs over it. The immutable ioctl needs
// CAP_LINUX_IMMUTABLE in the initial user namespace, which this container user lacks, so the rig swaps the
// `set_immutable` seam for a recorder; the kernel behaviour itself is the real-home gate in negative-tests.sh.
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_TURN_ENGINES, MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-placeholder-"); });
afterEach(() => rig.dispose());

const MASK_NAMES = [".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode"];
const argsFor = (engine: string, extra?: string) => engine === "claudeAgent" && extra ? [...MINIMAL_ARGV.claudeAgent, "--add-dir", extra] : MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV];

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
    if (engine === "claudeAgent") for (const name of MASK_NAMES) expect(plan.tmpfs).toContain(`${extra}/${name}`);
    for (const path of plan.tmpfs.filter(path => path.startsWith(`${rig.workspaces}/`))) expect(MASK_NAMES).toContain(path.slice(path.lastIndexOf("/") + 1));
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
