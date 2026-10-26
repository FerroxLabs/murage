// SPDX-License-Identifier: AGPL-3.0-or-later
// The root half of placeholder-launcher.test.ts (r5 R5.1; MurageMain ruling 2026-10-22): the antigravity .agents placeholder and
// the freeze that lasts for the turn only. The launcher makes .agents a 0555 directory and then creates the mask targets inside
// it, which only root (the Cloud home launcher's user) can do, so every test here runs as root: the CI step "Run the root-only
// placeholder-launcher test as root" runs this file alone under sudo, and placeholder-launcher.test.ts runs as the normal user in
// the gate shards. Nothing is skipped: each test runs under the user it is valid for.
//
// As root the launcher admits an executable only when every ancestor is owned by root (or the manifest owner, here root) and not
// group/other writable. A hosted CI checkout belongs to the runner user, so the rig cannot live under the working directory the
// way it does for the non-root file; it lives under /run (root-owned, 0755) instead. The ownership check itself is untouched.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

const RIG_BASE = process.getuid?.() === 0 && existsSync("/run") ? "/run" : process.cwd();
let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-placeholder-root-", RIG_BASE); });
afterEach(() => rig.dispose());

const MASK_NAMES = [".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode"];
const argsFor = (engine: string, extra?: string) => (engine === "claudeAgent" || engine === "antigravity") && extra ? [...MINIMAL_ARGV[engine], "--add-dir", extra] : MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV];

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
