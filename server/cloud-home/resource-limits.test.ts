// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit A1-03 / A1-05: turns and browsers run in transient scopes under limited slices.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const dir = (name: string) => fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url));
const launcher = dir("murage-turn-launch.py");
const text = (name: string) => readFileSync(dir(name), "utf8");
const prelude = `
import importlib.util, json, os, sys, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("l", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
`;
const run = (body: string) => spawnSync("python3", ["-I", "-c", prelude + body, launcher], { encoding: "utf8" });
const py = (body: string) => { const r = run(body); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout); };

it("installs both slices with percentage memory caps, task caps and a CPU weight below the server's", () => {
  const turns = text("murage-turns.slice"), browsers = text("murage-browsers.slice");
  expect(turns).toContain("[Slice]"); expect(turns).toMatch(/^MemoryMax=50%$/m); expect(turns).toMatch(/^TasksMax=1024$/m);
  expect(browsers).toContain("[Slice]"); expect(browsers).toMatch(/^MemoryMax=35%$/m); expect(browsers).toMatch(/^TasksMax=2048$/m);
  for (const slice of [turns, browsers]) expect(Number(/^CPUWeight=(\d+)$/m.exec(slice)![1])).toBeLessThan(100);
  const build = text("build-image.sh");
  for (const name of ["murage-turns.slice", "murage-browsers.slice"]) expect(build).toContain(`install -m 0644 deploy/cloud-home/${name} /etc/systemd/system/${name}`);
});
it("plans a scope per turn and per browser launch, and none for cleanup modes", () => {
  const r = py(`
print(json.dumps({"turn": m.scope_plan({"mode": "turn"}), "browser": m.scope_plan({"mode": "browser", "bot": "bot-1", "args": ["mcp", "--tools", "core", "--no-webmcp"], "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "a" * 64}}),
 "cleanup": m.scope_plan({"mode": "browser-cleanup", "bot": "bot-1"}), "signin": m.scope_plan({"mode": "engine-signin-cleanup"})}))`);
  expect(r.turn[0]).toMatch(/^murage-turn-[0-9a-f]{16}\.scope$/); expect(r.turn[1]).toBe("murage-turns.slice");
  expect(r.turn[2]).toEqual(expect.arrayContaining(["TasksMax=512", "MemoryMax=40%"]));
  expect(r.browser[0]).toMatch(/^murage-browser-bot-1\.[0-9a-f]{8}\.scope$/); expect(r.browser[1]).toBe("murage-browsers.slice");
  expect(r.browser[2].some((p: string) => p.startsWith("MemoryMax="))).toBe(true); expect(r.browser[2].some((p: string) => p.startsWith("TasksMax="))).toBe(true);
  expect(r.cleanup).toBeNull(); expect(r.signin).toBeNull();
  expect(run(`m.scope_plan({"mode": "browser", "bot": "../x", "args": [], "settings": {}})`).status).not.toBe(0);
});
it("re-execs through systemd-run --scope with slice, unit, limits and the request in a root-only file", () => {
  // systemd-run passes no extra descriptors into a scope (seen on a real home:
  // FD 3 was gone), so the request travels as a 0600 file in a 0700 directory.
  const r = py(`
plan = m.scope_plan({"mode": "turn"})
root = tempfile.mkdtemp() + "/req"; calls = []
def execv(path, argv):
    calls.append([path, argv]); req = argv[-1]
    calls.append({"mode": oct(os.stat(req).st_mode & 0o777), "dir": oct(os.stat(root).st_mode & 0o777)})
    calls.append(m.take_scope_request(req, root, os.getuid()).decode()); calls.append(os.path.exists(req))
m.enter_scope(b'{"mode":"turn"}', plan, execv, root, os.getuid())
bad = []
for path in [root + "/../x", root + "/r-zz", "/etc/passwd"]:
    try: m.take_scope_request(path, root, os.getuid()); bad.append("accepted " + path)
    except Exception: pass
print(json.dumps({"plan": plan, "calls": calls, "bad": bad, "root": root}))`);
  const [[path, argv], modes, payload, stillThere] = r.calls;
  expect(modes).toEqual({ mode: "0o600", dir: "0o700" }); expect(stillThere).toBe(false); expect(r.bad).toEqual([]);
  expect(path).toBe("/usr/bin/systemd-run");
  for (const flag of ["--scope", "--quiet", "--collect"]) expect(argv).toContain(flag);
  expect(argv).toContain("--slice=murage-turns.slice"); expect(argv).toContain(`--unit=${r.plan[0]}`);
  expect(argv[argv.indexOf("TasksMax=512") - 1]).toBe("-p"); expect(argv).toContain("MemoryMax=40%");
  const sep = argv.indexOf("--"); expect(argv.slice(sep, -1)).toEqual(["--", "/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--in-scope"]);
  const req = argv[argv.length - 1]; expect(req.startsWith(r.root + "/r-")).toBe(true); expect(req.slice(r.root.length + 3)).toMatch(/^[0-9a-f]{32}$/);
  expect(payload).toBe('{"mode":"turn"}');
});
// The supervisor wraps every turn it admits (r8 R1); `admitted: false` is a payload without that record.
const mainWith = (cgroupLine: string, argv: string[], execBinary?: string, admitted = true) => run(`
cg = tempfile.NamedTemporaryFile("w", delete=False); cg.write(${JSON.stringify(cgroupLine)}); cg.close()
payload = tempfile.TemporaryFile(); payload.write(b'{"mode":"turn"}'); payload.flush(); os.dup2(payload.fileno(), 3); os.lseek(3, 0, 0)
os.geteuid = lambda: 0; os.environ["SUDO_UID"] = "1234"; m.assert_image_launcher = lambda: None
m.pwd = SimpleNamespace(getpwnam=lambda n: SimpleNamespace(pw_uid=1234))
_in_scope = m.in_scope; m.in_scope = lambda plan: _in_scope(plan, cg.name)
${execBinary ? `m.SYSTEMD_RUN = ${JSON.stringify(execBinary)}` : ""}
m.launch = lambda request: print("LAUNCHED")
m.take_scope_request = lambda path: ${admitted ? `b'{"request":{"mode":"turn"},"admission":{"fds":0}}'` : `b'{"mode":"turn"}'`}
sys.argv = ["launcher"] + ${JSON.stringify(argv)}
m.main()`);
it("fails closed when the scope cannot be created: the turn is never launched", () => {
  const r = mainWith("0::/system.slice/murage-home.service\n", [], "/usr/bin/false");
  expect(r.status).not.toBe(0); expect(r.stdout).not.toContain("LAUNCHED");
  const missing = mainWith("0::/system.slice/murage-home.service\n", [], "/nonexistent/systemd-run");
  expect(missing.status).not.toBe(0); expect(missing.stdout).not.toContain("LAUNCHED");
});
it("only launches from --in-scope when the cgroup really is a murage scope under its slice", () => {
  const good = mainWith("0::/murage.slice/murage-turns.slice/murage-turn-0123456789abcdef.scope\n", ["--in-scope", "/run/murage-turn-requests/r-00000000000000000000000000000000"]);
  expect(good.stdout).toContain("LAUNCHED");
  for (const line of ["0::/system.slice/murage-home.service\n", "0::/murage.slice/murage-browsers.slice/murage-turn-0123456789abcdef.scope\n", "0::/murage.slice/murage-turns.slice/murage-turn-evil.scope\n", "0::/murage-turns.slice\n", "1:cpu:/x\n"]) {
    const r = mainWith(line, ["--in-scope", "/run/murage-turn-requests/r-00000000000000000000000000000000"]);
    expect([line, r.status === 0, r.stdout.includes("LAUNCHED")]).toEqual([line, false, false]);
  }
});
it("never launches an in-scope turn whose payload carries no admission record", () => {
  const r = mainWith("0::/murage.slice/murage-turns.slice/murage-turn-0123456789abcdef.scope\n", ["--in-scope", "/run/murage-turn-requests/r-00000000000000000000000000000000"], undefined, false);
  expect(r.status).not.toBe(0); expect(r.stdout).not.toContain("LAUNCHED");
  expect(r.stderr).toContain("Cloud turn was not admitted");
});
it("refuses to enter a scope for requests that never get one", () => {
  const r = run(`
f = tempfile.NamedTemporaryFile(); f.write(b'{"mode":"browser-cleanup","bot":"bot-1"}'); f.flush(); os.dup2(f.fileno(), 3); os.lseek(3, 0, 0)
os.geteuid = lambda: 0; os.environ["SUDO_UID"] = "1234"; m.assert_image_launcher = lambda: None
m.pwd = SimpleNamespace(getpwnam=lambda n: SimpleNamespace(pw_uid=1234))
m.in_scope = lambda plan: True
m.take_scope_request = lambda path: b'{"mode":"browser-cleanup","bot":"bot-1"}'
sys.argv = ["launcher", "--in-scope", "/run/murage-turn-requests/r-00000000000000000000000000000000"]
m.main()`);
  expect(r.status).not.toBe(0);
});
const fakeSystemctl = `
log = tempfile.mkdtemp() + "/calls"
fake = tempfile.mkdtemp() + "/systemctl"
open(fake, "w").write("#!/bin/sh\\necho \\"$@\\" >> " + log + "\\n"); os.chmod(fake, 0o755)
calls = lambda: open(log).read().splitlines() if os.path.exists(log) else []
`;
it("supervisor propagates the child's exit status and kills then stops the turn scope afterwards", () => {
  const r = py(fakeSystemctl + `
out = {}
out["exit"] = m.supervise_scope("murage-turn-aaaa.scope", lambda: os._exit(7), fake, lambda n: None)
out["calls"] = calls()
out["sig"] = m.supervise_scope("murage-turn-bbbb.scope", lambda: os.kill(os.getpid(), 9), fake, lambda n: None)
out["refused"] = m.supervise_scope("murage-turn-cccc.scope", lambda: (_ for _ in ()).throw(OSError("no")), fake, lambda n: None)
print(json.dumps(out))`);
  expect(r.exit).toBe(7); expect(r.sig).toBe(137); expect(r.refused).toBe(1);
  expect(r.calls).toEqual(["kill --kill-whom=all --signal=SIGKILL murage-turn-aaaa.scope", "stop murage-turn-aaaa.scope"]);
});
it("a SIGTERM to the supervisor tears the scope down, reaps the child and exits 143", () => {
  const r = py(fakeSystemctl + `
import threading, signal, time
threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
t = time.time(); pids = []
def child(): os.execv("/bin/sleep", ["sleep", "30"])
status = m.supervise_scope("murage-turn-dddd.scope", child, fake, lambda n: None)
try: os.waitpid(-1, os.WNOHANG); reaped = False
except ChildProcessError: reaped = True
print(json.dumps({"status": status, "calls": calls(), "fast": time.time() - t < 10, "reaped": reaped}))`);
  expect(r.status).toBe(143); expect(r.fast).toBe(true); expect(r.reaped).toBe(true);
  expect(r.calls).toEqual(["kill --kill-whom=all --signal=SIGKILL murage-turn-dddd.scope", "stop murage-turn-dddd.scope"]);
});
it("the supervisor arms its parent-death signal and treats an already-dead caller as a stop", () => {
  const r = py(fakeSystemctl + `
armed = []; real = os.getppid
os.getppid = lambda: 1 if armed else real()
status = m.supervise_scope("murage-turn-eeee.scope", lambda: os.execv("/bin/sleep", ["sleep", "30"]), fake, lambda n: armed.append(n))
print(json.dumps({"armed": armed, "status": status, "calls": len(calls())}))`);
  expect(r.armed).toEqual([15]); expect(r.status).toBe(143); expect(r.calls).toBe(2);
});
it("every turn scope gets a 6 h RuntimeMaxSec, sign-in 20 min, browsers none", () => {
  const r = py(`
mk = lambda req: [p for p in m.scope_plan(req)[2] if p.startswith("RuntimeMax")]
out = {"turn": mk({"mode": "turn"}), "login": mk({"mode": "login", "engine": "codex", "action": "login", "bot": "fixture-bot"}), "browser": [p for p in m.BROWSER_SCOPE_PROPERTIES if p.startswith("RuntimeMax")]}
out["max"] = [m.scope_runtime_max(m.TURN_SCOPE_PROPERTIES), m.scope_runtime_max(m.BROWSER_SCOPE_PROPERTIES)]
print(json.dumps(out))`);
  expect(r.turn).toEqual(["RuntimeMaxSec=21600"]); expect(r.login).toEqual(["RuntimeMaxSec=1200"]);
  expect(r.browser).toEqual([]); expect(r.max).toEqual([21600, null]);
});
it("a scope ended by its time limit is a failure with a short stderr message, even on exit 0", () => {
  const r = py(fakeSystemctl + `
import io, contextlib
err = io.StringIO()
with contextlib.redirect_stderr(err):
    late = m.supervise_scope("murage-turn-ffff.scope", lambda: (time.sleep(1.2), os._exit(0)), fake, lambda n: None, max_runtime=1)
early = m.supervise_scope("murage-turn-gggg.scope", lambda: os._exit(0), fake, lambda n: None, max_runtime=3600)
print(json.dumps({"late": late, "early": early, "err": err.getvalue()}))`.replace("import io,", "import time, io,"));
  expect(r.late).toBe(124); expect(r.early).toBe(0); expect(r.err).toBe("Cloud turn stopped: it ran past its time limit\n");
});
// main() lowers its own OOM score through /proc/self/oom_score_adj before it dispatches: Linux only.
it.skipIf(process.platform !== "linux")("turns and logins are supervised, browser launches keep the plain exec", () => {
  const src = text("murage-turn-launch.py");
  expect(src).toContain('plan[0].startswith("murage-turn-")');
  const r = py(`
seen = []
def drive(request):
    plan = m.scope_plan(request); out = []
    m.supervise_scope = lambda unit, child, *a, **k: (out.append("supervised"), 0)[1]
    m.enter_scope = lambda payload, plan, admission=None: out.append("exec")
    # admission (bot and workspace locks on the host /run) is tested in admission-launcher.test.ts
    m.admit = lambda request, unit, bot=None: {"fds": 0, "names": [], "bot": bot, "roots": []}
    f = tempfile.NamedTemporaryFile(); f.write(json.dumps(request).encode()); f.flush(); os.dup2(f.fileno(), 3); os.lseek(3, 0, 0)
    os.geteuid = lambda: 0; os.environ["SUDO_UID"] = "1234"; m.assert_image_launcher = lambda: None
    m.pwd = SimpleNamespace(getpwnam=lambda n: SimpleNamespace(pw_uid=1234))
    sys.argv = ["launcher"]
    try: m.main()
    except SystemExit: pass
    except Exception: out.append("refused")
    return out
b = {"mode": "browser", "bot": "bot-1", "args": ["mcp", "--tools", "core", "--no-webmcp"], "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "a" * 64}}
m.launch_browser = lambda request: None; m.hold_prescope_lock = lambda bot: None; m.fence_server_instance = lambda request: None
print(json.dumps({"turn": drive({"mode": "turn"}), "browser": drive(b)}))`);
  expect(r.turn).toEqual(["supervised"]); expect(r.browser).toEqual(["exec", "refused"]);
});
it("launch() execs pasta only after dropping privileges, and the browser launch has no unscoped path", () => {
  const src = text("murage-turn-launch.py");
  expect(src.indexOf("os.setuid(account.pw_uid)")).toBeLessThan(src.indexOf("os.execve(PASTA, pasta_argv(turn_dir), env)"));
  // The scope is entered in main() before any dispatch, for turns and browsers alike.
  expect(src.indexOf("enter_scope(payload, plan)")).toBeLessThan(src.indexOf("launch_browser(request)\n    else:\n        launch(request)"));
});
it("refuses a turn plan whose tmpfs has no size cap", () => {
  const r = py(`
root = os.path.realpath(tempfile.mkdtemp()); os.getuid = lambda: 424242
def attempt(argv, name):
    d = m.write_turn_dir(argv, {"seccomp": b"12345678"}, None, root, name)
    try: m.load_turn_plan(d, root); return "ok"
    except ValueError as e: return "refused:" + str(e)
base = ["/usr/bin/bwrap", "--seccomp", "@fd:seccomp"]
print(json.dumps({"sized": attempt(base + ["--size", "1024", "--tmpfs", "/tmp", "--", "x"], "t-0000000000000001"),
 "bare": attempt(base + ["--tmpfs", "/tmp", "--", "x"], "t-0000000000000002"),
 "badsize": attempt(base + ["--size", "-1", "--tmpfs", "/tmp", "--", "x"], "t-0000000000000003"),
 "wrongorder": attempt(base + ["--tmpfs", "/tmp", "--size", "1024", "--", "x"], "t-0000000000000004")}))`);
  expect(r.sized).toBe("ok");
  for (const k of ["bare", "badsize", "wrongorder"]) expect([k, r[k]]).toEqual([k, "refused:Cloud turn plan tmpfs has no size cap"]);
});
it("the pasta child accepts a per-turn /tmp temp file bound from data, and still refuses any other /tmp path", () => {
  // turn_mount_args admitted these files, but load_turn_plan re-checked the grant without them, so every
  // Claude turn (its mcp.json lives in the render directory /tmp/murage-render-<unit hex>/) died on a real home.
  const r = py(`
root = os.path.realpath(tempfile.mkdtemp()); os.getuid = lambda: 424242
def attempt(path, name):
    argv = ["/usr/bin/bwrap", "--seccomp", "@fd:seccomp", "--size", "1024", "--tmpfs", "/tmp", "--ro-bind-data", "@fd:mcp", path, "--", "x"]
    d = m.write_turn_dir(argv, {"seccomp": b"12345678", "mcp": b"{}"}, None, root, name)
    try: m.load_turn_plan(d, root); return "ok"
    except ValueError as e: return "refused:" + str(e)
print(json.dumps({"mcp": attempt("/tmp/murage-render-0123456789abcdef/mcp.json", "t-0000000000000011"),
 "evil": attempt("/tmp/evil.json", "t-0000000000000012"), "etc": attempt("/etc/passwd", "t-0000000000000013")}))`);
  expect(r.mcp).toBe("ok");
  expect(r.evil).toBe("refused:Cloud turn file is outside its grant");
  expect(r.etc).toBe("refused:Cloud turn file is outside its grant");
});
it("namespace teardown kills the bot's browser scopes", () => {
  const helper = text("murage-browser-namespace.py");
  expect(helper).toContain("def kill_scopes");
  expect(helper).toContain("--signal=SIGKILL");
  expect(helper.match(/self\.system\.kill_scopes\(bot, keep\)/g)!.length).toBe(2);
});
it("stopping or restarting the home ends every turn and browser scope", () => {
  // BindsTo= alone did not stop the scopes on a restart on a real home.
  expect(text("murage-home.service")).toMatch(/^ExecStopPost=-\/usr\/bin\/systemctl stop --no-block murage-turns\.slice murage-browsers\.slice$/m);
});
it("browser ids are bounded and request staging is bounded (re-audit)", () => {
  const r = py(`
out = {}
for bot in ["a" * 64, "a" * 65]:
    try: m.validate_browser_request({"mode": "browser", "bot": bot, "args": ["--version"], "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "0" * 64}}); out[len(bot)] = "ok"
    except Exception: out[len(bot)] = "refused"
root = tempfile.mkdtemp() + "/req"; os.makedirs(root, 0o700)
for i in range(64): open(root + "/r-%032x" % i, "w").close()
try: m.enter_scope(b"{}", m.scope_plan({"mode": "turn"}), lambda *a: None, root, os.getuid()); out["staging"] = "accepted"
except ValueError: out["staging"] = "refused"
print(json.dumps(out))`);
  expect(r).toEqual({ "64": "ok", "65": "refused", staging: "refused" });
});
it("the server is protected from the OOM killer and turns and browsers are not (re-audit F5)", () => {
  const unit = text("murage-home.service");
  expect(unit).toMatch(/^MemoryLow=512M$/m); expect(unit).toMatch(/^OOMScoreAdjust=-900$/m);
  const src = text("murage-turn-launch.py");
  expect(src.indexOf('stream.write("300")')).toBeGreaterThan(0);
  expect(src.indexOf('stream.write("300")')).toBeLessThan(src.indexOf("enter_scope(payload, plan)  # execs"));
  for (const props of ["TURN_SCOPE_PROPERTIES", "BROWSER_SCOPE_PROPERTIES"]) expect(src).toMatch(new RegExp(props + ' = \\[[^\\]]*"TimeoutStopSec=5"'));
});
it("the image applies every update at its pinned snapshot and drops snapd (audit tools: grype)", () => {
  const image = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(image).toMatch(/^apt-get -S 20260930T000000Z -o Dpkg::Options::=--force-confold full-upgrade -y$/m);
  expect(image).toMatch(/^apt-get purge -y --auto-remove snapd$/m);
});
it("the customer image has no sshd: finalize-customer-image.sh purges openssh-server, only the client is installed", () => {
  const image = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  const fin = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/finalize-customer-image.sh", import.meta.url)), "utf8");
  expect(fin).toMatch(/^apt-get purge -y --auto-remove openssh-server$/m);
  expect(image).toMatch(/install -y openssh-client$/m);
  expect(image).not.toMatch(/install -y[^\n]*openssh-server/);
  expect(image).not.toMatch(/PermitRootLogin\s+yes|systemctl (enable|unmask)[^\n]*ssh/);
});
it("no early-exit grep -q pipes under pipefail in the image build (SIGPIPE 141 on a real build)", () => {
  const image = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(image).toMatch(/^set -euo pipefail$/m);
  expect(image).not.toMatch(/\|\s*grep -q/);
});
it("each home gets its own machine-id and no build journal (seen shared on a real home)", () => {
  const driver = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/qualify/hz-live.py", import.meta.url)), "utf8");
  for (const step of ["truncate -s 0 /etc/machine-id", "rm -rf /var/log/journal", "cloud-init clean --logs"]) expect(driver).toContain(step);
  const image = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(image.indexOf("systemctl restart systemd-journald")).toBeGreaterThan(image.indexOf("journald.conf.d/murage.conf"));
});
it("runs a turn or login in the scope the server named, only in the exact murage-turn shape, and refuses anything else", () => {
  const good = "murage-turn-0123456789abcdef.scope";
  const r = py(`
good = ${JSON.stringify(good)}
out = {"turn": m.scope_plan({"mode": "turn", "unit": good}), "login": m.scope_plan({"mode": "login", "engine": "codex", "action": "login", "bot": "fixture-bot", "unit": good}), "bad": []}
for bad in ["murage-turn-0123456789ABCDEF.scope", "murage-turn-0123456789abcde.scope", "murage-turn-0123456789abcdef.scope\\n", "../murage-turn-0123456789abcdef.scope",
            "murage-turn-0123456789abcdef.service", "murage-browser-bot.01234567.scope", "-p", "", None, 5, ["x"]]:
    try: m.scope_plan({"mode": "turn", "unit": bad}); out["bad"].append("accepted %r" % (bad,))
    except ValueError: pass
try: m.scope_plan({"mode": "browser", "bot": "b", "args": [], "settings": {}, "unit": good}); out["bad"].append("browser accepted a unit")
except ValueError: pass
cg = tempfile.NamedTemporaryFile("w", delete=False); cg.write("0::/murage-turns.slice/" + good + "\\n"); cg.close()
other = tempfile.NamedTemporaryFile("w", delete=False); other.write("0::/murage-turns.slice/murage-turn-fedcba9876543210.scope\\n"); other.close()
plan = m.scope_plan({"mode": "turn", "unit": good})
out["inside"] = m.in_scope(plan, cg.name, True); out["wrong_scope"] = m.in_scope(plan, other.name, True); out["wrong_scope_unfixed"] = m.in_scope(plan, other.name)
print(json.dumps(out))`);
  expect(r.turn[0]).toBe(good); expect(r.turn[1]).toBe("murage-turns.slice"); expect(r.login[0]).toBe(good);
  expect(r.bad).toEqual([]); expect(r.inside).toBe(true); expect(r.wrong_scope).toBe(false); expect(r.wrong_scope_unfixed).toBe(true);
});
