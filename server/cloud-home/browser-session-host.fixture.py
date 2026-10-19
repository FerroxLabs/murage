# SPDX-License-Identifier: AGPL-3.0-or-later
"""Session-host fixtures (rig581): the real launcher functions with a fake
agent-browser that keeps 0.38.1's daemon contract (socket-only liveness, the
daemon forked by a one-shot client with setsid, .sock/.pid/.cdp files left
behind when it dies). Linux only (/proc, PR_SET_CHILD_SUBREAPER). Nothing here
needs or uses root, bwrap, systemd or Chrome.

Every per-command step runs as its own process that emulates the per-command
sandbox's end (bwrap --unshare-pid --die-with-parent): when the command
returns, everything it left behind is killed, exactly what the pid namespace
teardown did to the daemon on rig581."""
import ctypes
import fcntl
import importlib.util
import json
import os
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time

LAUNCHER = sys.argv[1]
CASE = sys.argv[2]
spec = importlib.util.spec_from_file_location("session_host_fixture", LAUNCHER)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

FAKE = r'''#!/usr/bin/env python3
import json, os, socket, subprocess, sys, threading, time, select
d, s = os.environ["AGENT_BROWSER_SOCKET_DIR"], os.environ["AGENT_BROWSER_SESSION"]
sock_path, pid_path, cdp_path = d + "/" + s + ".sock", d + "/" + s + ".pid", d + "/" + s + ".cdp"
def ready():
    c = socket.socket(socket.AF_UNIX)
    try:
        c.connect(sock_path); return True
    except OSError:
        return False
    finally:
        c.close()
def ask(obj):
    c = socket.socket(socket.AF_UNIX); c.connect(sock_path); c.sendall((json.dumps(obj) + "\n").encode()); data = b""
    while not data.endswith(b"\n"):
        part = c.recv(4096)
        if not part: break
        data += part
    c.close(); return json.loads(data)
if os.environ.get("AGENT_BROWSER_DAEMON") == "1":
    # A stand-in for Chrome, deliberately left running if the daemon dies: only the host may reap it.
    subprocess.Popen([sys.executable, "-c", "import time\ntime.sleep(600)", d + "/fake-chrome"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tcp = socket.socket(); tcp.bind(("127.0.0.1", 0)); tcp.listen(8)
    def echo():
        while True:
            conn, _ = tcp.accept()
            def serve(c):
                while True:
                    data = c.recv(65536)
                    if not data: return
                    c.sendall(data)
            threading.Thread(target=serve, args=(conn,), daemon=True).start()
    threading.Thread(target=echo, daemon=True).start()
    open(cdp_path, "w").write("ws://127.0.0.1:%d/devtools/browser/fake" % tcp.getsockname()[1])
    try: os.unlink(sock_path)
    except OSError: pass
    srv = socket.socket(socket.AF_UNIX); srv.bind(sock_path); srv.listen(8)
    open(pid_path, "w").write(str(os.getpid()))
    idle = int(os.environ.get("AGENT_BROWSER_IDLE_TIMEOUT_MS", "60000")) / 1000
    while True:
        if not select.select([srv], [], [], idle)[0]:
            if os.environ.get("AGENT_BROWSER_FAKE_LINGER") == "1":
                srv.close(); time.sleep(600)  # idle-expired yet the process lingers (rig309 empty host scope)
            os._exit(0)  # idle timeout: files stay behind, stale
        conn, _ = srv.accept(); data = b""
        while not data.endswith(b"\n"):
            part = conn.recv(4096)
            if not part: break
            data += part
        if not data: conn.close(); continue
        request = json.loads(data)
        if request.get("action") == "close":
            conn.sendall(b'{"success":true,"data":{"closed":true}}\n'); conn.close(); os._exit(0)
        if request.get("action") == "wait":
            # 0.38.1 runs a command under the lock idle shutdown and close need: nothing else is served meanwhile.
            time.sleep(request["ms"] / 1000)
        conn.sendall((json.dumps({"success": True, "data": {"url": request.get("url"), "pid": os.getpid()}}) + "\n").encode()); conn.close()
args = sys.argv[1:]
if args[:2] == ["--json", "open"]:
    if not ready():  # 0.38.1: socket connectivity is the sole liveness check
        subprocess.Popen([sys.argv[0]], env={**os.environ, "AGENT_BROWSER_DAEMON": "1"}, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if ready(): break
            time.sleep(0.05)
    print(json.dumps(ask({"action": "navigate", "url": args[2]})))
elif args[:2] == ["--json", "wait"]:
    print(json.dumps(ask({"action": "wait", "ms": int(args[2])})))
elif args == ["--json", "get", "cdp-url"]:
    # rig581: answered from the session file even when nothing runs.
    print(json.dumps({"success": True, "data": {"cdpUrl": open(cdp_path).read()}}))
else:
    sys.exit(2)
'''

STEP = r'''
import ctypes, importlib.util, os, subprocess, sys
spec = importlib.util.spec_from_file_location("step", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
mode, home, session, fake = sys.argv[2:6]
m.BROWSER_BINARY = fake
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
def sandbox_exit(code):
    sys.stdout.flush(); m.kill_descendants(); os._exit(code)
try:
    if mode == "host":
        sandbox_exit(m.run_session_host(home, session, dict(os.environ), binary=fake, ended=lambda r: print("ended " + r, file=sys.stderr, flush=True)))
    if mode == "host-probe":
        # The socket table is unreadable: the host falls back to a bounded connect probe every second.
        # Probes every 2.5 s: a probe is a connection, and the fake daemon's 1.5 s idle restarts on each one.
        sandbox_exit(m.run_session_host(home, session, dict(os.environ), binary=fake, listening=lambda h, s: None, probe_every=2.5, ended=lambda r: print("ended " + r, file=sys.stderr, flush=True)))
    if mode == "launcher":
        # The root launcher of an MCP command: the framed pump in front of stdin and a sandbox child, both armed to die with it.
        import json, time
        pump = m.start_pump(None, lambda: None, framed=True)
        launcher = os.getpid()
        child = os.fork()
        if child == 0:
            m.arm_death_signal(launcher); time.sleep(600); os._exit(0)
        print(json.dumps({"pump": pump, "sandbox": child}), flush=True); time.sleep(600)
    if mode == "launcher-reaper":
        # The root launcher of any command with its reaper. The sandbox child carries NO death signal (what the
        # AppArmor transition into murage-browser-bwrap does to it): it must still die with the launcher, through the leaf.
        import json, time
        launcher = os.getpid()
        class Tree(m.SandboxCgroup):
            # No cgroupfs here: the leaf's members are this tree's processes, the launcher and the reaper excepted;
            # a kernel without cgroup.kill whose freezer answers (cgroup.events frozen) is emulated.
            freeze = "0"
            def _write(self, name, text):
                if name != "cgroup.freeze": return False
                self.freeze = text; return True
            def _read(self, name): return "populated %d\nfrozen %d\n" % (any(m.pid_alive(p) for p in self.procs()), self.freeze == "1") if name == "cgroup.events" else None
            def procs(self):
                out = []
                for name in os.listdir("/proc"):
                    if not name.isdigit() or int(name) in (os.getpid(), launcher): continue
                    try:
                        with open("/proc/%s/cmdline" % name, "rb") as stream:
                            if home.encode() in stream.read(): out.append(int(name))
                    except OSError: pass
                return out
        os.makedirs(home + "/leaf", exist_ok=True)
        reaper = m.start_reaper(Tree(home + "/leaf"))
        child = os.fork()
        if child == 0:
            os.close(reaper[1])  # as join()'s close_except does: only the launcher holds the reaper's pipe
            time.sleep(600); os._exit(0)
        print(json.dumps({"reaper": reaper[0], "sandbox": child}), flush=True); time.sleep(600)
    if mode == "mcp-rogue":
        # A long-lived command sandbox (the MCP server's shape) whose client starts a daemon of its own under its own
        # socket directory, then keeps the sandbox alive: only the launch's supervisor (idle, cap) can end them.
        import subprocess, time
        r = subprocess.run([fake, "--json", "open", "about:blank"], env={**os.environ, "AGENT_BROWSER_SOCKET_DIR": sys.argv[6]}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        print("up" if r.returncode == 0 else "down", flush=True); time.sleep(600); os._exit(0)
    if mode == "command-rogue":
        # A one-shot command whose client starts a daemon of its own, in a socket directory of its own (agent-browser
        # honours AGENT_BROWSER_SOCKET_DIR), and whose sandbox teardown does not reach it (the daemon left with setsid;
        # RA-08: bwrap's pid namespace did not end the tree on a real home). Only the leaf can end it.
        import subprocess
        r = subprocess.run([fake, "--json", "open", "about:blank"], env={**os.environ, "AGENT_BROWSER_SOCKET_DIR": sys.argv[6]}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        sys.stdout.write(r.stdout.decode()); sys.stdout.flush(); os._exit(r.returncode)
    if mode == "host-locked":
        # The root launcher's part (6.2): the live lock, held while the host runs.
        try: live = m.hold_host_live(sys.argv[6], "bot-1", session, owner=os.getuid())
        except m.BrowserSessionDown: print("failed"); sandbox_exit(1)
        sandbox_exit(m.run_session_host(home, session, dict(os.environ), binary=fake))
    if mode == "wait-unguarded":
        r = subprocess.run([fake, "--json", "wait", sys.argv[6]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL); sandbox_exit(r.returncode)
    if mode in ("open", "cdp-url"):
        m.require_session(home, session)
    if mode in ("open", "open-unguarded"):
        r = subprocess.run([fake, "--json", "open", sys.argv[6]], stdout=subprocess.PIPE); sys.stdout.write(r.stdout.decode()); sandbox_exit(r.returncode)
    if mode in ("cdp-url", "cdp-url-unguarded"):
        r = subprocess.run([fake, "--json", "get", "cdp-url"], stdout=subprocess.PIPE); sys.stdout.write(r.stdout.decode()); sandbox_exit(r.returncode)
    if mode == "relay":
        sandbox_exit(m.run_relay("cdp", check=lambda: m.require_session(home, session)))
    if mode == "close":
        m.browser_close(home, session); sandbox_exit(0)
except m.BrowserSessionDown as error:
    print(str(error), file=sys.stderr); sandbox_exit(m.BROWSER_SESSION_DOWN)
sandbox_exit(3)
'''

def setup(idle_ms=60000, **extra):
    base = tempfile.mkdtemp(prefix="session-host-")
    home = base + "/home"; os.makedirs(home + "/sockets", mode=0o700)
    fake = base + "/agent-browser"
    with open(fake, "w") as stream: stream.write(FAKE)
    os.chmod(fake, 0o755)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "AGENT_BROWSER_SOCKET_DIR": home + "/sockets", "AGENT_BROWSER_SESSION": "guest-ui-canary", "AGENT_BROWSER_IDLE_TIMEOUT_MS": str(idle_ms), **extra}
    return base, home, fake, env

def step(mode, home, fake, env, *extra, stdin=None):
    return subprocess.run([sys.executable, "-I", "-c", STEP, LAUNCHER, mode, home, "guest-ui-canary", fake, *extra], env=env, input=stdin, capture_output=True, timeout=30)

def leftovers(base):
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid(): continue
        try:
            with open("/proc/%s/cmdline" % name, "rb") as stream: cmd = stream.read()
            with open("/proc/%s/stat" % name) as stream: state = stream.read().rsplit(")", 1)[1].split()[0]
        except OSError: continue
        if base.encode() in cmd and state != "Z": found.append(cmd.replace(b"\0", b" ").decode(errors="replace"))
    return found

def ppid(pid):
    with open("/proc/%d/stat" % pid) as stream: return int(stream.read().rsplit(")", 1)[1].split()[1])

def check(condition, label):
    if not condition: raise AssertionError(label)

def wait_gone(proc, seconds):
    try: return proc.wait(seconds)
    except subprocess.TimeoutExpired: return None

class LiveSandbox(m.SandboxCgroup):
    """The fixture's stand-in for a launch's sandbox cgroup leaf, with no
    cgroupfs: its members are every process of this test tree (the base in its
    command line) except this process (the launcher) and `outside`, exactly
    what the leaf holds on a home. cgroup.kill is absent here and the freezer
    answers (cgroup.events frozen follows cgroup.freeze), so the launcher's real
    fallback (freeze, await frozen, list, SIGKILL, thaw, wait) runs against real processes."""
    def __init__(self, base, outside=()):
        super().__init__(base + "/sandbox-cgroup"); os.makedirs(self.path, exist_ok=True)
        self.base, self.outside, self.freeze = base, set(outside), "0"
    def _write(self, name, text):
        if name != "cgroup.freeze": return False
        self.freeze = text; return True
    def _read(self, name): return "populated %d\nfrozen %d\n" % (any(m.pid_alive(p) for p in self.procs()), self.freeze == "1") if name == "cgroup.events" else None
    def procs(self): return [pid for pid in tree_pids(self.base) if pid not in self.outside and pid != os.getpid()]

class FakeKernel(m.SandboxCgroup):
    """A leaf without cgroup.kill on a kernel whose freezer is `honest` (frozen
    follows cgroup.freeze, asynchronously: only after `delay` reads) or never
    freezes; `members` are real pids. Records whether every listing was read frozen."""
    def __init__(self, path, members, honest=True, delay=2, freezer=True):
        super().__init__(path); os.makedirs(path, exist_ok=True)
        self.members, self.honest, self.delay, self.freezer, self.freeze, self.pending, self.reads = list(members), honest, delay, freezer, "0", 0, []
    def _write(self, name, text):
        if name != "cgroup.freeze" or not self.freezer: return False
        self.freeze, self.pending = text, self.delay; return True
    def frozen_now(self):
        if self.freeze != "1" or not self.honest: return False
        if self.pending: self.pending -= 1; return False
        return True
    def _read(self, name): return "populated %d\nfrozen %d\n" % (any(m.pid_alive(p) for p in self.members), self.frozen_now()) if name == "cgroup.events" else None
    def procs(self): self.reads.append(self.freeze == "1" and self.honest and not self.pending); return list(self.members)

def fake_leaf(base, name, procs=(), kill=True, events=True, freeze=True):
    """A leaf on a fake cgroupfs: the files a kernel offers (cgroup.kill since 5.14, cgroup.freeze since 5.2)."""
    path = base + "/" + name; os.makedirs(path)
    with open(path + "/cgroup.procs", "w") as stream: stream.write("".join("%d\n" % pid for pid in procs))
    if kill: open(path + "/cgroup.kill", "w").close()
    if freeze: open(path + "/cgroup.freeze", "w").close()
    if events:
        with open(path + "/cgroup.events", "w") as stream: stream.write("populated %d\nfrozen 0\n" % (1 if procs else 0))
    return m.SandboxCgroup(path)

def three_invocations():
    base, home, fake, env = setup()
    host = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "host", home, "guest-ui-canary", fake], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        check(select.select([host.stdout], [], [], 20)[0] and host.stdout.readline() == b"ready\n", "host ready")
        daemon = m.session_pid(home, "guest-ui-canary")
        check(daemon is not None and m.pid_alive(daemon), "daemon alive after host ready")
        check(ppid(daemon) == host.pid, "the host (subreaper) owns the daemon, not a command")
        # 1: open, its own invocation; the sandbox teardown at its end must not touch the daemon.
        r = step("open", home, fake, env, "https://example.com/")
        check(r.returncode == 0 and json.loads(r.stdout)["data"]["pid"] == daemon, "open served by the host daemon: %r" % (r.stderr,))
        check(m.pid_alive(daemon) and m.session_alive(home, "guest-ui-canary"), "daemon alive after open")
        # 2: get cdp-url, its own invocation.
        r = step("cdp-url", home, fake, env)
        url = json.loads(r.stdout)["data"]["cdpUrl"]
        check(r.returncode == 0 and url.startswith("ws://127.0.0.1:"), "cdp-url")
        check(m.pid_alive(daemon), "daemon alive after cdp-url")
        # 3: relay cdp, its own invocation: bytes reach the browser endpoint and come back.
        relay = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "relay", home, "guest-ui-canary", fake], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        relay.stdin.write(b"GET /devtools/browser/fake HTTP/1.1\r\n"); relay.stdin.flush()
        echoed = b""
        while len(echoed) < 38 and select.select([relay.stdout], [], [], 10)[0]:
            part = os.read(relay.stdout.fileno(), 4096)
            if not part: break
            echoed += part
        relay.stdin.close(); relay.wait(10)
        check(echoed == b"GET /devtools/browser/fake HTTP/1.1\r\n", "relay echo %r %r" % (echoed, relay.stderr.read()))
        check(relay.returncode == 0 and m.pid_alive(daemon), "daemon alive after relay")
        # close: the daemon exits, the host follows and leaves nothing (the fake Chrome included).
        r = step("close", home, fake, env)
        check(r.returncode == 0, "close")
        check(wait_gone(host, 10) == 0, "host exits with its daemon")
        time.sleep(0.2)
        check(leftovers(base) == [], "no process left: %r" % leftovers(base))
        # The stale files are still there, and neither cdp-url nor relay trusts them.
        check(os.path.exists(home + "/sockets/guest-ui-canary.sock") and m.session_pid(home, "guest-ui-canary") == daemon, "stale files stay")
        stale = step("cdp-url-unguarded", home, fake, env)
        check(stale.returncode == 0 and b"ws://127.0.0.1:" in stale.stdout, "the CLI alone answers from stale files (rig581)")
        r = step("cdp-url", home, fake, env)
        check(r.returncode == 77 and r.stdout == b"" and r.stderr == b"Cloud browser session is not running\n", "cdp-url refuses a dead session: %r" % (r.stderr,))
        r = step("relay", home, fake, env, stdin=b"x")
        check(r.returncode == 77 and r.stdout == b"" and r.stderr == b"Cloud browser session is not running\n", "relay refuses a dead session")
        r = step("open", home, fake, env, "https://example.com/")
        check(r.returncode == 77 and r.stderr == b"Cloud browser session is not running\n", "a guarded open never forks a doomed daemon")
        check(leftovers(base) == [], "still nothing left")
    finally:
        if host.poll() is None: host.kill(); host.wait()

def old_path_and_expiry():
    # Control: the pre-fix shape, open run straight in a per-command sandbox. Its
    # daemon dies with the sandbox and the stale files answer cdp-url.
    base, home, fake, env = setup()
    r = step("open-unguarded", home, fake, env, "about:blank")
    check(r.returncode == 0, "old open succeeds")
    daemon = m.session_pid(home, "guest-ui-canary")
    time.sleep(0.2)
    check(daemon is not None and not m.pid_alive(daemon) and not m.session_alive(home, "guest-ui-canary"), "old path: daemon died with the command")
    check(step("cdp-url-unguarded", home, fake, env).returncode == 0, "old path: stale URL")
    check(step("cdp-url", home, fake, env).returncode == 77, "fixed path refuses it")
    check(leftovers(base) == [], "old path leftovers")
    # Session expiry: the daemon's idle timeout ends it; the host follows and reaps the fake Chrome.
    base, home, fake, env = setup(idle_ms=1500)
    host = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "host", home, "guest-ui-canary", fake], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        check(host.stdout.readline() == b"ready\n", "expiry host ready")
        check(leftovers(base) != [], "daemon and fake Chrome run")
        check(wait_gone(host, 15) == 0, "host ends at the daemon's idle timeout")
        time.sleep(0.2)
        check(leftovers(base) == [], "nothing left after expiry: %r" % leftovers(base))
    finally:
        if host.poll() is None: host.kill(); host.wait()
    # A warm-up that fails reports "failed" and leaves nothing.
    base, home, fake, env = setup()
    with open(fake, "w") as stream: stream.write("#!/bin/sh\nexit 1\n")
    r = step("host", home, fake, env)
    check(r.returncode == 1 and r.stdout == b"failed\n", "failed warm-up reported")

def ensure_host():
    root = tempfile.mkdtemp(prefix="browser-root-")
    request = {"mode": "browser", "bot": "bot-1", "instance": "i" * 22, "args": ["--json", "open", "about:blank"], "settings": {"AGENT_BROWSER_SESSION": "s1"}}
    calls = []
    def spawn(req, lock):
        # The cleanup lock is held across the spawn (as in the pre-scope window).
        probe = os.open(root + "/.lock-bot-1", os.O_RDWR)
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB); held = False
        except BlockingIOError:
            held = True
        finally:
            os.close(probe)
        calls.append(("spawn", held, req["bot"])); return lambda wait: calls.append(("ready", wait)) or True
    state = {"alive": False}
    alive = lambda home, session: state["alive"]
    fence = lambda req: calls.append(("fence", req["instance"]))
    # Live daemon: reused, nothing spawned, no fence needed.
    state["alive"] = True
    m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn, owner=os.getuid(), fence=fence, live=lambda: state["alive"])
    check(calls == [], "live session reused")
    # Dead: fenced, spawned under the cleanup lock, then ready.
    state["alive"] = False
    def spawn_then_up(req, lock):
        ready = spawn(req, lock); state["alive"] = True; return ready
    m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn_then_up, wait=3, owner=os.getuid(), fence=fence, live=lambda: state["alive"])
    check(calls == [("fence", "i" * 22), ("spawn", True, "bot-1"), ("ready", 3)], "spawn path %r" % calls)
    # A host that never comes up is a clear, fixed refusal.
    state["alive"] = False; calls.clear()
    try:
        m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn, wait=1, owner=os.getuid(), fence=fence, live=lambda: state["alive"]); check(False, "must refuse")
    except m.BrowserSessionDown as error:
        check(str(error) == "Cloud browser session did not start", "did not start text")
    # A stale server or a pending cleanup spawns nothing.
    calls.clear()
    def stale(req): raise m.StaleServerInstance()
    try: m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn, owner=os.getuid(), fence=stale, live=lambda: state["alive"]); check(False, "stale must refuse")
    except m.StaleServerInstance: pass
    os.mkdir(root + "/.cleanup-bot-1")
    try: m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn, owner=os.getuid(), fence=fence, live=lambda: state["alive"]); check(False, "pending must refuse")
    except ValueError: pass
    check(calls == [], "nothing spawned when refused")
    # Hosts serialize on their own lock, never the cleanup lock.
    gate = m.browser_lock(root, "bot-1", owner=os.getuid(), kind="host")
    try:
        m.ensure_session_host(request, "/h", root=root, alive=alive, spawn=spawn, wait=0.2, owner=os.getuid(), fence=fence, live=lambda: state["alive"]); check(False, "gate must hold")
    except m.BrowserLockBusy: pass
    finally: os.close(gate)
    try: m.browser_lock(root, "bot-1", owner=os.getuid(), kind="../x"); check(False, "kind")
    except ValueError: pass

def spawn_host():
    root = tempfile.mkdtemp(prefix="browser-root-")
    lock = m.browser_lock(root, "bot-1", owner=os.getuid())
    lock_inode = os.fstat(lock).st_ino
    report = root + "/report.json"
    request = {"mode": "browser", "bot": "bot-1", "instance": "i" * 22, "args": ["--json", "open", "about:blank"], "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "a" * 64}}
    def enter(payload, plan):
        fds = sorted(int(n) for n in os.listdir("/proc/self/fd"))
        with open(report, "w") as stream:
            json.dump({"payload": json.loads(payload), "plan": list(plan[:2]), "lock": os.fstat(m.BROWSER_LOCK_FD).st_ino, "stdin": os.readlink("/proc/self/fd/0"),
                       "stderr": os.readlink("/proc/self/fd/2"), "sid": os.getsid(0), "fds": fds}, stream)
        os.write(1, b"ready\n")
    ready = m.spawn_session_host(request, lock, enter=enter)
    os.close(lock)
    check(ready(5) is True, "ready line")
    seen = json.load(open(report))
    check(seen["payload"] == {"mode": "browser-host", "bot": "bot-1", "args": m.HOST_WARMUP, "settings": request["settings"], "instance": "i" * 22}, "host request")
    check(seen["plan"][1] == m.BROWSER_SLICE and m.in_scope((seen["plan"][0], m.BROWSER_SLICE, []), cgroup=write_cgroup(root, seen["plan"][0])), "browser scope, cleanup-visible name")
    check(seen["lock"] == lock_inode and seen["stdin"] == "/dev/null" and seen["stderr"] == "/dev/null" and seen["sid"] != os.getsid(0), "lock rides along, stdio detached, own session")
    check([fd for fd in seen["fds"] if fd > 2 and fd != m.BROWSER_LOCK_FD] in ([], [3]), "no other descriptor leaks into the host: %r" % seen["fds"])
    # An enter that dies before writing is not ready.
    def broken(payload, plan): raise OSError("no systemd-run")
    check(m.spawn_session_host(request, os.open(os.devnull, os.O_RDONLY), enter=broken)(5) is False, "failed spawn")

def write_cgroup(root, unit):
    path = root + "/cgroup"
    with open(path, "w") as stream: stream.write("0::/murage.slice/murage-browsers.slice/" + unit + "\n")
    return path

def contract():
    host = {"mode": "browser-host", "bot": "bot-1", "args": m.HOST_WARMUP, "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "a" * 64}}
    plan = m.validate_browser_request(host)
    check(plan["args"] == m.HOST_WARMUP and plan["env"]["AGENT_BROWSER_SOCKET_DIR"] == "/data/browser/bot-1/sockets", "host plan")
    for args in (["mcp", "--tools", "core", "--no-webmcp"], ["--json", "open", "https://example.com/"], ["--version"]):
        try: m.validate_browser_request({**host, "args": args}); check(False, "host args %r" % args)
        except ValueError: pass
    unit, slice_name, properties = m.scope_plan(host)
    import re
    check(re.fullmatch(r"murage-browser-bot-1\.[0-9a-f]{8}\.scope", unit) and slice_name == m.BROWSER_SLICE and properties == m.HOST_SCOPE_PROPERTIES, "host scope")
    # 6.1: systemd caps the host's scope too (cap + a minute, so the host's own end comes first); one-shot commands stay uncapped.
    check(m.scope_runtime_max(properties) == m.HOST_RUNTIME_MAX_SEC + 60 and properties[:-1] == m.BROWSER_SCOPE_PROPERTIES, "host scope runtime cap")
    check(m.scope_plan({**host, "mode": "browser", "args": ["--version"]})[2] == m.BROWSER_SCOPE_PROPERTIES and m.scope_runtime_max(m.BROWSER_SCOPE_PROPERTIES) is None, "command scope uncapped")
    argv = m.browser_mount_args([("/fixture/anchor", "/data/browser/bot-1")], "/data/browser/bot-1", m.HOST_WARMUP, host=True)
    check(argv[0] == m.BROWSER_BWRAP and "--browser-host" in argv and "--browser-child" not in argv, "host bwrap entry")
    for flag in ("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session"):
        check(flag in argv, "host keeps " + flag)
    for flag in ("--share-net", "--unshare-net", "--unshare-all"):
        check(flag not in argv, "host never changes the joined bot netns: " + flag)
    for args in (["--json", "get", "cdp-url"], ["mcp", "--tools", "core", "--no-webmcp"], ["relay", "cdp"], ["--json", "open", "about:blank"]):
        command = m.browser_mount_args([("/fixture/anchor", "/data/browser/bot-1")], "/data/browser/bot-1", args, sockets="/run/murage-turn/1")
        check("--browser-child" in command and command[:command.index("--symlink")] == argv[:argv.index("--symlink")], "same sandbox as every command")
        # 6.2 structurally: every command, the MCP server included, sees the socket directory read-only (stacked
        # after the writable home bind), so only the host's sandbox can bind the daemon's socket.
        i = command.index("--ro-bind", command.index("--symlink"))
        check(command[i:i + 3] == ["--ro-bind", "/run/murage-turn/1", "/data/browser/bot-1/sockets"] and command.index("--bind") < i, "command socket dir read-only: %r" % args)
        try: m.browser_mount_args([("/fixture/anchor", "/data/browser/bot-1")], "/data/browser/bot-1", args); check(False, "a command needs its pinned session directory")
        except ValueError: pass
    check(not any(argv[i] == "--ro-bind" and argv[i + 2].startswith("/data/browser") for i in range(len(argv) - 2)) and "/run/murage-host" not in " ".join(argv), "the host's sandbox: writable sockets, no clock mount")
    # r3: the home's ancestors cannot be renamed or recreated. /data is its own tmpfs (a mount point: EBUSY), remounted
    # read-only after the home is bound into it (/data/browser: EROFS), in the host's sandbox and every command's alike.
    for command in [argv] + [m.browser_mount_args([("/fixture/anchor", "/data/browser/bot-1")], "/data/browser/bot-1", args, sockets="/run/murage-turn/1") for args in (["mcp", "--tools", "core", "--no-webmcp"], ["--json", "open", "about:blank"])]:
        t, b, r = command.index("--tmpfs"), command.index("--bind"), command.index("--remount-ro")
        check(command[t:t + 2] == ["--tmpfs", "/data"] and command[r:r + 2] == ["--remount-ro", "/data"] and t < b < r < command.index("--symlink"), "ancestors locked: %r" % command[t:r + 2])
        check(command.count("--tmpfs") == 1 and command.count("--remount-ro") == 1 and command[b + 2] == "/data/browser/bot-1", "one tmpfs, one remount, the home inside it")
    source = open(LAUNCHER).read()
    check("HOST_ACTIVITY_MOUNT" not in source and "wait = lambda child: supervise_session_host(child, home, session, activity, sandbox, end=end_session if host else end_command)" in source
          and "namespace.join(request[\"bot\"], prepare, account, plan[\"env\"], validate, wait=wait, enter=sandbox.enter)" in source and "activity = open_host_activity(root, bot, session)" in source, "supervisor wiring")
    check(source.index("live = hold_host_live(root, bot, session)") < source.index("activity = open_host_activity(root, bot, session)") < source.index("def prepare(resolver):"), "lock and clock are opened before the sandbox")
    # r4: every launch is supervised on the one clock (the wait is set for host and command alike, before the pump), and
    # no command stamps the clock by a bare touch any more: opening it is the launch's stamp.
    check(source.index("    activity = open_host_activity(root, bot, session)\n    wait = lambda child:") < source.index("pump = start_pump(") and "touch_host_activity(root, bot, session)  # every command" not in source, "one supervisor for every launch")
    check("open_directory(sockets)" in source and "os.chown(sockets, account.pw_uid, account.pw_gid)" in source, "the session directory is root-pinned and root-created")
    # r3: one sandbox cgroup leaf per launch, created by root before the sandbox, entered by the child before its uid drop,
    # killed as a whole at the command's end (the launcher) and at the launcher's death (the reaper); no pid listing is ever signalled.
    check("sandbox = SandboxCgroup.create()" in source and source.index("sandbox = SandboxCgroup.create()") < source.index("def prepare(resolver):"), "the leaf exists before the sandbox")
    check(source.index("reaper = start_reaper(sandbox)") < source.index("status = namespace.join(request[\"bot\"]") < source.index("        sandbox.kill()\n        if reaper is not None:\n            stop_reaper(reaper)\n        sandbox.remove()"), "reaper before the sandbox, leaf killed at the command's end, then the reaper released")
    check(source.index("pump = start_pump(") < source.index("reaper = start_reaper(sandbox)"), "the pump never inherits the reaper's pipe")
    check("scope_procs" not in source and "cgroup.kill" in source and "cgroup.freeze" in source and "Delegate=yes" in m.BROWSER_SCOPE_PROPERTIES and "Delegate=yes" in m.HOST_SCOPE_PROPERTIES, "group kill, delegated scope, no pid snapshot")
    helper = open(os.path.dirname(LAUNCHER) + "/murage-browser-namespace.py").read()
    check(helper.index("                if enter is not None: enter()\n") < helper.index("os.setgroups([sandbox_gid]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)"), "the child enters the leaf as root, before its uid drop")
    # H1: MCP scopes are capped like hosts; MCP, open and every session client need a live host.
    mcp = ["mcp", "--tools", "core", "--no-webmcp"]
    check(m.scope_plan({**host, "mode": "browser", "args": mcp})[2] == m.HOST_SCOPE_PROPERTIES, "mcp scope capped")
    check(all(m.requires_host(a) for a in [mcp, ["--json", "open", "about:blank"]] + list(m.SESSION_CLIENT_ARGS)) and not m.requires_host(["--version"]), "requires_host")
    source = open(LAUNCHER).read()
    check('request.get("mode") == "browser-host":\n        # Only a root launch' in source, "FD3 cannot ask for a host")
    check(m.SESSION_CLIENT_ARGS == (["--json", "get", "cdp-url"], ["--json", "stream", "status"], ["relay", "cdp"], ["relay", "stream"]), "guarded commands")
    # run_relay names the failing step with fixed words.
    import io, contextlib
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        def lookup(kind): raise ValueError("Relay endpoint lookup failed")
        code = m.run_relay("cdp", discover=lookup)
    check(code == 1 and err.getvalue() == "Cloud browser relay could not reach its endpoint (endpoint lookup failed)\n", "relay text %r" % err.getvalue())
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        def refused(address, timeout): raise ConnectionRefusedError()
        code = m.run_relay("cdp", discover=lambda kind: 9, connect=refused)
    check(code == 1 and err.getvalue() == "Cloud browser relay could not reach its endpoint (connect refused)\n", "relay connect text")
    # session_alive never follows a link out of the profile.
    base = tempfile.mkdtemp(prefix="session-link-")
    os.makedirs(base + "/real"); os.makedirs(base + "/home")
    srv = socket.socket(socket.AF_UNIX); srv.bind(base + "/real/s1.sock"); srv.listen(1)
    open(base + "/real/s1.pid", "w").write("123")
    os.symlink(base + "/real", base + "/home/sockets")
    check(not m.session_alive(base + "/home", "s1") and m.session_pid(base + "/home", "s1") is None, "symlinked sockets dir refused")
    os.unlink(base + "/home/sockets"); os.makedirs(base + "/home/sockets")
    os.symlink(base + "/real/s1.sock", base + "/home/sockets/s1.sock")
    check(not m.session_alive(base + "/home", "s1"), "symlinked socket refused")
    check(m.session_alive(base + "/nope", "s1") is False and m.session_pid(base + "/nope", "s1") is None, "missing dir")
    srv.close()

def start_host(home, fake, env, mode="host", *extra):
    host = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, mode, home, "guest-ui-canary", fake, *extra], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    check(select.select([host.stdout], [], [], 20)[0] and host.stdout.readline() == b"ready\n", "%s ready" % mode)
    return host

def chromes(base):
    return [cmd for cmd in leftovers(base) if cmd.strip().endswith(base + "/home/sockets/fake-chrome")]

def finish(host, base, seconds, label):
    code = wait_gone(host, seconds)
    err = host.stderr.read().decode()
    check(code == 0, "%s: host exits (%r)" % (label, code))
    time.sleep(0.2)
    check(leftovers(base) == [], "%s: nothing left: %r" % (label, leftovers(base)))
    return err

def tree_pids(base):
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid(): continue
        try:
            with open("/proc/%s/cmdline" % name, "rb") as stream:
                if base.encode() in stream.read(): found.append(int(name))
        except OSError: pass
    return found

def supervise(host, base, home, activity_fd, idle=300, cap=3600, poll=30, activity="none", t0=None, real=0.02, act=None, **extra):
    """The root launcher's part (6.1), in this process as the host's parent: the real
    supervisor with fake timers (every poll advances the clock by `poll` seconds in
    `real` seconds of real time). The real kill runs against the fixture's leaf
    (LiveSandbox): the child and everything the sandbox left (fake Chrome)."""
    t0 = time.time() if t0 is None else t0; now = [t0]
    def sleep(seconds): now[0] += seconds; time.sleep(real)
    clock = lambda: now[0]
    variants = {"none": lambda fd: None, "always": lambda fd: now[0], "future": lambda fd: now[0] + 10000, "until600": lambda fd: now[0] if now[0] - t0 <= 600 else None, "trusted": m.host_activity}
    seen = []
    status = m.supervise_session_host(host.pid, home, "guest-ui-canary", activity_fd, LiveSandbox(base), idle=idle, max_runtime=cap, poll=poll, clock=clock, monotonic=clock, sleep=sleep,
                                      activity=act or variants[activity], ended=lambda r: seen.append(r), **extra)
    host.returncode = status
    time.sleep(0.2)
    check(leftovers(base) == [], "%s: nothing left after the supervisor: %r" % (activity, leftovers(base)))
    return seen[0], int(now[0] - t0), status

def idle_and_cap():
    # rig309 shape (6.1). Control: a long command holds the daemon, so its own
    # 1.5 s idle timeout never fires; a host with no clock of its own would wait forever.
    base, home, fake, env = setup(idle_ms=1500)
    host = start_host(home, fake, env)
    try:
        waiter = subprocess.Popen([fake, "--json", "wait", "8000"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(4)
        daemon = m.session_pid(home, "guest-ui-canary")
        check(m.pid_alive(daemon) and host.poll() is None, "control: a running command defeats the daemon's idle expiry")
        waiter.kill(); waiter.wait()
    finally:
        host.kill(); host.wait(); kill_tree(base)
    # The root supervisor, fake timers: no activity while a 600 s wait runs -> the session ends at the idle limit.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    waiter = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "wait-unguarded", home, "guest-ui-canary", fake, "600000"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    reason, at, status = supervise(host, base, home, -1, activity="none", real=0.3)
    check(reason == "idle" and 300 <= at <= 330 and os.WIFSIGNALED(status), "ended at the idle limit: %r %r" % (reason, at))
    check(waiter.wait(10) != 0, "the long command ends with the session")
    check(not m.session_alive(home, "guest-ui-canary"), "socket gone")
    # Real activity resets idle: activity until fake 600 s -> the end comes 300 s after the last activity, not before.
    base, home, fake, env = setup()
    reason, at, _ = supervise(start_host(home, fake, env), base, home, -1, activity="until600")
    check(reason == "idle" and 900 <= at <= 930, "idle counted from the last activity: %r %r" % (reason, at))
    # A stamp from the future is not activity.
    base, home, fake, env = setup()
    reason, at, _ = supervise(start_host(home, fake, env), base, home, -1, activity="future")
    check(reason == "idle" and at <= 330, "future stamp ignored: %r %r" % (reason, at))
    # Activity never stops and a command runs past the cap: the hard cap ends it anyway.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    waiter = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "wait-unguarded", home, "guest-ui-canary", fake, "86400000"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    reason, at, _ = supervise(host, base, home, -1, activity="always", poll=60, real=0.1)
    check(reason == "cap" and 3600 <= at <= 3660, "ended at the cap: %r %r" % (reason, at))
    check(waiter.wait(10) != 0, "the 24 h command ends at the cap")
    # The sandbox ending by itself (close) returns its status with no kill and no delay.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    import threading
    threading.Timer(0.5, lambda: step("close", home, fake, env)).start()
    reason, at, status = supervise(host, base, home, -1, activity="always", poll=0.01, real=0.05)
    check(reason == "sandbox" and status == 0 and at < 300, "the host's own exit ends the supervisor: %r %r" % (reason, at))
    # Graceful first: at idle the daemon gets one bounded close (it answers and exits), then the kill reaps the rest.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    closes = []
    def end(home_, session, kill):
        m.end_session(home_, session, kill=lambda: closes.append(kill()), close=lambda h, s, timeout: closes.append(("close", timeout)) or m.browser_close(h, s, timeout))
    seen = []
    status = m.supervise_session_host(host.pid, home, "guest-ui-canary", -1, LiveSandbox(base), idle=1, max_runtime=10, poll=1, clock=time.time, monotonic=time.monotonic, sleep=time.sleep,
                                      activity=lambda fd: None, end=end, ended=lambda r: seen.append(r))
    host.returncode = status
    check(seen == ["idle"] and closes[0] == ("close", m.HOST_CLOSE_WAIT) and len(closes) == 2, "close then kill: %r" % closes)
    time.sleep(0.2)
    check(leftovers(base) == [], "nothing left after close+kill")

def host_exits():
    # 6.3: the daemon idle-expires but its process lingers (listener closed): the host ends with it, nothing left.
    base, home, fake, env = setup(idle_ms=1500, AGENT_BROWSER_FAKE_LINGER="1")
    host = start_host(home, fake, env)
    daemon = m.session_pid(home, "guest-ui-canary")
    check(m.daemon_listening(home, "guest-ui-canary") is True, "listener seen without connecting")
    err = finish(host, base, 15, "linger")
    check(err == "ended daemon\n" and not m.pid_alive(daemon), "host ended with its daemon: %r" % err)
    check(m.daemon_listening(home, "guest-ui-canary") is False, "no listener")
    # The daemon replaced under the host (its pid file names another process): the host does not keep a scope for it.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    with open(home + "/sockets/guest-ui-canary.pid", "w") as stream: stream.write(str(os.getpid()))
    err = finish(host, base, 10, "replaced")
    check(err == "ended daemon\n", "replaced daemon: %r" % err)
    # An unreadable table is unknown, never "gone" by itself ...
    check(m.daemon_listening(home, "guest-ui-canary", table=base + "/missing") is None, "unknown listener state")
    # ... so the host falls back to a bounded connect probe (real time here): a lingering idle-expired daemon still ends it (Low).
    base, home, fake, env = setup(idle_ms=1500, AGENT_BROWSER_FAKE_LINGER="1")
    host = start_host(home, fake, env, "host-probe")
    err = finish(host, base, 20, "probe")
    check(err == "ended daemon\n", "probe fallback: %r" % err)

def kill_tree(base):
    for pid in [int(n) for n in os.listdir("/proc") if n.isdigit() and int(n) != os.getpid()]:
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as stream:
                if base.encode() in stream.read(): os.kill(pid, signal.SIGKILL)
        except OSError: pass

def single_start():
    # 6.2: concurrent start attempts produce exactly one daemon (one Chrome). The
    # guard is the root launcher's live lock in the root-owned browser dir.
    base, home, fake, env = setup()
    lockroot = tempfile.mkdtemp(prefix="browser-root-")
    s = "guest-ui-canary"
    hosts = [subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "host-locked", home, s, fake, lockroot], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) for _ in range(4)]
    try:
        lines = []
        for host in hosts:
            check(select.select([host.stdout], [], [], 20)[0], "every host answers")
            lines.append(host.stdout.readline())
        check(sorted(lines) == [b"failed\n"] * 3 + [b"ready\n"], "one ready, three refused: %r" % lines)
        time.sleep(0.3)
        check(len(chromes(base)) == 1, "exactly one daemon: %r" % leftovers(base))
        winner = hosts[lines.index(b"ready\n")]
        check(all(h.wait(10) == 1 for h in hosts if h is not winner), "refused hosts exit")
        check(m.host_live(lockroot, "bot-1", s, owner=os.getuid()), "live for the host's life")
        late = step("host-locked", home, fake, env, lockroot)
        check(late.returncode == 1 and late.stdout == b"failed\n" and len(chromes(base)) == 1, "a later start while the host lives starts nothing")
        check(step("close", home, fake, env).returncode == 0 and wait_gone(winner, 10) == 0, "close ends the one host")
        time.sleep(0.2)
        check(leftovers(base) == [] and not m.host_live(lockroot, "bot-1", s, owner=os.getuid()), "live lock released with the host")
    finally:
        for host in hosts:
            if host.poll() is None: host.kill(); host.wait()
    # A daemon no host started (a client's own auto-start) is not adopted: the host refuses it.
    base, home, fake, env = setup()
    subprocess.run([fake, "--json", "open", "about:blank"], env=env, stdout=subprocess.DEVNULL, check=True)
    try:
        check(m.session_alive(home, s), "foreign daemon answers")
        r = step("host", home, fake, env)
        check(r.returncode == 1 and r.stdout == b"failed\n" and len(chromes(base)) == 1, "host refuses a daemon it cannot own")
    finally:
        m.browser_close(home, s); time.sleep(0.3); kill_tree(base)

def rogue():
    # H2: a same-bot browser process shares the writable profile, never the root
    # dir. Nothing it does in the profile holds the guard or counts as activity.
    base, home, fake, env = setup()
    root, s, me = tempfile.mkdtemp(prefix="browser-root-"), "guest-ui-canary", os.getuid()
    for name in (".host", ".live", ".active", ".lock"):
        fd = os.open(home + "/sockets/" + s + name, os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX)
    check(not m.host_live(root, "bot-1", s, owner=me), "a lock held in the profile is no host")
    live = m.hold_host_live(root, "bot-1", s, owner=me)
    check(m.host_live(root, "bot-1", s, owner=me), "the launcher's lock is")
    try: m.hold_host_live(root, "bot-1", s, owner=me, wait=0.2); check(False, "second holder")
    except m.BrowserSessionDown: pass
    os.close(live)
    check(not m.host_live(root, "bot-1", s, owner=me), "released")
    # Planted state is refused, never trusted: a link, a hard link, a writable or foreign-owned file.
    other = tempfile.mkdtemp(prefix="rogue-")
    open(other + "/x", "w").close()
    os.symlink(other + "/x", root + "/.live-bot-1.s2")
    os.link(other + "/x", root + "/.live-bot-1.s3")
    open(root + "/.live-bot-1.s4", "w").close(); os.chmod(root + "/.live-bot-1.s4", 0o666)
    for name in ("s2", "s3", "s4"):
        check(not m.host_live(root, "bot-1", name, owner=me), "planted %s is no host" % name)
        try: m.hold_host_live(root, "bot-1", name, owner=me); check(False, "planted %s held" % name)
        except (OSError, ValueError): pass
    check(not m.host_live(root, "bot-1", s, owner=me + 1), "wrong owner is no host")
    for bad in ("../x", "a/b", ""):
        try: m.trusted_session_file(root, "bot-1", bad, "live", os.O_RDONLY, me); check(False, "session name %r" % bad)
        except ValueError: pass
    # The trusted clock: root creates it and keeps a descriptor; it is read with fstat, never through a path or a mount.
    afd = m.open_host_activity(root, "bot-1", s, owner=me)
    clock = root + "/.active-bot-1." + s
    check(os.stat(clock).st_mode & 0o777 == 0o600 and abs(m.host_activity(afd) - time.time()) < 5, "trusted clock")
    m.touch_host_activity(root, "bot-1", "s2b", owner=me + 1)  # refused file: no stamp
    check(m.host_activity(-1) is None, "a lost descriptor is no activity")
    # Fake timers: the clock says fake t+200. A rogue keeps touching every profile file, and swaps the clock's PATH: it
    # renames the file away and plants a fresh one it touches forever. The supervisor reads the inode it opened: idle
    # still ends 300 s after the one real stamp.
    t0 = time.time() + 100000
    os.utime(clock, (t0 + 200, t0 + 200))
    os.rename(clock, root + "/.gone"); open(clock, "w").close()
    rogue_proc = subprocess.Popen([sys.executable, "-I", "-c", "import os, sys, time\nwhile True:\n    for p in [os.environ['ROGUE_DIR'] + '/' + n for n in os.listdir(os.environ['ROGUE_DIR'])] + [os.environ['ROGUE_CLOCK']]:\n        try: os.utime(p, (time.time() + 200000, time.time() + 200000))\n        except OSError: pass\n    time.sleep(0.01)"], env={**os.environ, "ROGUE_DIR": home + "/sockets", "ROGUE_CLOCK": clock})
    try:
        reason, at, _ = supervise(start_host(home, fake, env), base, home, afd, activity="trusted", t0=t0)
        check(reason == "idle" and 500 <= at <= 530, "only the pinned clock resets idle, a swapped path never: %r %r" % (reason, at))
        check(os.stat(clock).st_mtime > t0 + 100000, "the planted file was being touched all along")
        # A stale clock is no activity.
        base, home, fake, env = setup()
        os.utime(root + "/.gone", (t0 - 50, t0 - 50))
        reason, at, _ = supervise(start_host(home, fake, env), base, home, afd, activity="trusted", t0=t0)
        check(reason == "idle" and at <= 330, "a stale clock is no activity: %r %r" % (reason, at))
    finally:
        rogue_proc.kill(); rogue_proc.wait(); os.close(afd)
    # H1 (r2): a same-uid process stops the host's main process right after "ready" (the old in-sandbox watchdog
    # would sleep forever). The supervisor is out of its reach: the session still ends at idle, the stopped host, its
    # daemon and the fake Chrome are all killed, nothing lingers.
    base, home, fake, env = setup()
    host = start_host(home, fake, env)
    os.kill(host.pid, signal.SIGSTOP)
    time.sleep(0.2)
    with open("/proc/%d/stat" % host.pid) as stream: check(stream.read().rsplit(")", 1)[1].split()[0] == "T", "host stopped")
    daemon = m.session_pid(home, s)
    reason, at, status = supervise(host, base, home, -1, activity="none", real=0.05)
    check(reason == "idle" and 300 <= at <= 330 and os.WIFSIGNALED(status) and os.WTERMSIG(status) == 9, "a stopped host is ended by the supervisor: %r %r" % (reason, at))
    check(not m.pid_alive(daemon) and not m.session_alive(home, s), "its daemon died with it")

def sandbox_cgroup():
    # r3 H1: every launch's sandbox lives in its own cgroup leaf under the launch's scope; ending it is one operation on
    # the group. The leaf is created from the launcher's own cgroup, under a browser scope only, and nowhere else.
    base = tempfile.mkdtemp(prefix="sandbox-cgroup-")
    scope = "/murage.slice/murage-browsers.slice/murage-browser-bot-1.0a0a0a0a.scope"
    os.makedirs(base + "/sys" + scope)
    leaf = m.SandboxCgroup.create(cgroup=write_cgroup(base, "murage-browser-bot-1.0a0a0a0a.scope"), root=base + "/sys")
    check(leaf.path == base + "/sys" + scope + "/sandbox" and os.path.isdir(leaf.path) and os.listdir(base + "/sys" + scope) == ["sandbox"], "the leaf under the launch's own scope: %r" % leaf.path)
    try: m.SandboxCgroup.create(cgroup=base + "/cgroup", root=base + "/sys"); check(False, "a second leaf in one scope")
    except OSError: pass
    leaf.remove(); check(not os.path.exists(leaf.path), "removed")
    for line in ["0::/system.slice/murage-home.service\n", "0::/murage.slice/murage-turns.slice/murage-turn-0123456789abcdef.scope\n", "0::/murage.slice/murage-browsers.slice/murage-browser-bot-1.0a0a0a0a.scope/sandbox\n", "1:cpu:/x\n", ""]:
        with open(base + "/cgroup", "w") as stream: stream.write(line)
        try: m.SandboxCgroup.create(cgroup=base + "/cgroup", root=base + "/sys"); check(False, "leaf outside a browser scope: %r" % line)
        except (OSError, ValueError): pass
    try: m.SandboxCgroup.create(cgroup=base + "/missing", root=base + "/sys"); check(False, "no cgroup file")
    except OSError: pass
    # The kernel's operation (cgroup.kill, 5.14+): the leaf is told to die as a whole; no pid is signalled by the launcher.
    bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    try:
        leaf = fake_leaf(base, "kernel", procs=[bystander.pid])
        with open(leaf.path + "/cgroup.events", "w") as stream: stream.write("populated 0\n")
        check(leaf.kill(wait=1) is True and open(leaf.path + "/cgroup.kill").read() == "1" and open(leaf.path + "/cgroup.freeze").read() == "", "cgroup.kill written, nothing else")
        time.sleep(0.1); check(bystander.poll() is None, "the launcher itself signals no pid when the kernel does the kill")
        # A leaf that does not empty in time is reported (the status still comes from the child's own kill).
        leaf = fake_leaf(base, "stuck", procs=[bystander.pid])
        check(leaf.kill(wait=0.3) is False, "a leaf that stays populated is not reported empty")
    finally:
        bystander.kill(); bystander.wait()
    # Without cgroup.kill: freeze, wait for the kernel's frozen=1 (freezing is asynchronous), only then list and SIGKILL
    # every member, thaw, wait. Only the leaf's members are touched: a process outside it, SIGTERM-proof or not, is
    # never signalled; neither is the launcher.
    sleeper = lambda: subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)"])
    victim, outsider = sleeper(), sleeper()
    try:
        leaf = FakeKernel(base + "/older", [victim.pid])
        check(leaf.kill(wait=5) is True and victim.wait(5) == -9, "freeze+SIGKILL fallback ends the member")
        check(leaf.reads and all(leaf.reads) and leaf.freeze == "0", "every listing was read frozen, thawed after: %r" % leaf.reads)
        time.sleep(0.1); check(outsider.poll() is None, "a process outside the leaf is untouched")
        # A leaf that no longer exists (trimmed with its scope) is already empty; a leaf whose files cannot be read lists nothing.
        check(m.SandboxCgroup(base + "/gone").kill(wait=0.1) is True and m.SandboxCgroup(base + "/gone").procs() == [] and m.SandboxCgroup(base + "/gone").populated() is None and m.SandboxCgroup(base + "/gone").frozen() is None, "a missing leaf")
    finally:
        outsider.kill(); outsider.wait()
    # A leaf that never reports frozen, or a kernel without the freezer, is never signalled from a listing: refused and reported.
    for name, kwargs in (("never", {"honest": False}), ("nofreezer", {"freezer": False})):
        victim, reports = sleeper(), []
        try:
            leaf = FakeKernel(base + "/" + name, [victim.pid], **kwargs)
            check(leaf.kill(wait=0.5, report=reports.append) is False and leaf.reads == [] and reports == ["Cloud browser sandbox could not be frozen: its processes were not signalled"], "%s: refused, nothing listed: %r %r" % (name, leaf.reads, reports))
            time.sleep(0.1); check(victim.poll() is None, "%s: the member was not signalled" % name)
        finally:
            victim.kill(); victim.wait()
    # kill_sandbox: the leaf as a whole, then the child's own status; a stopped child included.
    child, extra = sleeper(), sleeper()
    os.kill(child.pid, signal.SIGSTOP); time.sleep(0.1)
    status = m.kill_sandbox(child.pid, FakeKernel(base + "/sandbox", [child.pid, extra.pid]))
    child.returncode = status
    check(os.WIFSIGNALED(status) and os.WTERMSIG(status) == 9 and extra.wait(5) == -9, "kill_sandbox: the whole leaf and the child's status")
    # A daemon a client starts in a command's sandbox with a socket directory of its own (AGENT_BROWSER_SOCKET_DIR) outlives
    # the command's process tree; the command's leaf ends it at the command's end, with nothing of the tree left.
    base, home, fake, env = setup()
    rogue_dir = base + "/rogue"; os.makedirs(rogue_dir, mode=0o700)
    command = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "command-rogue", home, "guest-ui-canary", fake, rogue_dir], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    check(command.wait(20) == 0 and json.loads(command.stdout.read())["success"], "the client's own daemon answered it")
    check(m.session_alive(home, "guest-ui-canary") is False and os.path.exists(rogue_dir + "/guest-ui-canary.sock"), "its socket is nowhere near the session directory")
    probe = socket.socket(socket.AF_UNIX); probe.connect(rogue_dir + "/guest-ui-canary.sock"); probe.close()
    check(len(chromes(base)) == 0 and len(leftovers(base)) >= 2, "the rogue daemon and its Chrome outlive the command: %r" % leftovers(base))
    leaf = LiveSandbox(base)
    check(leaf.kill() is True, "the command's leaf ends them")
    time.sleep(0.2)
    check(leftovers(base) == [], "nothing of the command's tree is left: %r" % leftovers(base))
    probe = socket.socket(socket.AF_UNIX)
    try: probe.connect(rogue_dir + "/guest-ui-canary.sock"); check(False, "the rogue socket still answers")
    except OSError: pass
    finally: probe.close()
    # Launcher death (the pdeathsig race, r3 M): the reaper, outside the leaf, kills it when the launcher's pipe reaches EOF,
    # whether or not the sandbox child still carries a death signal (the AppArmor transition clears it before bwrap re-arms).
    base = tempfile.mkdtemp(prefix="reaper-")
    home = base + "/home"; os.makedirs(home + "/sockets", mode=0o700)
    launcher = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "launcher-reaper", home, "guest-ui-canary", base + "/agent-browser"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        check(select.select([launcher.stdout], [], [], 10)[0], "launcher reports")
        pids = json.loads(launcher.stdout.readline())
        check(m.pid_alive(pids["reaper"]) and m.pid_alive(pids["sandbox"]) and ppid(pids["reaper"]) == launcher.pid and ppid(pids["sandbox"]) == launcher.pid, "reaper and sandbox run under the launcher")
        time.sleep(0.3)
        check(m.pid_alive(pids["sandbox"]) and m.pid_alive(pids["reaper"]), "nothing happens while the launcher lives")
        os.kill(launcher.pid, signal.SIGKILL); launcher.wait(5)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and (m.pid_alive(pids["sandbox"]) or m.pid_alive(pids["reaper"])): time.sleep(0.02)
        check(not m.pid_alive(pids["sandbox"]), "the unarmed sandbox child died with the launcher, through the leaf")
        check(not m.pid_alive(pids["reaper"]), "the reaper exits after the kill")
    finally:
        if launcher.poll() is None: launcher.kill(); launcher.wait()
        kill_tree(base)
    # The orderly end: closing the pipe makes the reaper kill (an already-empty leaf) and exit; the launcher waits for it.
    leaf = fake_leaf(base, "orderly")
    reaper = m.start_reaper(leaf)
    started = time.monotonic(); m.stop_reaper(reaper)
    check(time.monotonic() - started < 2 and open(leaf.path + "/cgroup.kill").read() == "1" and not m.pid_alive(reaper[0]), "EOF: kill, exit, reaped")
    # The arming of a death signal is checked, never assumed.
    try: m.arm_death_signal(os.getppid(), prctl=lambda: -1); check(False, "a failed prctl passes")
    except OSError: pass

def mcp_idle():
    # r4 High: the session's idle limit and cap hold for every launch's sandbox, the MCP server's included, on the
    # one trusted clock. A client that keeps the MCP sandbox alive with a daemon of its own under its own socket
    # directory lives exactly as long as the session is in use: idle (5 min without real activity) or the cap ends
    # the whole leaf, daemon and Chrome included, and a command's end never closes the host's daemon.
    def rogue_mcp():
        base, home, fake, env = setup()
        rogue_dir = base + "/rogue"; os.makedirs(rogue_dir, mode=0o700)
        mcp = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "mcp-rogue", home, "guest-ui-canary", fake, rogue_dir], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        check(select.select([mcp.stdout], [], [], 20)[0] and mcp.stdout.readline() == b"up\n", "the client's own daemon is up under the MCP sandbox")
        probe = socket.socket(socket.AF_UNIX); probe.connect(rogue_dir + "/guest-ui-canary.sock"); probe.close()
        check(len(leftovers(base)) >= 3, "sandbox, rogue daemon and its Chrome alive: %r" % leftovers(base))
        return base, home, mcp, rogue_dir
    def gone(base, rogue_dir):
        probe = socket.socket(socket.AF_UNIX)
        try: probe.connect(rogue_dir + "/guest-ui-canary.sock"); check(False, "the rogue socket still answers")
        except OSError: pass
        finally: probe.close()
        check(leftovers(base) == [], "nothing of the MCP sandbox is left: %r" % leftovers(base))
    closes = []
    end = lambda home_, session, kill: closes.append(1) or m.end_command(home_, session, kill)
    base, home, mcp, rogue_dir = rogue_mcp()
    reason, at, status = supervise(mcp, base, home, -1, activity="none", real=0.3, end=end)
    check(reason == "idle" and 300 <= at <= 330 and os.WIFSIGNALED(status) and os.WTERMSIG(status) == 9, "the MCP sandbox ends at the idle limit: %r %r" % (reason, at))
    check(closes == [1], "a command's end is its leaf's kill alone (end_command)")
    gone(base, rogue_dir)
    # Real activity (MCP frames on the trusted clock) resets idle; the daemon it keeps alive follows the session's use.
    base, home, mcp, rogue_dir = rogue_mcp()
    reason, at, _ = supervise(mcp, base, home, -1, activity="until600", end=m.end_command)
    check(reason == "idle" and 900 <= at <= 930, "idle counted from the last frame: %r %r" % (reason, at))
    gone(base, rogue_dir)
    # Activity never stops: the cap ends the MCP sandbox and the daemon under it anyway.
    base, home, mcp, rogue_dir = rogue_mcp()
    reason, at, _ = supervise(mcp, base, home, -1, activity="always", poll=60, real=0.1, end=m.end_command)
    check(reason == "cap" and 3600 <= at <= 3660, "the MCP sandbox ends at the cap: %r %r" % (reason, at))
    gone(base, rogue_dir)
    # end_command never closes the daemon: no close is sent, only the kill runs.
    seen = []
    m.end_command("/h", "s", kill=lambda: seen.append("kill"))
    check(seen == ["kill"], "end_command: kill only")
    # Long-lived launches are capped by systemd as well: MCP and both relays, like the host; one-shot commands are not.
    request = {"mode": "browser", "bot": "bot-1", "settings": {"AGENT_BROWSER_SESSION": "s1", "AGENT_BROWSER_ENCRYPTION_KEY": "a" * 64}}
    for args in (["mcp", "--tools", "core", "--no-webmcp"], ["relay", "cdp"], ["relay", "stream"]):
        check(m.scope_plan({**request, "args": args})[2] == m.HOST_SCOPE_PROPERTIES, "capped scope: %r" % args)
    for args in (["--version"], ["--json", "open", "about:blank"], ["--json", "get", "cdp-url"]):
        check(m.scope_plan({**request, "args": args})[2] == m.BROWSER_SCOPE_PROPERTIES, "one-shot scope: %r" % args)

def mcp_gate():
    # H1: every MCP request needs a live host; after an idle/cap end the next one starts a proper host first.
    request = {"mode": "browser", "bot": "bot-1", "instance": "i" * 22, "args": ["mcp", "--tools", "core", "--no-webmcp"], "settings": {"AGENT_BROWSER_SESSION": "s1"}}
    state, calls = {"live": True, "start": True}, []
    live = lambda root, bot, session, owner: state["live"]
    def ensure(req, home):
        calls.append("ensure")
        state["live"] = state["start"]
    gate = lambda: m.require_host(request, "/h", root="/r", live=live, ensure=ensure)
    r, w = os.pipe(); out_r, out_w = os.pipe(); touches = []
    def got(timeout=0.3):
        return os.read(out_r, 1000) if select.select([out_r], [], [], timeout)[0] else b""
    pump = threading_pump(r, out_w, gate, lambda: touches.append(1), framed=True)
    os.write(w, b'{"id":1}\n')
    check(got() == b'{"id":1}\n' and calls == [], "live host: forwarded, nothing started")
    state["live"] = False  # the host ended (idle or cap)
    os.write(w, b'{"id":2}\n')
    check(got() == b'{"id":2}\n' and calls == ["ensure"], "no host: one started before the frame")
    # A frame is a line: a partial one waits for its newline, nothing is checked or forwarded for it yet.
    state["live"] = True
    os.write(w, b'{"id":3,"x":"ab')
    check(got() == b"" and len(touches) == 2, "a partial frame is held back")
    # Two frames arrive in one chunk: each is gated and counted on its own (chunk checks were not request checks).
    os.write(w, b'c"}\n{"id":4}\n')
    check(got() == b'{"id":3,"x":"abc"}\n{"id":4}\n' and len(touches) == 4, "two frames in one chunk: two gates, two stamps: %r" % touches)
    # The host ended and none can start: two frames queued in one chunk are BOTH refused. The first gate fails, the
    # pump ends with nothing more forwarded, the command's stdin closes; the second frame never reaches a gate.
    state["live"], state["start"] = False, False
    os.write(w, b'{"id":5}\n{"id":6}\n'); pump.join(5)
    check(not pump.is_alive() and pump.code == 1 and calls == ["ensure", "ensure"], "fail closed, one gate: %r" % calls)
    check(got() == b"" and len(touches) == 4, "neither queued frame is forwarded or counted; stdin closes")
    os.close(w); os.close(r); os.close(out_r)
    # A frame without end fails closed at the bound rather than growing root memory.
    r, w = os.pipe(); out_r, out_w = os.pipe()
    pump = threading_pump(r, out_w, lambda: None, lambda: None, framed=True, frame_max=64)
    os.write(w, b"x" * 65); pump.join(5)
    check(not pump.is_alive() and pump.code == 1 and os.read(out_r, 100) == b"", "oversize frame refused")
    os.close(w); os.close(r); os.close(out_r)
    # An unterminated frame at EOF is dropped, never dispatched half.
    r, w = os.pipe(); out_r, out_w = os.pipe()
    pump = threading_pump(r, out_w, lambda: None, lambda: None, framed=True)
    os.write(w, b'{"id":7}\n{"id":8'); os.close(w); pump.join(5)
    check(pump.code == 0 and os.read(out_r, 100) == b'{"id":7}\n', "EOF drops the half frame")
    os.close(r); os.close(out_r)
    # Relay stdin stays a byte stream: no framing, chunks pass as they come.
    r, w = os.pipe(); out_r, out_w = os.pipe()
    pump = threading_pump(r, out_w, None, lambda: None)
    os.write(w, b"GET /x\r\n\r\npartial"); check(got() == b"GET /x\r\n\r\npartial", "relay bytes unframed")
    os.close(w); pump.join(5); os.close(r); os.close(out_r)
    # Session clients never start a host; a missing one is the fixed refusal.
    try: m.require_host({**request, "args": ["--json", "get", "cdp-url"]}, "/h", root="/r", live=lambda *a: False, ensure=ensure, start=False); check(False, "client refused")
    except m.BrowserSessionDown as error: check(str(error) == "Cloud browser session is not running", "client text")
    # Nothing in the MCP sandbox watches for daemons any more: it cannot bind one (read-only socket directory) and
    # the launcher's own supervisor is out of its reach, so the same-uid watchdog is gone.
    source = open(LAUNCHER).read()
    check("def run_mcp" not in source and "def auto_daemons" not in source and "PR_SET_CHILD_SUBREAPER" in source, "no in-sandbox MCP watchdog")

def threading_pump(r, out_w, gate, touch, **extra):
    import threading
    thread = threading.Thread(target=lambda: setattr(thread, "code", m.pump_stdin(r, out_w, gate, touch, **extra)), daemon=True)
    thread.code = None; thread.start(); return thread

def pump_death():
    # M (r2): the pump and the sandbox die with their launcher. The launcher is SIGKILLed with its stdin still open
    # (no EOF to help): the pump (parent-death signal) and the death-signal-armed sandbox child are gone within a second.
    base = tempfile.mkdtemp(prefix="pump-death-")
    home = base + "/home"; os.makedirs(home + "/sockets", mode=0o700)
    launcher = subprocess.Popen([sys.executable, "-I", "-c", STEP, LAUNCHER, "launcher", home, "guest-ui-canary", base + "/agent-browser"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        check(select.select([launcher.stdout], [], [], 10)[0], "launcher reports")
        pids = json.loads(launcher.stdout.readline())
        check(m.pid_alive(pids["pump"]) and m.pid_alive(pids["sandbox"]) and ppid(pids["pump"]) == launcher.pid and ppid(pids["sandbox"]) == launcher.pid, "pump and sandbox run under the launcher")
        os.kill(launcher.pid, signal.SIGKILL); launcher.wait(5)
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and (m.pid_alive(pids["pump"]) or m.pid_alive(pids["sandbox"])): time.sleep(0.02)
        check(not m.pid_alive(pids["pump"]) and not m.pid_alive(pids["sandbox"]), "both died with the launcher: %r" % leftovers(base))
    finally:
        if launcher.poll() is None: launcher.kill(); launcher.wait()
        kill_tree(base)
    # The arming is race-checked: a parent already gone raises instead of running unarmed.
    try: m.arm_death_signal(os.getppid() + 100000, prctl=lambda: None); check(False, "gone parent")
    except OSError: pass
    m.arm_death_signal(os.getppid(), prctl=lambda: None)
    # And it is wired where it must be: in the launcher's validate() (after the uid drop) and in the pump child.
    source = open(LAUNCHER).read()
    check("        recheck_stamp(path, stamp)\n        arm_death_signal(launcher)" in source and "            arm_death_signal(parent)\n            code = pump_stdin(" in source, "death signal wiring")

def close_deadline():
    # M: one deadline for the whole close; a drip-fed answer cannot stretch it.
    import threading
    base, home, fake, env = setup()
    s = "guest-ui-canary"
    srv = socket.socket(socket.AF_UNIX); srv.bind(home + "/sockets/" + s + ".sock"); srv.listen(1)
    def drip():
        conn, _ = srv.accept(); conn.recv(4096)
        try:
            while True: conn.sendall(b" "); time.sleep(0.3)
        except OSError: pass
    threading.Thread(target=drip, daemon=True).start()
    started = time.monotonic()
    try: m.browser_close(home, s, timeout=2); check(False, "drip must time out")
    except (TimeoutError, socket.timeout): pass
    took = time.monotonic() - started
    check(1.9 <= took <= 2.6, "close bounded at 2 s total, took %.2f" % took)
    threading.Thread(target=drip, daemon=True).start()
    started = time.monotonic(); m.end_session(home, s)
    check(time.monotonic() - started <= 2.6, "end_session kills within the close deadline")
    srv.close()

def relay_direction():
    # The relay stays a plain pipe; its activity is counted by the root pump in front of stdin.
    def relay(up, down):
        a, b = socket.socketpair(); r, w = os.pipe(); out_r, out_w = os.pipe()
        if down: b.sendall(down)
        if up: os.write(w, up); os.close(w)
        else: b.shutdown(socket.SHUT_WR)
        m.relay_pipe(a, r, out_w)
        got = os.read(out_r, 100) if down else b.recv(100)
        for fd in (r, out_r, out_w) + (() if up else (w,)): os.close(fd)
        a.close(); b.close(); return got
    check(relay(b"", b"frame") == b"frame" and relay(b"cmd", b"") == b"cmd", "relay bytes both ways")
    # The throttle keeps root stamps to one per ACTIVITY_TOUCH_SEC.
    calls, now = [], [100.0]
    touch = m.activity_toucher(lambda: calls.append(now[0]), clock=lambda: now[0])
    touch(); now[0] += 1; touch(); now[0] += 3.9; touch(); now[0] += 0.1; touch()
    check(calls == [100.0, 105.0], "throttle %r" % calls)
    # The in-sandbox gate only checks the daemon; the host check is root-side.
    seen = []
    m.client_gate("/h", "s", ["--json", "get", "cdp-url"], require=lambda h, ss: seen.append("require"))
    m.client_gate("/h", "s", ["--version"], require=lambda h, ss: seen.append("require"))
    check(seen == ["require"], "gate %r" % seen)
    source = open(LAUNCHER).read()
    check("live = hold_host_live(root, bot, session)" in source and "require_host(request, home, start=" in source and "pump = start_pump(" in source, "launch wiring")

{"three-invocations": three_invocations, "old-path-and-expiry": old_path_and_expiry, "ensure-host": ensure_host, "spawn-host": spawn_host, "contract": contract,
 "idle-and-cap": idle_and_cap, "host-exits": host_exits, "single-start": single_start, "rogue": rogue, "sandbox-cgroup": sandbox_cgroup, "mcp-idle": mcp_idle, "mcp-gate": mcp_gate, "pump-death": pump_death,
 "close-deadline": close_deadline, "relay": relay_direction}[CASE]()
print("OK " + CASE)
