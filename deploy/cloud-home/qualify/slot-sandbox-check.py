#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Real-sandbox proof for the two-slot release layout (Lane G): /opt/murage -> murage-releases/current -> A.

Runs the launcher's own validate_request / manifest_command (digest, identity stamps), then the argv turn_mount_args and
browser_mount_args build, under real bwrap, and execs the engine, the browser binary and the browser's chrome inside the
sandbox through the launcher's own exec_slot. Prints one JSON line per step and exits 1 if any step fails.

Run as the turn user (uid of `murage-turn`), never root, on a host that has this layout installed by root:

    /opt/murage-releases/A/{bin/claude, engine-manifest.json, resources/browser-engine/...}   (root 0755, bytes of any native ELF)
    /opt/murage-releases/current -> A          /opt/murage -> murage-releases/current
    /usr/local/libexec/murage-turn-launch      (a copy of the launcher under test, root-owned)

Usage: slot-sandbox-check.py <launcher.py>
"""
import importlib.machinery, importlib.util, json, os, subprocess, sys, tempfile

launcher = sys.argv[1]
spec = importlib.util.spec_from_loader("launcher", importlib.machinery.SourceFileLoader("launcher", launcher))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
failures = []

def step(name, ok, detail=""):
    print(json.dumps({"step": name, "ok": bool(ok), "detail": str(detail)[:400]}), flush=True)
    if not ok:
        failures.append(name)

def with_fds(argv, blobs):
    fds = []
    for index, arg in enumerate(argv):
        if arg.startswith(m.FD_TOKEN):
            data = blobs[arg[len(m.FD_TOKEN):]]
            with tempfile.TemporaryFile() as stream:
                stream.write(data.encode() if isinstance(data, str) else data)
                stream.flush()
                read = os.open("/proc/self/fd/" + str(stream.fileno()), os.O_RDONLY)
            fds.append(read)
            argv[index] = str(read)
    return argv, fds

def run(argv, fds=()):
    return subprocess.run(argv, pass_fds=list(fds), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})

root = tempfile.mkdtemp(prefix="slot-check-")
engine_root = os.path.join(root, "engine-homes")
home = os.path.join(engine_root, "claudeAgent")
os.makedirs(home)
for relative in m.credential_dirs("claudeAgent"):
    os.makedirs(os.path.join(home, relative), mode=0o770, exist_ok=True)

step("layout: /opt/murage resolves into a slot", m.RELEASE_SLOT.fullmatch(os.path.realpath("/opt/murage")), os.path.realpath("/opt/murage"))

# 1. Engine turn: validate (manifest entry /opt/murage/bin/claude, resolved to the slot), stamp, plan, run in bwrap.
request = {"engine": "claudeAgent", "command": "/opt/murage/bin/claude", "args": ["--version"], "cwd": home, "env": {"LANG": "C.UTF-8"}}
try:
    engine, home_, cwd, command, args, env, render, bot = m.validate_request(request, manifest_path=m.ENGINE_MANIFEST, manifest_uid=0,
                                                                              engine_root=engine_root, cache_root=os.path.join(root, "cache"))
    step("engine: validate_request accepts the listed /opt/murage/bin/claude", True, "resolved to " + command)
except Exception as error:
    step("engine: validate_request accepts the listed /opt/murage/bin/claude", False, repr(error))
    sys.exit(1)

turn_home = tempfile.mkdtemp(prefix="turn-home-", dir=root)
hfd, tfd = os.open(home, os.O_RDONLY | os.O_DIRECTORY), os.open(turn_home, os.O_RDONLY | os.O_DIRECTORY)
try:
    m.stage_turn_home(hfd, engine, tfd, None, (os.getuid(),), m.turn_state_ids(engine, args, render), bot=bot, cwd=cwd, render=render)
finally:
    os.close(hfd); os.close(tfd)
argv, blobs = m.turn_mount_args(engine, [], home, cwd, command, args, render, [], turn_home=turn_home)
argv, fds = with_fds(argv, blobs)
step("engine: the plan binds the stamped slot and links /opt/murage to it", "--symlink" in argv and os.path.dirname(os.path.dirname(command)) in argv, " ".join(argv[argv.index("--symlink"):argv.index("--symlink") + 3]) if "--symlink" in argv else "no --symlink in the plan")
argv2, blobs2 = m.turn_mount_args(engine, [], home, cwd, command, args, render, [], turn_home=turn_home)
argv2, fds2 = with_fds(argv2, blobs2)
# The plan as launch() runs it: bwrap -> the launcher's --child re-exec -> exec_slot(command).
result = run(argv, fds)
step("engine: the engine executes inside bwrap through the launcher's --child path", result.returncode == 0 and result.stdout.startswith(b"echo (GNU coreutils)"),
     "rc=%d stdout=%r stderr=%r" % (result.returncode, result.stdout[:80], result.stderr[-200:]))
# Look at the sandbox from inside: the slot is bound at its own path and /opt/murage is a link to it.
inner = argv[:argv.index("--") + 1] + ["/bin/sh", "-c", "readlink /opt/murage; readlink -f /opt/murage/bin/claude; ls /opt/murage-releases; test -x %s && echo exec-ok" % command]
seen = run(inner, fds)
step("engine: inside bwrap /opt/murage is a link to the bound slot", seen.stdout.decode().split() [:4] == [os.path.realpath("/opt/murage"), os.path.realpath("/opt/murage") + "/bin/claude", os.path.basename(os.path.realpath("/opt/murage")), "exec-ok"],
     seen.stdout.decode().replace("\n", " | ") + seen.stderr.decode()[-150:])
for fd in fds:
    os.close(fd)

# 2. Browser: both binaries are stamped and re-checked, then the browser sandbox execs them through exec_slot.
stamps = {}
try:
    binary = m.manifest_command("browser", m.BROWSER_BINARY, stamps=stamps)
    chrome = m.manifest_command("browser", m.BROWSER_CHROME, stamps=stamps)
    step("browser: manifest_command stamps agent-browser and chrome", True, binary + " , " + chrome)
    for path, stamp in stamps.items():
        m.recheck_stamp(path, stamp)
    step("browser: recheck_stamp holds for the resolved files", True)
except Exception as error:
    step("browser: manifest_command stamps agent-browser and chrome", False, repr(error))
    sys.exit(1)
browser_home = "/data/browser/slot-check"
source = tempfile.mkdtemp(prefix="browser-home-", dir=root)
os.makedirs(source + "/tmp")
try:
    plan = m.browser_mount_args([(source, browser_home)], browser_home, ["--version"], host=True, release_command=binary)
except TypeError:  # a launcher from before the slot bind: its plan has no release_command
    plan = m.browser_mount_args([(source, browser_home)], browser_home, ["--version"], host=True)
plan[0] = "/usr/bin/bwrap"  # the AppArmor-wrapped bwrap is an image file; the plan is otherwise the launcher's own
body = ("import importlib.machinery,importlib.util,os,sys\nspec=importlib.util.spec_from_loader('l',importlib.machinery.SourceFileLoader('l','/usr/local/libexec/murage-turn-launch'))\n"
        "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nwhich=sys.argv[1]\n"
        "path=m.BROWSER_BINARY if which=='binary' else m.BROWSER_CHROME\nm.exec_slot(path,[path,'--version'],os.environ)\n")
for which in ("binary", "chrome"):
    command_line = plan[:plan.index("--") + 1] + ["/usr/bin/python3", "-I", "-c", body, which]
    outcome = run(command_line)
    step("browser: %s executes inside the browser bwrap via exec_slot(/opt/murage/...)" % which, outcome.returncode == 0,
         "rc=%d stdout=%r stderr=%r" % (outcome.returncode, outcome.stdout[:60], outcome.stderr[-200:]))

# 4. Slot flip between validation and exec (SLOT_FLIP=1: the root driver flips `current` to B when asked, see slot-sandbox-run.sh).
# Plans were built and stamped on slot A before the flip; they bind slot A by name, so the stamped A bytes are what runs, never B's.
if os.environ.get("SLOT_FLIP") == "1":
    open("/tmp/slot-flip-request", "w").close()
    for _ in range(300):
        if os.path.exists("/tmp/slot-flipped"):
            break
        import time; time.sleep(0.1)
    step("flip: /opt/murage now resolves to slot B", os.path.realpath("/opt/murage").endswith("/B"), os.path.realpath("/opt/murage"))
    after = run(argv2, fds2)
    step("flip: the engine plan validated on A still runs A's bytes (echo), not B's", after.returncode == 0 and after.stdout.startswith(b"echo (GNU coreutils)"),
         "rc=%d stdout=%r stderr=%r" % (after.returncode, after.stdout[:60], after.stderr[-200:]))
    after_browser = run(plan[:plan.index("--") + 1] + ["/usr/bin/python3", "-I", "-c", body, "binary"])
    step("flip: the browser plan validated on A still runs A's agent-browser", after_browser.returncode == 0 and after_browser.stdout.startswith(b"echo (GNU coreutils)"),
         "rc=%d stdout=%r" % (after_browser.returncode, after_browser.stdout[:60]))
    try:
        for path, stamp in stamps.items():
            m.recheck_stamp(path, stamp)
        step("flip: recheck_stamp still verifies the stamped A files", True)
    except ValueError as error:
        step("flip: recheck_stamp still verifies the stamped A files", False, repr(error))
    try:
        m.manifest_command("browser", m.BROWSER_BINARY, stamps={})
        step("flip: a fresh validation of the same /opt/murage spelling is refused (B is not the listed digest)", False, "accepted B")
    except ValueError as error:
        step("flip: a fresh validation of the same /opt/murage spelling is refused (B is not the listed digest)", True, str(error))

# 3. The slot guard still bites inside the sandbox: a path that resolves outside A or B is refused.
refuse = plan[:plan.index("--") + 1] + ["/usr/bin/python3", "-I", "-c",
         "import importlib.machinery,importlib.util,os\nspec=importlib.util.spec_from_loader('l',importlib.machinery.SourceFileLoader('l','/usr/local/libexec/murage-turn-launch'))\n"
         "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.exec_slot('/opt/murage/../murage-releases/../../bin/true',['true'],os.environ)\n"]
denied = run(refuse)
step("exec_slot inside the sandbox still refuses a path that leaves the slot", denied.returncode != 0, "rc=%d" % denied.returncode)

sys.exit(1 if failures else 0)
