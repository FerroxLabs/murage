// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD 13 r2, the commit gate (launcher half): a relay-spawned B-mode login publishes its new sign-in only when the relay
// answers `commit` on FD 4, under the cred lock, with `current` and the bot's tombstone unchanged. Drives the real launcher Python in a
// throwaway rig; FD 4 is a socketpair the test holds the far end of (COMMIT_FD is pointed at the launcher's end).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcher, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-commit-gate-"); });
afterEach(() => rig.dispose());

const prelude = `
import io, contextlib, tempfile, socket, signal, time
root=sys.argv[2]; ER=root+"/engine-homes"
m.ENGINE_ROOT=ER; m.LIVE_DIR=root+"/live"; m.TOMBSTONE_DIR=root+"/deleted"
m.COMMIT_WAIT=0.4
def store(engine, bot=None, create=True): return m.engine_signin_store(engine, bot, create=create, engine_root=ER)
def publish(engine, files, record, bot=None, unit=None):
    fd=store(engine, bot)
    try: return m.publish_generation(fd, {k: v.encode() for k, v in files.items()}, record, unit)
    finally: os.close(fd)
def current(engine, bot=None):
    fd=store(engine, bot, False)
    if fd is None: return None
    try:
        g, record, files=m.store_current(fd)
        return {"g": g, "files": {k: v.decode() for k, v in files.items()}}
    finally: os.close(fd)
def stage(engine, bot):
    t=tempfile.mkdtemp(dir=root); hfd=os.open(ER+"/"+engine, os.O_RDONLY|os.O_DIRECTORY); tfd=os.open(t, os.O_RDONLY|os.O_DIRECTORY)
    snap=m.stage_turn_home(hfd, engine, tfd, None, (os.getuid(),), m.turn_state_ids(engine, [], None), bot=bot, render=None)
    return {"dir": t, "hfd": hfd, "tfd": tfd, "snap": snap, "engine": engine, "bot": bot}
def put(t, rel, text):
    path=t["dir"]+"/"+rel
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "w").write(text)
def collect(t):
    err=io.StringIO(); raised=None; changed=None
    with contextlib.redirect_stderr(err):
        try:
            changed=m.collect_turn_home(t["hfd"], t["engine"], t["tfd"], t["snap"], None, (os.getuid(),), m.turn_state_ids(t["engine"], [], None), bot=t["bot"], unit="u", login=True, signin=True, commit=True)
        except m.SigninNotConfirmed as e: raised=str(e)
    return {"changed": changed, "raised": raised, "err": err.getvalue()}
TOKEN='{"tokens":{"access_token":"new","account_id":"acct"}}'
def rig_socket(reply):
    """The launcher's end becomes COMMIT_FD; the relay's end (b) has its reply queued, or is closed when reply is None, or stays silent for ''."""
    a, b = socket.socketpair(); m.COMMIT_FD=a.fileno()
    if reply is None: b.close()
    elif reply: b.sendall(reply)
    return a, b
out=[]
`;
const run = (source: string) => rig.py(prelude + source + "\nprint(json.dumps(out))", rig.root, rig.manifest);
const result = (source: string) => JSON.parse(run(source)) as unknown[];
const login = (reply: string, extra = "") => `
a, b = rig_socket(${reply})
t=stage("codex", "alpha"); put(t, ".codex/auth.json", TOKEN)
${extra}
r=collect(t); r["heard"]=(b.recv(64).decode() if ${reply} is not None else "gone")
r["current"]=current("codex", "alpha"); out.append(r)
`;

describe("commit gate: the launcher publishes a login only on the relay's yes", () => {
  it("(a) FD 4 at EOF publishes nothing, current is unchanged and the fixed line is raised", () => {
    const [r] = result(login("None"));
    expect(r).toMatchObject({ changed: null, raised: "Cloud engine sign-in was not confirmed", current: null });
  });
  it("(b) `commit` publishes G+1, after the launcher wrote exactly `ready`", () => {
    const [r] = result(login(`b"commit\\n"`));
    expect(r).toMatchObject({ changed: [".codex/auth.json"], raised: null, heard: "ready\n", current: { g: 1 } });
  });
  it("(c) other bytes, silence, a moved current and a tombstone each discard; the previous generation stays", () => {
    const [bytes, silent, long, moved, tomb] = result(`
for reply in (b"yes\\n", b"", b"commit\\ncommit\\ncommit\\n"):
${login("reply").split("\n").map(line => "    " + line).join("\n")}
a, b = rig_socket(b"commit\\n")
t=stage("codex", "alpha"); put(t, ".codex/auth.json", TOKEN)
publish("codex", {".codex/auth.json": '{"tokens":{"access_token":"other"}}'}, {"mode": "chatgpt", "kind": "signin", "enrolledAt": 1, "expiresAt": None}, bot="alpha")
r=collect(t); r["heard"]=""; r["current"]=current("codex", "alpha"); out.append(r)
a, b = rig_socket(b"commit\\n")
t=stage("codex", "beta"); put(t, ".codex/auth.json", TOKEN)
m.write_tombstone("beta")
r=collect(t); r["heard"]=b.recv(64).decode(); r["current"]=current("codex", "beta"); out.append(r)
`);
    expect(bytes).toMatchObject({ raised: "Cloud engine sign-in was not confirmed", heard: "ready\n", current: null });
    expect(silent).toMatchObject({ raised: "Cloud engine sign-in was not confirmed", heard: "ready\n", current: null });
    expect(long).toMatchObject({ raised: "Cloud engine sign-in was not confirmed", current: null });
    expect(moved).toMatchObject({ raised: "Cloud engine sign-in was not confirmed", heard: "" });
    expect((moved as { current: { g: number } }).current.g).toBe(1);
    expect(tomb).toMatchObject({ raised: "Cloud engine sign-in was not confirmed", heard: "ready\n", current: null });
  });
  it("a login that changed nothing sends no `ready`", () => {
    const [r] = result(`
a, b = rig_socket(b"commit\\n"); b.settimeout(0.2)
t=stage("codex", "alpha")
r=collect(t)
try: r["heard"]=b.recv(64).decode()
except Exception: r["heard"]="nothing"
out.append(r)`);
    expect(r).toMatchObject({ changed: [], raised: null, heard: "nothing" });
  });
  it("(d) a stopped login goes through the same gate: with the relay gone, SIGTERM publishes nothing and the launcher exits 1", () => {
    const [status, current] = result(`
a, b = rig_socket(None)
t=stage("codex", "alpha"); put(t, ".codex/auth.json", TOKEN)
real=os.dup(1)
signal.signal(signal.SIGALRM, lambda *x: os.kill(os.getpid(), signal.SIGTERM)); signal.setitimer(signal.ITIMER_REAL, 0.3)
err=io.StringIO()
def child(): time.sleep(30)
def collector():
    r=collect(t)
    if r["raised"]: raise m.SigninNotConfirmed(r["raised"])
status=m.run_turn(child, collector)
os.dup2(real, 1)
out.append(status); out.append(current("codex", "alpha"))`);
    expect(status).toBe(1);
    expect(current).toBeNull();
  });
});

describe("commit gate: FD 4 handling", () => {
  it("(e) the sandbox child closes FD 4 first thing; the descriptor survives the --in-scope re-exec", () => {
    const text = readFileSync(launcher, "utf8");
    expect(text).toMatch(/def child\(stdout_fd=None\):\n\s+drop_commit_channel\(commit\)\n/);
    const [closed] = result(`
a, b = rig_socket(b"")
pid=os.fork()
if pid == 0:
    m.drop_commit_channel(True)
    try: os.fstat(a.fileno()); os._exit(1)
    except OSError: os._exit(0)
out.append(os.waitpid(pid, 0)[1] == 0)
a.close()`);
    expect(closed).toBe(true);
    const probe = rig.py(`
import socket
a, b = socket.socketpair(); os.dup2(a.fileno(), 4, inheritable=True)
root=sys.argv[2]; os.makedirs(root+"/req", mode=0o700, exist_ok=True)
probe="import os,stat,json;print(json.dumps({'sock': stat.S_ISSOCK(os.fstat(4).st_mode)}))"
m.enter_scope(b"{}", ("murage-turn-0123456789abcdef.scope", "murage.slice", []), execv=lambda path, argv: os.execv("/usr/bin/python3", ["python3", "-I", "-c", probe]), root=root+"/req", owner=os.getuid())`, rig.root);
    expect(JSON.parse(probe.trim().split("\n").pop()!)).toEqual({ sock: true });
  });
  it("(i) a commit request needs FD 4 to be a socket, action login, a bot and a B engine", () => {
    const [noFd, ok, logout, noBot, claude, falsy] = result(`
def req(**kw):
    try: return m.validate_login_request(dict({"mode": "login", "engine": "codex", "action": "login", "bot": "alpha"}, **kw))
    except ValueError as e: return str(e)
m.COMMIT_FD=os.open(os.devnull, os.O_RDONLY)
out.append(req(commit=True))
a, b = rig_socket(b"")
out.append(req(commit=True)); out.append(req(commit=True, action="logout")); out.append(req(commit=True, bot=None, engine="kimiAgent", action="logout"))
out.append(req(commit=True, engine="claudeAgent")); out.append(req(commit=False))`);
    expect(noFd).toBe("Cloud sign-in commit channel is missing");
    expect(ok).toMatchObject({ commit: true, bot: "alpha" });
    expect(logout).toBe("Cloud sign-in commit is not allowed");
    expect(noBot).toBe("Cloud sign-in commit is not allowed");
    expect(claude).toBe("Cloud sign-in commit is not allowed");
    expect(falsy).toBe("Cloud sign-in commit is not allowed");
  });
});
