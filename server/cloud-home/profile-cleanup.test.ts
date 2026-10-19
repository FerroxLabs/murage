// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserCleanupCoordinator, type BrowserCleanupIncomingMessage, type BrowserCleanupWireRequest } from "../browser-lifecycle-cleanup.ts";
import { CloudBrowserProfileUsage } from "./browser-profile-usage.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
vi.mock("./server-instance.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./server-instance.ts")>()), ensureServerInstancePublished: vi.fn() }));
import { CLOUD_BROWSER_BOT, setCloudBrowserAdmission, spawnCloudBrowser } from "./browser-process.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cloud-profile-cleanup-")); });
afterEach(() => { vi.unstubAllEnvs(); setCloudBrowserAdmission(() => true); removeTempDirSync(root); });
it("retains historical usage, journals exact bots across restart, and fences prepared and committed browser reuse", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const browserRoot = join(root, "browser"), historyFile = join(root, "history.json"), journal = join(root, "cleanup.json");
  mkdirSync(browserRoot);
  const history = new CloudBrowserProfileUsage(historyFile, browserRoot);
  history.record("b1", "Work"); history.record("b1", "other"); history.record("b2", "Work"); history.record("b3", "other");
  for (const bot of ["b1", "b2", "b3"]) { mkdirSync(join(browserRoot, bot), { mode: 0o700 }); writeFileSync(join(browserRoot, bot, "state"), "fixture browser state"); }
  const recoveredHistory = new CloudBrowserProfileUsage(historyFile, browserRoot);
  expect(recoveredHistory.botsFor("work", ["b1", "b2", "b3"])).toEqual(["b1", "b2"]);
  expect(statSync(historyFile).mode & 0o777).toBe(0o600);
  const before = new BrowserCleanupCoordinator({ file: journal, send: vi.fn(() => true), cloudErased: bots => recoveredHistory.erased(bots) });
  const prepared = before.prepare("profile", "work", "Work", ["b2", "b1", "b1"]);
  expect(await before.ensure(prepared)).toBe(false);
  expect(before.hasPendingBrowserBot("b1")).toBe(true); expect(before.hasPendingBrowserBot("b3")).toBe(false);
  setCloudBrowserAdmission(bot => !before.hasPendingBrowserBot(bot));
  expect(() => spawnCloudBrowser(["--version"], { [CLOUD_BROWSER_BOT]: "b1" })).toThrow("still clearing");
  before.commit(prepared);
  const cleanup = vi.fn(async (bot: string) => { removeTempDirSync(join(browserRoot, bot)); });
  let recovered: BrowserCleanupCoordinator;
  const peer = createSupervisorPort({ store: { getAll: () => ({}), patch: value => value }, send: message => recovered.receive(message as BrowserCleanupIncomingMessage), cleanupBrowser: cleanup });
  const sent = vi.fn((message: BrowserCleanupWireRequest) => { void peer.handle(message); return true; });
  recovered = new BrowserCleanupCoordinator({ file: journal, send: sent, cloudErased: bots => recoveredHistory.erased(bots) });
  {
    expect(recovered.pending()[0]).toMatchObject({ cloudBotIds: ["b1", "b2"], phase: "committed" });
    expect(recovered.hasPendingBrowserBot("b1")).toBe(true);
    expect(await recovered.ensure(recovered.pending()[0])).toBe(true);
    expect(cleanup.mock.calls.map(call => call[0])).toEqual(["b1", "b2"]);
    expect(readFileSync(join(browserRoot, "b3", "state"), "utf8")).toBe("fixture browser state");
    expect(recovered.hasPendingBrowserBot("b1")).toBe(false);
    expect(recoveredHistory.botsFor("Work", ["b1", "b2", "b3"])).toEqual([]);
    expect(sent.mock.calls[0][0]).toMatchObject({ cloudBotIds: ["b1", "b2"] });
  }
});
it("refuses unknown legacy usage instead of inventing an empty deletion mapping", () => {
  const browserRoot = join(root, "browser"); mkdirSync(browserRoot); mkdirSync(join(browserRoot, "b1"));
  const history = new CloudBrowserProfileUsage(join(root, "missing-history.json"), browserRoot);
  expect(() => history.botsFor("work", ["b1"])).toThrow("could not confirm");
  expect(() => history.record("b1", "work")).toThrow("could not confirm");
});
it("ACKs a profile only after every mapped cleanup and rejects unknown, duplicate or traversing mappings", async () => {
  const send = vi.fn(), cleanup = vi.fn(async (_bot: string) => {});
  const peer = createSupervisorPort({ store: { getAll: () => ({}), patch: value => value }, send, cleanupBrowser: cleanup });
  for (const cloudBotIds of [undefined, ["../x"], ["b1", "b1"], [1]]) {
    await peer.handle({ type: "murage:browser-profile-deleted", requestId: "bad", cloudBotIds });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "murage:cloud-refused" }));
  }
  expect(cleanup).not.toHaveBeenCalled();
  cleanup.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("fixture cleanup failure"));
  await peer.handle({ type: "murage:browser-profile-deleted", requestId: "partial", cloudBotIds: ["b1", "b2"] });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
  expect(cleanup.mock.calls.map(call => call[0])).toEqual(["b1", "b2"]);
  await peer.handle({ type: "murage:browser-profile-deleted", requestId: "retry", cloudBotIds: ["b1", "b2"] });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
  await peer.handle({ type: "murage:browser-profile-deleted", requestId: "empty-known", cloudBotIds: [] });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
});
it("retains the affected-bot fence when a late success cannot be durably acknowledged", () => {
  const write = vi.fn((_file: string, _text: string) => {}), erased = vi.fn();
  const coordinator = new BrowserCleanupCoordinator({ file: join(root, "late.json"), send: () => true, write, cloudErased: erased });
  {
    const committed = coordinator.commit(coordinator.prepare("profile", "work", "work", ["b1"]));
    write.mockImplementationOnce(() => { throw new Error("fixture journal write failure"); });
    coordinator.receive({ type: "murage:browser-lifecycle-result", requestId: committed.requestId, ok: true });
    expect(coordinator.hasPendingBrowserBot("b1")).toBe(true);
    coordinator.receive({ type: "murage:browser-lifecycle-result", requestId: committed.requestId, ok: true });
    expect(coordinator.hasPendingBrowserBot("b1")).toBe(false);
    expect(erased).toHaveBeenCalledTimes(2);
  }
});
it("resumes the same quarantined bot tree after an interrupted erase and never sweeps another bot", () => {
  const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
  const script = `import importlib.util,os,shutil,sys
spec=importlib.util.spec_from_file_location("cleanup_fixture",sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=sys.argv[2];os.mkdir(root)
for bot in ["b1","b2"]:
 os.mkdir(root+"/"+bot,0o700)
 with open(root+"/"+bot+"/state","w") as stream:stream.write("fixture")
def interrupted(target,uid,gid):raise RuntimeError("fixture interrupted after rename")
try:module.cleanup_browser(root,"b1",os.getuid(),os.getgid(),erase=interrupted,stop=lambda home:None)
except RuntimeError:pass
assert not os.path.lexists(root+"/b1") and os.path.exists(root+"/.cleanup-b1/profile/state")
module.cleanup_browser(root,"b1",os.getuid(),os.getgid(),erase=lambda target,uid,gid:shutil.rmtree(target),stop=lambda home:None)
assert not os.path.lexists(root+"/.cleanup-b1") and os.path.exists(root+"/b2/state")
print("QUARANTINE_RETRY_OK")`;
  expect(execFileSync("python3", ["-I", "-c", script, launcher, join(root, "native-model")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toBe("QUARANTINE_RETRY_OK\n");
});

it("T20 cleaning up a never-created canary profile exits 0 and touches nothing", () => {
  const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
  const script = `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("cleanup_fixture",sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=sys.argv[2];os.mkdir(root);os.mkdir(root+"/bot",0o700)
def boom(*a):raise AssertionError("nothing exists, nothing is stopped or erased")
module.cleanup_browser(root,"__murage-ui-canary",os.getuid(),os.getgid(),erase=boom,stop=boom)
assert sorted(os.listdir(root))==["bot"]
print("CANARY_CLEANUP_OK")`;
  expect(execFileSync("python3", ["-I", "-c", script, launcher, join(root, "canary-never-created")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toBe("CANARY_CLEANUP_OK\n");
});

const lockLauncher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const lockHead = `import importlib.util,os,sys,time,fcntl
spec=importlib.util.spec_from_file_location("lock_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=sys.argv[2];os.mkdir(root,0o711);me=os.getuid();gid=os.getgid()
def hold(bot):
 r,w=os.pipe();pid=os.fork()
 if pid==0:
  fd=m.browser_lock(root,bot,0,owner=me);os.write(w,b"x")
  while True:time.sleep(1)
 os.read(r,1);return pid
def busy(fn):
 try:fn();return False
 except m.BrowserLockBusy:return True
`;
function runLock(body: string, name: string) {
  return execFileSync("python3", ["-I", "-c", lockHead + body, lockLauncher, join(root, name)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
it("r6 cleanup A holding the id lock makes cleanup B busy (not clean) without touching the profile, other ids stay free", () => {
  expect(runLock(`
os.mkdir(root+"/b1",0o700)
a=hold("b1")
ran=[]
assert busy(lambda:m.locked_browser_cleanup(root,"b1",me,gid,root+"/b1",wait=0,owner=me,stop=lambda h:ran.append(h),erase=None))
assert ran==[] and os.path.isdir(root+"/b1")
m.os.close(m.browser_lock(root,"b2",0,owner=me))
os.kill(a,9);os.waitpid(a,0)
print("BUSY_OK")`, "lock-busy")).toBe("BUSY_OK\n");
});
it("r6 a dead lock holder frees the lock (flock releases on process exit) and cleanup then completes", () => {
  expect(runLock(`
import shutil
os.mkdir(root+"/b1",0o700)
a=hold("b1")
assert busy(lambda:m.browser_lock(root,"b1",0,owner=me))
os.kill(a,9);os.waitpid(a,0)
m.locked_browser_cleanup(root,"b1",me,gid,root+"/b1",wait=0,owner=me,stop=lambda h:None,erase=lambda t,u,g:shutil.rmtree(t))
assert not os.path.lexists(root+"/b1") and not os.path.lexists(root+"/.cleanup-b1")
m.os.close(m.browser_lock(root,"b1",0,owner=me))
print("DEAD_OK")`, "lock-dead")).toBe("DEAD_OK\n");
});
it("r6 a launch before scope entry blocks cleanup until the scope fd is closed, then cleanup proceeds", () => {
  // Models main(): the launcher holds the lock on the inherited fd across enter_scope's exec;
  // the re-executed in-scope launcher closes it, and only then can cleanup take the lock.
  expect(runLock(`
os.mkdir(root+"/b1",0o700)
fd=m.browser_lock(root,"b1",0,owner=me)
os.dup2(fd,m.BROWSER_LOCK_FD,inheritable=True);os.close(fd)
assert busy(lambda:m.locked_browser_cleanup(root,"b1",me,gid,root+"/b1",wait=0,owner=me,stop=lambda h:None))
os.close(m.BROWSER_LOCK_FD)
ran=[]
m.locked_browser_cleanup(root,"b1",me,gid,root+"/b1",wait=0,owner=me,stop=lambda h:ran.append("stop"),erase=lambda t,u,g:(ran.append("erase"),__import__("shutil").rmtree(t)))
assert ran==["stop","erase"]
print("PRESCOPE_OK")`, "lock-prescope")).toBe("PRESCOPE_OK\n");
});
it("r6 the browser launch takes the lock before enter_scope and the in-scope launcher releases it", () => {
  const src = readFileSync(lockLauncher, "utf8");
  expect(src.indexOf("hold_prescope_lock(request[\"bot\"])")).toBeGreaterThan(0);
  expect(src.indexOf("hold_prescope_lock(request[\"bot\"])")).toBeLessThan(src.indexOf("enter_scope(payload, plan)  # execs"));
  expect(src.indexOf("os.close(BROWSER_LOCK_FD)")).toBeGreaterThan(src.indexOf("is not inside its resource scope"));
  expect(src).toContain("sys.exit(BROWSER_LOCK_BUSY)");
});

const TOKEN_A = "A".repeat(22), TOKEN_B = "B".repeat(22);
const fenceHead = `
inst=root+"/inst";os.mkdir(inst,0o700)
def put(text,mode=0o600):
 p=inst+"/.server-instance"
 if os.path.lexists(p):os.unlink(p)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode);os.write(fd,text);os.close(fd);os.chmod(p,mode)
def fence(req):m.fence_server_instance(req,directory=inst,owner=me)
def refused(fn,kind=ValueError):
 try:fn();return False
 except kind:return True
`;
it("r7 a stale instance is refused with the lock released and no scope entered; a matching one proceeds", () => {
  expect(runLock(fenceHead + `
os.mkdir(root+"/b1",0o700)
entered=[]
def main_window(req):
 # Mirrors main(): hold the id's lock, fence, and only then enter the scope.
 fd=m.browser_lock(root,"b1",0,owner=me);os.dup2(fd,m.BROWSER_LOCK_FD,inheritable=True);os.close(fd)
 try:fence(req)
 except BaseException:
  os.close(m.BROWSER_LOCK_FD);raise
 entered.append("scope")
put(b"${TOKEN_B}\\n")
assert refused(lambda:main_window({"instance":"${TOKEN_A}"}),m.StaleServerInstance)
assert entered==[]
m.os.close(m.browser_lock(root,"b1",0,owner=me))   # the lock was released on refusal
main_window({"instance":"${TOKEN_B}"})
assert entered==["scope"]
assert busy(lambda:m.browser_lock(root,"b1",0,owner=me))   # held across scope entry until the in-scope launcher closes it
os.close(m.BROWSER_LOCK_FD)
print("FENCE_OK")`, "fence-stale")).toBe("FENCE_OK\n");
});
it("r7 a bad request instance or a bad instance file is refused (never treated as a match)", () => {
  expect(runLock(fenceHead + `
put(b"${TOKEN_A}\\n")
for bad in [None,"",1,"short","${TOKEN_A}\\n","a b"+"c"*20,"x"*65,"${TOKEN_A}/"]:
 assert refused(lambda:fence({"instance":bad})),bad
assert refused(lambda:fence({}))
for content in [b"${TOKEN_A}",b"${TOKEN_A}\\n\\n",b"${TOKEN_A}\\nX",b"short\\n",b"",b"x"*400,b"${TOKEN_A} \\n",b"\\xff"*22+b"\\n"]:
 put(content);assert refused(lambda:fence({"instance":"${TOKEN_A}"})),content
put(b"${TOKEN_A}\\n",0o666);assert refused(lambda:fence({"instance":"${TOKEN_A}"}))   # writable by others
put(b"${TOKEN_A}\\n",0o620);assert refused(lambda:fence({"instance":"${TOKEN_A}"}))
os.unlink(inst+"/.server-instance");assert refused(lambda:fence({"instance":"${TOKEN_A}"}),OSError)   # missing
put(b"${TOKEN_A}\\n");os.link(inst+"/.server-instance",root+"/second-link")                          # nlink != 1
assert refused(lambda:fence({"instance":"${TOKEN_A}"}))
os.unlink(root+"/second-link")
assert refused(lambda:m.fence_server_instance({"instance":"${TOKEN_A}"},directory=inst,owner=me+1))   # wrong owner
fence({"instance":"${TOKEN_A}"})
print("BADFILE_OK")`, "fence-bad")).toBe("BADFILE_OK\n");
});
it("r7 a symlinked instance file or directory is refused, and a directory that others can write is refused", () => {
  expect(runLock(fenceHead + `
real=root+"/real";os.mkdir(real,0o700)
fd=os.open(real+"/target",os.O_WRONLY|os.O_CREAT,0o600);os.write(fd,b"${TOKEN_A}\\n");os.close(fd)
os.unlink(inst+"/.server-instance") if os.path.lexists(inst+"/.server-instance") else None
os.symlink(real+"/target",inst+"/.server-instance")
assert refused(lambda:fence({"instance":"${TOKEN_A}"}),OSError)
os.unlink(inst+"/.server-instance")
os.rmdir(inst);os.symlink(real,inst)
os.rename(real+"/target",real+"/.server-instance")
assert refused(lambda:fence({"instance":"${TOKEN_A}"}),OSError)
os.unlink(inst);os.rename(real,inst)
fence({"instance":"${TOKEN_A}"})
os.chmod(inst,0o777)
assert refused(lambda:fence({"instance":"${TOKEN_A}"}))
print("SYMLINK_OK")`, "fence-symlink")).toBe("SYMLINK_OK\n");
});
it("r7 main() fences after taking the lock and before enter_scope, maps the stale exit to 76, and the request grammar admits the instance", () => {
  const src = readFileSync(lockLauncher, "utf8");
  const hold = src.indexOf("hold_prescope_lock(request[\"bot\"])"), fence = src.indexOf("fence_server_instance(request)"), enter = src.indexOf("enter_scope(payload, plan)  # execs");
  expect(hold).toBeGreaterThan(0); expect(fence).toBeGreaterThan(hold); expect(enter).toBeGreaterThan(fence);
  expect(src.slice(fence, enter)).toContain("release_prescope_lock()");
  expect(src).toContain("BROWSER_STALE_INSTANCE = 76"); expect(src).toContain("sys.exit(BROWSER_STALE_INSTANCE)");
  expect(runLock(`
ok={"mode":"browser","bot":"b1","args":["--version"],"settings":{"AGENT_BROWSER_SESSION":"s1","AGENT_BROWSER_ENCRYPTION_KEY":"a"*64},"instance":"${TOKEN_A}"}
m.validate_browser_request(ok,root)
def refused(fn):
 try:fn();return False
 except ValueError:return True
for bad in ["short",7,"a/b"+"c"*20]:
 assert refused(lambda:m.validate_browser_request({**ok,"instance":bad},root))
print("GRAMMAR_OK")`, "fence-grammar")).toBe("GRAMMAR_OK\n");
});
