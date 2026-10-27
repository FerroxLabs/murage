#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fixed sudo entrypoint. Request arrives on FD3, never in argv or sudo env."""
import ctypes
import importlib.machinery
import importlib.util
import secrets
import time
import hashlib
import json
import os
import platform
import grp
import pwd
import re
import resource
import re
import shutil
import socket
import urllib.parse
import stat
import sys
import signal
import select
import fcntl
import errno
import struct
import termios
import contextlib

ENGINES = {"claudeAgent", "codex", "pi", "antigravity", "grokAgent", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "customAcp", "fuigoAgent", "hermesAgent", "opencodeGo", "qwenAgent"}
ENGINE_MANIFEST = "/opt/murage/engine-manifest.json"
SECCOMP_BPF = "/usr/local/libexec/murage-seccomp.bpf"
SANDBOX_GROUP = "murage-sandbox"
# pasta (passt 20240220) spawns the sandbox in its own user+net namespace. The
# turn reaches the host only through the single -T forward and the dns-forward
# address below.
PASTA = "/usr/bin/pasta"
PASTA_HOST_PORT = 8799
PASTA_DNS = "192.0.2.53"  # TEST-NET-1: never a real host, only pasta answers it
HOST_STUB_DNS = "127.0.0.53"  # systemd-resolved stub, the host resolv.conf's only nameserver
BROWSER_BWRAP = "/usr/local/libexec/murage-browser-bwrap"  # browser-bwrap.apparmor
# Resource containment (audit A1-03/A1-05). Every turn and every browser launch
# runs in its own transient systemd scope under a limited slice, so a runaway or
# hostile one hits its own cap before it can take the home down. Sizes: the
# turn's /tmp and each scratch tmpfs are capped at 512 MiB (tmpfs pages are
# charged to the turn scope, whose MemoryMax bounds the sum); the small config
# shadow tmpfs only ever holds a few KiB of rendered config.
SYSTEMD_RUN = "/usr/bin/systemd-run"
SYSTEMCTL = "/usr/bin/systemctl"
TURN_SLICE, BROWSER_SLICE = "murage-turns.slice", "murage-browsers.slice"
TURN_RUNTIME_MAX_SEC = 6 * 60 * 60  # hard cap on an ordinary turn scope, enforced by systemd even if this launcher is SIGKILLed
TURN_SCOPE_PROPERTIES = ["TasksMax=512", "MemoryMax=40%", "TimeoutStopSec=5", "BindsTo=murage-home.service", "After=murage-home.service", "RuntimeMaxSec=" + str(TURN_RUNTIME_MAX_SEC)]
# Delegate=yes: the launcher creates the sandbox's own cgroup under its scope (SandboxCgroup), which systemd permits only in a delegated subtree.
BROWSER_SCOPE_PROPERTIES = ["TasksMax=1024", "MemoryMax=1G", "TimeoutStopSec=5", "BindsTo=murage-home.service", "After=murage-home.service", "Delegate=yes"]
# Engine sign-in (B2; r9 "logout", "launcher modes"). `login` mode runs the vendor CLI's
# own sign-in in the turn sandbox with a terminal relayed by the server. The argv comes
# ONLY from this root-side table; the request names an engine and an action, never a
# command. The binary is /opt/murage/bin/<name>, verified against the manifest like any
# turn. Only sign-ins are here: every `logout` (and every `enroll-key`) runs no CLI and is
# the launcher's own publish of a generation (publish_login below), since the vendor
# logouts only unlink the local file, which an empty generation already does. Sources:
#   codex:       `codex login --device-auth` (OpenAI Codex CLI authentication docs,
#                developers.openai.com/codex/auth; --device-auth is the headless
#                device-code flow, verified in codex 0.160.0). B mode: per bot.
#   claudeAgent: `claude setup-token` (Claude Code CLI reference, re-checked in 2.1.292):
#                prints a long-lived sk-ant-oat01- token that the root parent of the turn
#                captures from the pty stream (TokenFilter) into the C store; r8 R3.1.
#   grokAgent:   `grok login --device-auth` ("device-code authentication for
#                headless/remote environments", `--help` of Grok Build 1.0.52). B mode.
#   kimiAgent:   `kimi login --region global` (`kimi login --help` in Kimi Code 2.2.0:
#                "Authenticate with Kimi Code CLI via the device-code flow"; the region
#                defaults to mainland-cn, kimi.com). B mode.
#   opencodeGo:  `opencode auth login` (opencode-go.ts signInCommand). B mode: only the
#                oauth entries it writes are kept (collect, shape_opencode_auth).
LOGIN_COMMANDS = {
    "codex": ("/opt/murage/bin/codex", {"login": ["login", "--device-auth"]}),
    "claudeAgent": ("/opt/murage/bin/claude", {"login": ["setup-token"]}),
    "grokAgent": ("/opt/murage/bin/grok", {"login": ["login", "--device-auth"]}),
    "kimiAgent": ("/opt/murage/bin/kimi", {"login": ["login", "--region", "global"]}),
    "opencodeGo": ("/opt/murage/bin/opencode", {"login": ["auth", "login"]}),
}
# r9 "launcher modes": Claude's sign-in is C (engine-wide, takes no bot); every other
# engine's `login` is B and names its bot. `enroll-key` (no CLI) exists for Codex and
# for OpenCode with a provider; `logout` for every engine above.
LOGIN_C_ENGINES = frozenset({"claudeAgent"})
ENROLL_ENGINES = frozenset({"codex", "opencodeGo"})
LOGIN_LABEL = {"codex": "Codex", "claudeAgent": "Claude", "grokAgent": "Grok", "kimiAgent": "Kimi", "opencodeGo": "OpenCode"}
LOGIN_SECRET_SHAPE = re.compile(r"[A-Za-z0-9._-]{20,512}", re.ASCII)
LOGIN_PROVIDER_SHAPE = re.compile(r"[a-z][a-z0-9_-]{0,31}", re.ASCII)
# Per-engine environment for a sign-in, relative to the engine home. It must name the
# same config home the engine's turns use (server/cloud-home/turn-process.ts
# cloudTurnEnvironment), or the CLI would write the token where turns never look.
# Each variable was found in the shipped binary: GROK_HOME and GROK_DISABLE_AUTOUPDATER
# (Grok Build 1.0.52), KIMI_CODE_HOME and KIMI_CODE_NO_AUTO_UPDATE (Kimi Code 2.2.0).
# OpenCode reads $XDG_DATA_HOME/opencode/auth.json, which every login env already pins.
LOGIN_ENV = {
    "codex": {"CODEX_HOME": "/.codex"},
    "claudeAgent": {"CLAUDE_CONFIG_DIR": "/.claude", "DISABLE_UPDATES": "1", "DISABLE_AUTOUPDATER": "1"},
    "grokAgent": {"GROK_HOME": "/.grok", "GROK_DISABLE_AUTOUPDATER": "1"},
    "kimiAgent": {"KIMI_CODE_HOME": "/.kimi-code", "KIMI_CODE_NO_AUTO_UPDATE": "1"},
    "opencodeGo": {"OPENCODE_DISABLE_AUTOUPDATE": "1"},
}
LOGIN_RUNTIME_MAX_SEC = 20 * 60  # hard cap on an engine sign-in scope
LOGIN_SCOPE_PROPERTIES = [item for item in TURN_SCOPE_PROPERTIES if not item.startswith("RuntimeMaxSec=")] + ["RuntimeMaxSec=" + str(LOGIN_RUNTIME_MAX_SEC)]
LOGIN_KEYS = {"mode", "engine", "action", "pty", "unit", "bot", "secret", "provider"}
TMP_SIZE = 512 * 1024 * 1024
SCRATCH_SIZE = 512 * 1024 * 1024
SHADOW_SIZE = 16 * 1024 * 1024
# The turn's $HOME (a launcher-owned tmpfs, mount_turn_home): a cap, not a reservation.
HOME_SIZE = 512 * 1024 * 1024
# Per-boot cache of verified executable digests (/run is tmpfs, so it empties
# on reboot). Root-only; a hit is trusted only for the exact file identity.
DIGEST_CACHE = "/run/murage-digest-cache"
BROWSER_BINARY = "/opt/murage/resources/browser-engine/agent-browser"
# Chrome for Testing names its directory by platform: linux64 on x86_64, linux-arm64 on aarch64.
BROWSER_CHROME_DIR = "chrome-headless-shell-linux-arm64" if platform.machine() == "aarch64" else "chrome-headless-shell-linux64"
BROWSER_CHROME = "/opt/murage/resources/browser-engine/chrome/" + BROWSER_CHROME_DIR + "/chrome-headless-shell"

BROWSER_FIXED_ARGS = (["mcp", "--tools", "core", "--no-webmcp"], ["--version"], ["--json", "stream", "status"], ["--json", "get", "cdp-url"],
                      ["relay", "cdp"], ["relay", "stream"])
# The relay finds its own endpoint with this fixed agent-browser argv; the
# request never supplies a host, a port or a URL.
RELAY_DISCOVERY = {"cdp": ["--json", "get", "cdp-url"], "stream": ["--json", "stream", "status"]}
RELAY_CHUNK = 64 * 1024
RELAY_DISCOVERY_MAX = 1024 * 1024
# Browser session host (rig581). agent-browser's one-shot client forks the
# daemon that owns Chrome. Started from a per-command sandbox (bwrap
# --unshare-pid --die-with-parent) the daemon and Chrome died with that sandbox
# ~0.2 s after the client exited, and later commands read its stale session
# files. So the daemon is only ever started inside a per-session host: its own
# murage-browser-<bot>.<id>.scope and its own murage-browser-bwrap sandbox, in
# the same bot network namespace, profile and AppArmor confinement as every
# browser command. One-shot commands only connect to it over the session socket.
# Cleanup (kill_scopes) and the daemon's own idle timeout end it, and so does
# the session's root supervisor: agent-browser runs a command (e.g. a 24 h
# `wait`) under the same lock its idle shutdown and `close` need, so one long
# command would keep Chrome alive forever. Every enforcement therefore lives in
# the root launcher of the host, OUTSIDE the sandbox and out of the browser
# uid's reach (it cannot signal, stop or ptrace root): that launcher holds the
# session's live lock (6.2: at most one host per session, the only starter)
# and the activity clock as descriptors opened before the sandbox exists, and
# supervises the bwrap child (supervise_session_host) instead of waiting on
# it: after HOST_IDLE_SEC without real browser activity (a command started,
# bytes sent through a relay, an MCP frame; a command merely still running is
# not activity), and always at HOST_RUNTIME_MAX_SEC, it sends one bounded
# close and then SIGKILLs the sandbox and everything else in its scope (6.1).
# Activity is read with fstat on that descriptor, never through a path or a
# mount a browser process could rebind. systemd enforces the cap again on the
# host's and MCP scopes (RuntimeMaxSec). The daemon can only be born in the
# host's sandbox: every other sandbox sees the session socket directory as a
# read-only bind (connect works, bind does not), so no client, no MCP server
# and no hostile browser process can start one. The host exits with its
# daemon (6.3) and its exit ends the sandbox. MCP frames each need a live
# host, started on demand, gated per JSON-RPC frame by the root pump in front
# of the server's stdin; the pump and the sandbox die with their launcher.
HOST_WARMUP = ["--json", "open", "about:blank"]
HOST_READY_WAIT = 45.0
HOST_POLL = 0.25
HOST_IDLE_SEC = 5 * 60
HOST_RUNTIME_MAX_SEC = 6 * 60 * 60
HOST_SCOPE_PROPERTIES = BROWSER_SCOPE_PROPERTIES + ["RuntimeMaxSec=" + str(HOST_RUNTIME_MAX_SEC + 60)]
HOST_GUARD_WAIT = 2.0  # root checks test the live lock with a momentary shared lock
HOST_CLOSE_WAIT = 2.0  # one deadline: a daemon busy in a long command never answers close
HOST_PROBE_SEC = 10.0  # connect-probe interval when /proc/net/unix cannot be read
ACTIVITY_TOUCH_SEC = 5.0
MCP_FRAME_MAX = 16 * 1024 * 1024  # one newline-delimited JSON-RPC frame; longer fails closed
BROWSER_SESSION_DOWN = 77  # the session's daemon is not running (or did not start)
PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
CGROUP_ROOT = "/sys/fs/cgroup"
SANDBOX_CGROUP = "sandbox"  # the leaf under a launch's scope that holds the sandbox and nothing else
SANDBOX_KILL_WAIT = 10.0  # bounded wait for a killed sandbox cgroup to empty
SESSION_CLIENT_ARGS = (["--json", "get", "cdp-url"], ["--json", "stream", "status"], ["relay", "cdp"], ["relay", "stream"])

class Refusal(ValueError):
    """A refusal whose text is fixed launcher wording plus, at most, a flag, key or path
    name the launcher itself defines; never a request value. main() prints it, so the
    first journal line says why a turn did not start (CLOUD-ENGINES-DESIGN.md 4.2)."""

class BrowserSessionDown(Exception):
    """A fixed, request-free message the server may log (never request data)."""

def browser_args_allowed(args):
    if args in BROWSER_FIXED_ARGS:
        return True
    if len(args) == 3 and args[0] == "--session" and args[2] == "close":
        return re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args[1], flags=re.ASCII) is not None
    if len(args) == 3 and args[:2] == ["--json", "open"]:
        # A page URL (never option-shaped) or the blank page; no whitespace.
        return args[2] == "about:blank" or re.fullmatch(r"https?://[^\s\x00-\x1f\x7f]{1,8192}", args[2], flags=re.ASCII) is not None
    return False

def relay_port(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("Invalid relay endpoint")
    return value

def relay_endpoint(kind, text):
    """The loopback port named by agent-browser's JSON for `kind`; anything else raises."""
    result = json.loads(text)
    if not isinstance(result, dict) or result.get("success") is False:
        raise ValueError("Invalid relay endpoint")
    data = result.get("data", result)
    if kind == "stream":
        if not isinstance(data, dict):
            raise ValueError("Invalid relay endpoint")
        return relay_port(data["port"] if "port" in data else data.get("streamPort"))
    url = data if isinstance(data, str) else data.get("cdpUrl", data.get("cdp_url", data.get("url"))) if isinstance(data, dict) else None
    if not isinstance(url, str) or re.fullmatch(r"[\x21-\x7e]{1,4096}", url) is None:
        raise ValueError("Invalid relay endpoint")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "ws" or parts.hostname != "127.0.0.1" or parts.username is not None or parts.password is not None or not parts.path.startswith("/devtools/"):
        raise ValueError("Invalid relay endpoint")
    return relay_port(parts.port)

def relay_run(argv, timeout=30):
    """argv's stdout (bounded), or raises. No shell; stdin is /dev/null and stderr is discarded."""
    readfd, writefd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
            os.dup2(writefd, 1)
            os.dup2(os.open(os.devnull, os.O_WRONLY), 2)
            os.closerange(3, 1048576)
            os.execve(argv[0], argv, os.environ)
        finally:
            os._exit(127)
    os.close(writefd)
    output, deadline, done = b"", time.monotonic() + timeout, False
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([readfd], [], [], left)[0]:
                raise TimeoutError("Relay endpoint lookup timed out")
            part = os.read(readfd, RELAY_CHUNK)
            if not part:
                break
            output += part
            if len(output) > RELAY_DISCOVERY_MAX:
                raise ValueError("Invalid relay endpoint")
        _, status = os.waitpid(pid, 0)
        done = True
        if os.waitstatus_to_exitcode(status) != 0:
            raise ValueError("Relay endpoint lookup failed")
        return output
    finally:
        os.close(readfd)
        if not done:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass

def relay_discover(kind, run=relay_run):
    output = run([BROWSER_BINARY] + RELAY_DISCOVERY[kind])
    if len(output) > RELAY_DISCOVERY_MAX:
        raise ValueError("Invalid relay endpoint")
    return relay_endpoint(kind, output.decode("utf-8"))

def relay_pipe(sock, infd, outfd, chunk=RELAY_CHUNK):
    """Copy bytes between the socket and infd/outfd until either side closes.

    At most one chunk is held per direction: a direction reads again only after
    its previous chunk was fully written, so a slow peer back-pressures instead
    of growing memory."""
    sock.setblocking(False)
    os.set_blocking(infd, False)
    os.set_blocking(outfd, False)
    up = down = b""  # up: stdin -> socket, down: socket -> stdout
    while True:
        want_read = ([infd] if not up else []) + ([sock] if not down else [])
        want_write = ([sock] if up else []) + ([outfd] if down else [])
        readable, writable, _ = select.select(want_read, want_write, [])
        try:
            if infd in readable:
                up = os.read(infd, chunk)
                if not up: return
            if sock in readable:
                down = sock.recv(chunk)
                if not down: return
            if sock in writable and up:
                up = up[sock.send(up):]
            if outfd in writable and down:
                down = down[os.write(outfd, down):]
        except (BlockingIOError, InterruptedError):
            continue

def run_relay(kind, discover=relay_discover, connect=socket.create_connection, infd=0, outfd=1, check=None):
    """Runs inside the bot's namespace and sandbox, as the browser user. Never
    writes anything but relayed bytes to stdout; refusal text goes to stderr.
    The text names the failing step with fixed words only, so the server can log it."""
    step = "session"
    try:
        if check is not None:
            check()
        step = "endpoint lookup"
        port = discover(kind)
        step = "connect"
        sock = connect(("127.0.0.1", port), timeout=5)
    except BrowserSessionDown as error:
        print(str(error), file=sys.stderr)
        return BROWSER_SESSION_DOWN
    except Exception as error:
        reason = "timed out" if isinstance(error, (TimeoutError, socket.timeout)) else "refused" if isinstance(error, ConnectionRefusedError) else "failed"
        print("Cloud browser relay could not reach its endpoint (" + step + " " + reason + ")", file=sys.stderr)
        return 1
    try:
        relay_pipe(sock, infd, outfd)
    except OSError:
        pass
    finally:
        sock.close()
    return 0

def arm_death_signal(parent, number=signal.SIGKILL, prctl=None):
    """Die with `parent` (the launcher): PR_SET_PDEATHSIG, then the race check,
    since a parent that died before the arming never triggers it. Called after
    any uid change (commit_creds clears the setting) and only in processes that
    exec nothing privileged (a secure exec clears it too). Raises when the
    parent is already gone, or when the arming itself failed."""
    if (prctl or (lambda: ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, int(number), 0, 0, 0)))():
        raise OSError("Cloud browser parent-death signal could not be armed")
    if os.getppid() != parent:
        raise OSError("Cloud browser launcher is gone")

SERVER_INSTANCE_PATTERN = re.compile(r"[A-Za-z0-9_-]{22,64}", re.ASCII)

def valid_instance(value):
    return isinstance(value, str) and SERVER_INSTANCE_PATTERN.fullmatch(value) is not None

def validate_browser_request(request, browser_root="/data/browser"):
    bot = request.get("bot")
    # Bounded so the scope unit name stays within systemd's limit (re-audit).
    if not isinstance(bot, str) or not re.fullmatch(r"[\w-]{1,64}", bot, flags=re.ASCII):
        raise ValueError("Invalid cloud browser identity")
    home = browser_root + "/" + bot
    mode = request.get("mode")
    if mode == "browser-cleanup":
        return {"user": "murage-browser", "home": home, "writable": [home], "args": [], "env": {}}
    if mode == "browser-host" and request.get("args") != HOST_WARMUP:
        raise ValueError("Invalid cloud browser arguments")
    args, settings = request.get("args"), request.get("settings", {})
    # r7: the requesting server's instance id. Grammar only here; the fence itself requires it (fails closed).
    if "instance" in request and not valid_instance(request["instance"]):
        raise ValueError("Invalid cloud browser server instance")
    if mode not in {"browser", "browser-host"} or not isinstance(args, list) or not all(isinstance(arg, str) and "\0" not in arg for arg in args):
        raise ValueError("Invalid cloud browser arguments")
    # Positive allowlist (GLM-5). Chrome flags, profile, executable and config
    # come only from the root-installed bundle, so the request may carry only the
    # exact agent-browser argv shapes the server builds (server/browser-engine.ts
    # and browser-native-relay.ts): the MCP server, --version, session close, and
    # the three native-relay commands. Anything else (including every
    # --remote-debugging-*, --load-extension, --user-data-dir, --proxy-server,
    # --no-sandbox, ... in either --flag=value or --flag value form) is refused.
    if not browser_args_allowed(args):
        raise ValueError("Invalid cloud browser arguments")
    allowed = {"AGENT_BROWSER_SESSION", "AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE_SAVE", "AGENT_BROWSER_RESTORE"}
    if not isinstance(settings, dict) or set(settings) - allowed:
        raise ValueError("Invalid cloud browser settings")
    session = settings.get("AGENT_BROWSER_SESSION", "")
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session):
        raise ValueError("Invalid cloud browser session")
    key = settings.get("AGENT_BROWSER_ENCRYPTION_KEY", "")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("Invalid cloud browser key")
    restore = settings.get("AGENT_BROWSER_RESTORE_SAVE", "never")
    if restore not in {"auto", "never"} or settings.get("AGENT_BROWSER_RESTORE", session) != session:
        raise ValueError("Invalid cloud browser restore")
    env = dict(settings)
    env.update(HOME=home, USERPROFILE=home, TMPDIR=home + "/tmp", XDG_CONFIG_HOME=home + "/.config", XDG_CACHE_HOME=home + "/.cache", XDG_DATA_HOME=home + "/.local/share", PATH="/usr/local/bin:/usr/bin:/bin",
               AGENT_BROWSER_SOCKET_DIR=home + "/sockets", AGENT_BROWSER_PROFILE=home + "/profile", AGENT_BROWSER_EXECUTABLE_PATH=BROWSER_CHROME,
               AGENT_BROWSER_HEADED="0", AGENT_BROWSER_NO_WEBMCP="1", AGENT_BROWSER_IDLE_TIMEOUT_MS="60000", AGENT_BROWSER_RESTORE_SAVE=restore)
    return {"user": "murage-browser", "home": home, "writable": [home], "args": args, "env": env}

def pinned_session_socket(home, session):
    """An O_PATH descriptor for the session socket, reached only through the
    pinned (never followed) sockets directory, or None when there is none. The
    root supervisor connects through it: no path is resolved at connect time."""
    try:
        dirfd = os.open(home + "/sockets", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        pfd = os.open(session + ".sock", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dirfd)
    except OSError:
        return None
    finally:
        os.close(dirfd)
    if not stat.S_ISSOCK(os.fstat(pfd).st_mode):
        os.close(pfd)
        raise ValueError("Invalid cloud browser socket")
    return pfd

def browser_close(home, session, timeout=5):
    pfd = pinned_session_socket(home, session)
    if pfd is None:
        return
    # One deadline for the whole exchange: a peer that drip-feeds its answer
    # cannot stretch `timeout` per socket operation.
    deadline = time.monotonic() + timeout
    def left():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Cloud browser close timed out")
        return remaining
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.settimeout(left())
            try:
                stream.connect("/proc/self/fd/%d" % pfd)
            except (ConnectionRefusedError, FileNotFoundError):
                return
            stream.settimeout(left())
            stream.sendall(b'{"id":"murage-close","action":"close"}\n')
            data = b""
            while b"\n" not in data:
                stream.settimeout(left())
                part = stream.recv(4096)
                if not part or len(data) + len(part) > 65536:
                    raise ValueError("Invalid cloud browser close response")
                data += part
    finally:
        os.close(pfd)
    result = json.loads(data.split(b"\n", 1)[0])
    if result.get("success") is not True or result.get("data", {}).get("closed") is not True:
        raise ValueError("Cloud browser did not close")

def session_pid(home, session):
    """The daemon pid agent-browser recorded for `session`, or None. The pid is
    in the namespace of the sandbox that started the daemon."""
    try:
        dirfd = os.open(home + "/sockets", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        fd = os.open(session + ".pid", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dirfd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            match = re.fullmatch(rb"\s*([1-9][0-9]{0,9})\s*", os.read(fd, 64))
        finally:
            os.close(fd)
    except OSError:
        return None
    finally:
        os.close(dirfd)
    return int(match.group(1)) if match else None

def session_alive(home, session, timeout=1.0):
    """True only when a live daemon accepts on the session socket. agent-browser's
    .sock/.pid files outlive a killed daemon (rig581), so a file is never proof:
    a listener that accepts is. The browser-writable sockets directory is pinned
    without following links and the socket is reached only through that pin."""
    try:
        dirfd = os.open(home + "/sockets", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return False
    try:
        try:
            pfd = os.open(session + ".sock", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dirfd)
        except OSError:
            return False
        try:
            if not stat.S_ISSOCK(os.fstat(pfd).st_mode):
                return False
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
                stream.settimeout(timeout)
                try:
                    stream.connect("/proc/self/fd/%d" % pfd)
                except OSError:
                    return False
                return True
        finally:
            os.close(pfd)
    finally:
        os.close(dirfd)

def trusted_session_file(root, bot, session, kind, flags, owner=0):
    """An fd for <root>/.<kind>-<bot>.<session> in the root-owned browser
    directory (0711), which no browser process can write: the session host's
    liveness lock ("live") and its activity clock ("active") live here, never
    in the browser-writable profile. Refused unless it is a single-link regular
    file owned by `owner` with no group/other write; raises OSError/ValueError."""
    if kind not in {"live", "active", "restore"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", bot) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session):
        raise ValueError("Invalid cloud browser session state")
    fd = os.open(root + "/." + kind + "-" + bot + "." + session, flags | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_mode & 0o022:
            raise ValueError("Invalid cloud browser session state")
        return fd
    except BaseException:
        os.close(fd)
        raise

def hold_host_live(root, bot, session, owner=0, wait=HOST_GUARD_WAIT, sleep=time.sleep):
    """The session's start guard (6.2): an exclusive flock the host's own root
    launcher takes before the sandbox starts and holds until the host exits
    (it waits on the sandbox; cleanup kills them together). At most one host per
    session, and only that host may start the daemon. Busy raises."""
    fd = trusted_session_file(root, bot, session, "live", os.O_RDWR | os.O_CREAT, owner)
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                raise BrowserSessionDown("Cloud browser session did not start")
            sleep(0.05)

def host_live(root, bot, session, owner=0):
    """True while a session host's launcher holds the live lock. Root-side only:
    a momentary shared lock that fails means it is held."""
    try:
        fd = trusted_session_file(root, bot, session, "live", os.O_RDONLY, owner)
    except (OSError, ValueError):
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    except OSError:
        return False
    finally:
        os.close(fd)  # also drops a shared lock taken above
    return False

def touch_host_activity(root, bot, session, owner=0):
    """Root-side: record real browser activity now on the host's trusted clock.
    Best effort (a refused file means no activity, so the host idles out)."""
    try:
        fd = trusted_session_file(root, bot, session, "active", os.O_WRONLY | os.O_CREAT, owner)
    except (OSError, ValueError):
        return
    try:
        os.utime(fd)
    except OSError:
        pass
    finally:
        os.close(fd)

def activity_toucher(touch, every=ACTIVITY_TOUCH_SEC, clock=time.monotonic):
    """`touch`, at most once per `every` seconds (pumps call it per chunk)."""
    last = [None]
    def throttled():
        now = clock()
        if last[0] is None or now - last[0] >= every:
            last[0] = now
            touch()
    return throttled

def open_host_activity(root, bot, session, owner=0):
    """The host's root launcher: create the trusted clock (now counts as
    activity) and keep it open read-only. The supervisor reads this descriptor
    for the host's whole life; no path is resolved again."""
    touch_host_activity(root, bot, session, owner)
    return trusted_session_file(root, bot, session, "active", os.O_RDONLY, owner)

def host_activity(fd):
    """The trusted clock's last activity through the supervisor's own
    descriptor (fstat: the inode it opened, whatever the path now names), or None."""
    try:
        return os.fstat(fd).st_mtime
    except OSError:
        return None

def pump_stdin(infd, outfd, before=None, touch=None, chunk=RELAY_CHUNK, framed=False, frame_max=MCP_FRAME_MAX):
    """Root side of a long-lived browser command: copies the caller's stdin into
    the sandbox. Relay bytes pass as chunks; MCP stdin is `framed`: newline-
    delimited JSON-RPC, and EVERY frame first passes `before` (a live host,
    started if needed) on its own, then counts as activity on the trusted clock.
    A frame waits for its newline; one over `frame_max` fails closed. `before`
    failing ends the pump with nothing further forwarded (a frame queued behind
    a refused one included), so the command's stdin closes."""
    pending = b""
    def forward(data):
        if before is not None:
            before()
        if touch is not None:
            touch()
        view = memoryview(data)
        while view:
            view = view[os.write(outfd, view):]
    try:
        while True:
            data = os.read(infd, chunk)
            if not data:
                return 0  # an unterminated frame is never dispatched: dropped
            if not framed:
                forward(data)
                continue
            pending += data
            if len(pending) > frame_max:
                return 1
            while True:
                cut = pending.find(b"\n")
                if cut < 0:
                    break
                frame, pending = pending[:cut + 1], pending[cut + 1:]
                forward(frame)
    except OSError:
        return 0  # the command stopped reading, or the caller went away
    except Exception:
        return 1  # no host could be started: forward nothing more
    finally:
        os.close(outfd)

def start_pump(before, touch, infd=0, framed=False):
    """Fork the root pump; this process's stdin becomes the pump's pipe, so the
    sandbox inherits it. The pump dies with this launcher (parent-death signal,
    armed and race-checked before the first byte). Returns the pump's pid."""
    readfd, writefd = os.pipe()
    parent = os.getpid()
    pid = os.fork()
    if pid == 0:
        code = 1
        try:
            os.close(readfd)
            arm_death_signal(parent)
            code = pump_stdin(infd, writefd, before, touch, framed=framed)
        finally:
            os._exit(code)
    os.close(writefd)
    os.dup2(readfd, infd)
    os.close(readfd)
    return pid

def stop_pump(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

def daemon_listening(home, session, table="/proc/net/unix"):
    """Whether a socket in this network namespace still listens on the session
    path, read without connecting (a probe connection would count as daemon
    activity). None when the table cannot be read: unknown is never "gone"."""
    path = home + "/sockets/" + session + ".sock"
    try:
        with open(table, encoding="utf-8", errors="replace") as stream:
            next(stream, None)
            for line in stream:
                fields = line.split()
                if len(fields) >= 8 and fields[7] == path and int(fields[3], 16) & 0x10000:
                    return True
    except (OSError, ValueError):
        return None
    return False

def require_session(home, session, alive=session_alive, pid=session_pid):
    """Per-command check (inside the command's own sandbox, whose pid namespace
    cannot see the host's): a recorded daemon pid AND a socket that accepts.
    Without it a client would answer from stale files (get cdp-url) or fork a
    daemon that dies with this sandbox (open). That a live host owns the session
    is checked root-side before the sandbox starts (host_live), where no
    browser process can forge it."""
    if pid(home, session) is None or not alive(home, session):
        raise BrowserSessionDown("Cloud browser session is not running")

def client_gate(home, session, args, require=require_session):
    """The in-sandbox gate before agent-browser runs: session clients must find
    the host's daemon."""
    if args in SESSION_CLIENT_ARGS or args[:2] == ["--json", "open"]:
        require(home, session)

def requires_host(args):
    """Commands that only ever run as clients of the host's daemon."""
    return args in SESSION_CLIENT_ARGS or args[:2] == ["--json", "open"] or args[:1] == ["mcp"]

def require_host(request, home, root=None, live=host_live, ensure=None, owner=0, start=True):
    """Root-side: a live session host for this request's session, started first
    (ensure_session_host) when `start`. Raises BrowserSessionDown otherwise."""
    root = root or BROWSER_ROOT
    bot, session = request["bot"], request["settings"]["AGENT_BROWSER_SESSION"]
    if live(root, bot, session, owner):
        return
    if start:
        (ensure or ensure_session_host)(request, home)
        if live(root, bot, session, owner):
            return
        raise BrowserSessionDown("Cloud browser session did not start")
    raise BrowserSessionDown("Cloud browser session is not running")

def pid_alive(pid):
    try:
        with open("/proc/%d/stat" % pid, encoding="ascii") as stream:
            return stream.read().rsplit(")", 1)[1].split()[0] not in {"Z", "X"}
    except (OSError, IndexError):
        return False

def reap_children():
    while True:
        try:
            if os.waitpid(-1, os.WNOHANG)[0] == 0:
                return
        except ChildProcessError:
            return

def kill_descendants(me=None, rounds=100):
    """SIGKILL and reap every remaining child until none is left. As a child
    subreaper every orphaned descendant becomes one, so this reaches Chrome
    processes a dead daemon left behind (bwrap's pid namespace teardown would
    too; this makes the host's own exit leave nothing either way)."""
    me = me or os.getpid()
    for _ in range(rounds):
        children = []
        for name in os.listdir("/proc"):
            if not name.isdigit() or int(name) == me:
                continue
            try:
                with open("/proc/" + name + "/stat", encoding="ascii", errors="replace") as stream:
                    if int(stream.read().rsplit(")", 1)[1].split()[1]) == me:
                        children.append(int(name))
            except (OSError, ValueError, IndexError):
                pass
        if not children:
            return
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        for pid in children:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

def host_failed(ready_fd):
    kill_descendants()
    try:
        os.write(ready_fd, b"failed\n")
    except OSError:
        pass
    return 1

def end_session(home, session, kill=None, close=browser_close, wait=HOST_CLOSE_WAIT):
    """The supervisor's end of the session (idle or cap): a bounded close so the
    daemon can save state, then `kill` for whatever is left, the daemon busy in
    a long command and a stopped host included."""
    try:
        close(home, session, timeout=wait)
    except Exception:
        pass  # a busy, hung or dead daemon: the kill ends it either way
    if kill is not None:
        kill()

def end_command(home, session, kill=None):
    """A command sandbox's end at idle or cap: its leaf's kill, nothing else
    (the daemon belongs to the host, whose own supervisor closes it)."""
    if kill is not None:
        kill()

BROWSER_SCOPE_PATTERN = re.compile(r"murage-browser-[\w-]{1,64}\.[0-9a-f]{8}\.scope", re.ASCII)

def own_cgroup(cgroup="/proc/self/cgroup", root=CGROUP_ROOT):
    """The cgroup v2 directory of this launch's own browser scope, from the
    root-only cgroup tree (pid-namespace independent, nothing a browser process
    can rename). Raises unless this process is in exactly such a scope."""
    with open(cgroup, encoding="ascii", errors="replace") as stream:
        lines = [line.rstrip("\n").split(":", 2) for line in stream]
    paths = [line[2] for line in lines if len(line) == 3 and line[0] == "0"]
    if len(paths) != 1 or not paths[0].startswith("/") or BROWSER_SCOPE_PATTERN.fullmatch(paths[0].rsplit("/", 1)[-1]) is None:
        raise ValueError("Cloud browser launch is not inside its scope")
    return root + paths[0]

class SandboxCgroup:
    """A launch's dedicated sandbox cgroup: the leaf `sandbox` under the
    launch's own scope, created by the root launcher before the sandbox exists
    and entered by the bwrap child before it drops privileges, so the child and
    everything it ever forks (bwrap's pid namespace, the daemon, Chrome, and any
    process a browser-uid client starts with a socket directory of its own) live
    in it and nothing else does: the launcher, its pump and its reaper stay in
    the scope's own cgroup. The scope's limits (MemoryMax, TasksMax, RuntimeMaxSec)
    charge the leaf too, so nothing inside escapes them. Ending it is one
    operation on the group, never a signal to a pid read from a listing: no pid
    reuse, nothing to hide from, nothing a stopped or busy process can delay."""
    def __init__(self, path):
        self.path = path

    @classmethod
    def create(cls, cgroup="/proc/self/cgroup", root=CGROUP_ROOT):
        path = own_cgroup(cgroup, root) + "/" + SANDBOX_CGROUP
        os.mkdir(path, 0o755)  # fresh per launch: an existing leaf is a launch that is not alone in its scope
        return cls(path)

    def _write(self, name, text):
        try:
            fd = os.open(self.path + "/" + name, os.O_WRONLY | os.O_CLOEXEC)
        except OSError:
            return False
        try:
            os.write(fd, text.encode("ascii"))
            return True
        except OSError:
            return False
        finally:
            os.close(fd)

    def _read(self, name):
        try:
            with open(self.path + "/" + name, encoding="ascii", errors="replace") as stream:
                return stream.read()
        except OSError:
            return None

    def enter(self):
        """Move the calling process (the bwrap child, still root) into the leaf."""
        if not self._write("cgroup.procs", "0"):
            raise OSError("Cloud browser sandbox cgroup refused the child")

    def procs(self):
        text = self._read("cgroup.procs")
        return [int(word) for word in text.split() if word.isdigit()] if text is not None else []

    def populated(self):
        """Whether anything lives in the leaf (cgroup.events), or None when unreadable."""
        text = self._read("cgroup.events")
        if text is None:
            return None
        for line in text.splitlines():
            if line.startswith("populated "):
                return line.split()[1] == "1"
        return None

    def empty(self):
        populated = self.populated()
        if populated is not None:
            return not populated
        return not any(pid_alive(pid) for pid in self.procs())

    def frozen(self):
        """Whether the kernel reports the leaf frozen (cgroup.events), or None when unreadable."""
        text = self._read("cgroup.events")
        if text is None:
            return None
        for line in text.splitlines():
            if line.startswith("frozen "):
                return line.split()[1] == "1"
        return None

    def kill(self, wait=SANDBOX_KILL_WAIT, sleep=time.sleep, monotonic=time.monotonic, report=None):
        """SIGKILL the whole leaf: cgroup.kill, one kernel operation that reaches
        every process in the group, those forked while it runs included. On a
        kernel without it the group is frozen first and the kernel's own word
        that it IS frozen (freezing is asynchronous) is awaited: only then can
        nothing in it run, fork or exit, so only then is its listing exact and
        no pid reusable; every member is signalled, and the group is thawed so
        the killed can exit. A leaf that never reports frozen is never signalled
        from a listing: that is refused and reported, and the caller's SIGKILL
        to its own unreaped child stays the only pid it touches. Waits, bounded,
        for the leaf to empty; True when it did (or no longer exists)."""
        if not os.path.isdir(self.path):
            return True
        deadline = monotonic() + wait
        if not self._write("cgroup.kill", "1"):
            frozen = self._write("cgroup.freeze", "1")
            while frozen and self.frozen() is not True:
                if monotonic() >= deadline:
                    frozen = False
                    break
                sleep(0.02)
            if not frozen:
                (report or (lambda text: sys.stderr.write(text + "\n")))("Cloud browser sandbox could not be frozen: its processes were not signalled")
                return False
            for pid in self.procs():
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            self._write("cgroup.freeze", "0")
        while not self.empty():
            if monotonic() >= deadline:
                return False
            sleep(0.02)
        return True

    def remove(self):
        try:
            os.rmdir(self.path)
        except OSError:
            pass  # still populated (the kill timed out) or already trimmed by systemd with the scope

def kill_sandbox(child, sandbox):
    """Root-side teardown of a launch's sandbox: the sandbox cgroup is killed as
    a whole (the bwrap child, its pid namespace, the daemon busy in a long
    command, a stopped host, a daemon a client started elsewhere: everything the
    child ever forked), the child itself (unreaped, so the pid is still its own)
    gets SIGKILL too, so the status below never waits on a kill that could not
    reach the tree, then its status is returned. SIGKILL from root reaches a
    stopped process and no browser process can block, delay or answer it."""
    sandbox.kill()
    try:
        os.kill(child, signal.SIGKILL)
    except OSError:
        pass
    try:
        return os.waitpid(child, 0)[1]
    except ChildProcessError:
        return 9

def start_reaper(sandbox):
    """Fork a root reaper that outlives this launcher: it holds the read end of
    a pipe whose write end only this launcher keeps (never inherited by the
    sandbox or the pump, closed on exec), and kills the sandbox cgroup when the
    pipe reaches EOF, that is, when this launcher is gone by any route, SIGKILL
    included (the kernel closes the descriptor). Unlike a parent-death signal
    this survives the sandbox child's exec and its AppArmor profile transition,
    which clears PDEATHSIG before bwrap re-arms it. Returns (pid, write end)."""
    readfd, writefd = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(writefd)
            for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGPIPE):
                signal.signal(number, signal.SIG_IGN)
            null = os.open(os.devnull, os.O_RDWR)
            for target in (0, 1, 2):
                os.dup2(null, target)
            os.closerange(3, readfd); os.closerange(readfd + 1, 1048576)
            while True:
                try:
                    if not os.read(readfd, 1):
                        break  # EOF: the launcher is gone
                except InterruptedError:
                    continue
                except OSError:
                    break
            sandbox.kill()
        finally:
            os._exit(0)
    os.close(readfd)
    return pid, writefd

def stop_reaper(reaper):
    """The launcher's orderly end: the reaper sees EOF, kills an already-killed
    (empty) leaf, and exits; its exit is awaited so nothing outlives the launch."""
    pid, writefd = reaper
    os.close(writefd)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

def supervise_session_host(child, home, session, activity_fd, sandbox=None, idle=HOST_IDLE_SEC, max_runtime=HOST_RUNTIME_MAX_SEC, poll=HOST_POLL,
                           clock=time.time, monotonic=time.monotonic, sleep=time.sleep, activity=host_activity, end=end_session, kill=kill_sandbox, ended=None):
    """The host's root launcher, outside the sandbox, waiting on its bwrap child
    with the session's clock (6.1). Activity is the trusted clock's mtime read
    through `activity_fd`, opened before the sandbox existed. After `idle`
    seconds without it, or at `max_runtime`, the session gets one bounded close
    and the sandbox cgroup is killed (`kill(child, sandbox)`); a host the daemon
    stopped, a daemon busy in a long command, nothing inside the sandbox can
    delay this. Returns the child's wait status. `ended(reason)` hears "sandbox"
    (it ended by itself), "idle" or "cap"."""
    started, last, reason = monotonic(), clock(), "sandbox"
    while True:
        done, status = os.waitpid(child, os.WNOHANG)
        if done:
            break
        if monotonic() - started >= max_runtime:
            reason = "cap"
            break
        now, stamp = clock(), activity(activity_fd)
        if stamp is not None and last < stamp <= now + 1:
            last = stamp  # a stamp from the future is ignored, never trusted
        if now - last >= idle:
            reason = "idle"
            break
        sleep(poll)
    if reason != "sandbox":
        holder = []
        end(home, session, kill=lambda: holder.append(kill(child, sandbox)))
        status = holder[0] if holder else kill(child, sandbox)
    if ended is not None:
        ended(reason)
    return status

def run_session_host(home, session, env, binary=BROWSER_BINARY, ready_fd=1, wait=HOST_READY_WAIT, poll=HOST_POLL, subreaper=None,
                     monotonic=time.monotonic, sleep=time.sleep, listening=daemon_listening, probe=session_alive, probe_every=HOST_PROBE_SEC, ended=None):
    """The host sandbox's main process (bwrap's pid 2), the cooperative part
    only: its root launcher holds the live lock and runs the clock and the kill
    (supervise_session_host). It starts the session daemon with the fixed
    warm-up client, reports "ready" or "failed" on ready_fd, then lives exactly
    as long as the daemon (6.3): it returns when the daemon exits, stops
    listening (an idle-expired daemon that lingers) or is replaced; its exit
    ends the sandbox. When the socket table cannot be read it falls back to a
    connect probe every `probe_every` seconds. Before returning it kills every
    descendant; as a child subreaper it reaps the orphaned daemon and Chrome
    processes itself. `ended(reason)` hears "daemon"."""
    (subreaper or (lambda: ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)))()
    if session_alive(home, session):
        # A daemon this host cannot own already answers: start nothing.
        return host_failed(ready_fd)
    null = os.open(os.devnull, os.O_RDWR)
    client = os.fork()
    if client == 0:
        try:
            for target in (0, 1, 2):
                os.dup2(null, target)
            os.closerange(3, 1048576)
            os.execve(binary, [binary] + HOST_WARMUP, env)
        finally:
            os._exit(127)
    deadline, status = time.monotonic() + wait, None
    while status is None:
        done, raw = os.waitpid(client, os.WNOHANG)
        if done:
            status = os.waitstatus_to_exitcode(raw)
        elif time.monotonic() > deadline:
            os.kill(client, signal.SIGKILL); os.waitpid(client, 0); status = -1
        else:
            time.sleep(0.05)
    daemon = session_pid(home, session)
    if status != 0 or daemon is None or not pid_alive(daemon) or not session_alive(home, session):
        return host_failed(ready_fd)
    try:
        os.write(ready_fd, b"ready\n")
    except OSError:
        return host_failed(ready_fd)  # the launcher gave up waiting: nothing outlives it
    os.dup2(null, ready_fd)  # the launcher stops reading after one line
    missing, probed = 0, None
    while True:
        reap_children()
        if not pid_alive(daemon) or session_pid(home, session) != daemon:
            break
        state = listening(home, session)
        if state is None:  # table unreadable: a connect probe, at most every probe_every s (two misses end it)
            if probed is None or monotonic() - probed >= probe_every:
                probed, state = monotonic(), probe(home, session)
        if state is not None:
            missing = missing + 1 if state is False else 0
        if missing >= 2:  # idle-expired, no longer serving: end with it
            break
        sleep(poll)
    kill_descendants()
    if ended is not None:
        ended("daemon")
    return 0

def spawn_session_host(request, lock, enter=None):
    """Start the session host in its own scope, detached from this launch (so it
    outlives the one-shot command) yet still a murage-browser-<bot>.<id>.scope
    that cleanup kills. The id's cleanup lock rides along on BROWSER_LOCK_FD
    until the host is inside its scope, as for every launch. Returns ready(wait)."""
    payload = {"mode": "browser-host", "bot": request["bot"], "args": HOST_WARMUP, "settings": request["settings"]}
    if "instance" in request:
        payload["instance"] = request["instance"]
    payload = json.dumps(payload).encode()
    plan = scope_plan(json.loads(payload))
    enter = enter or enter_scope
    readfd, writefd = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.setsid()
            if os.fork():
                os._exit(0)
            null = os.open(os.devnull, os.O_RDWR)
            os.dup2(null, 0); os.dup2(writefd, 1); os.dup2(null, 2)
            os.dup2(lock, BROWSER_LOCK_FD, inheritable=True)
            os.closerange(3, BROWSER_LOCK_FD); os.closerange(BROWSER_LOCK_FD + 1, 1048576)
            enter(payload, plan)
        finally:
            os._exit(1)
    os.close(writefd)
    os.waitpid(child, 0)
    def ready(wait):
        line, deadline = b"", time.monotonic() + wait
        try:
            while not line.endswith(b"\n") and len(line) < 64:
                left = deadline - time.monotonic()
                if left <= 0 or not select.select([readfd], [], [], left)[0]:
                    return False
                part = os.read(readfd, 64)
                if not part:
                    return False
                line += part
            return line == b"ready\n"
        finally:
            os.close(readfd)
    return ready

def ensure_session_host(request, home, root=None, alive=session_alive, spawn=spawn_session_host, wait=HOST_READY_WAIT, owner=0, fence=None, live=None, split=None):
    """Called by a root launch of `--json open` or `mcp` before its client runs,
    and by the MCP pump when a request finds no host. Concurrent starts of one bot
    serialize on the id's host lock; a live host (its root launcher holds the
    live lock) whose daemon answers is reused."""
    root = root or BROWSER_ROOT
    bot, session = request["bot"], request["settings"]["AGENT_BROWSER_SESSION"]
    live = live or (lambda: host_live(root, bot, session, owner))
    gate = browser_lock(root, bot, wait + 5, owner=owner, kind="host")
    try:
        if live() and alive(home, session):
            return
        lock = browser_lock(root, bot, owner=owner)
        try:
            if os.path.lexists(root + "/.cleanup-" + bot):
                raise ValueError("Cloud browser cleanup is pending")
            (fence or fence_server_instance)(request)
            # Every host generation starts from a split saved session (browser-restore modes).
            (split or split_for_host)(request, home, root, owner)
            ready = spawn(request, lock)
        finally:
            os.close(lock)
        # The host reports "failed" too when the warm-up found a daemon another
        # sandbox already serves: what counts for this command is a live host
        # and a socket that accepts. A host that misses the deadline ends on its
        # write to the closed pipe.
        ready(wait)
        if not (live() and alive(home, session)):
            raise BrowserSessionDown("Cloud browser session did not start")
    finally:
        os.close(gate)

def browser_namespace():
    path = "/usr/local/libexec/murage-browser-namespace"
    immutable_path(path, 0)
    loader = importlib.machinery.SourceFileLoader("browser_namespace", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec); loader.exec_module(module)
    return module


def browser_stop(home):
    # The helper cuts egress before its bounded namespace-local close request.
    browser_namespace().stop(os.path.basename(home), time.monotonic() + 12)

TURN_ROOT = "/run/murage-turn"
FD_TOKEN = "@fd:"

def seccomp_filter(path=SECCOMP_BPF):
    # Build-time BPF (murage-seccomp.c). Fail closed: a turn never runs unfiltered.
    # Root reads it here and materialises a copy in the per-turn directory,
    # because pasta closes every inherited descriptor above 2.
    immutable_path(path, 0)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size == 0 or info.st_size % 8:
            raise ValueError("Cloud turn seccomp filter is invalid")
        return stream.read()

def with_seccomp(argv, token):
    # The flag must be a bwrap option, so it goes before the "--" separator.
    split = argv.index("--")
    return argv[:split] + ["--seccomp", token] + argv[split:]

def pasta_argv(turn_dir):
    # pasta SPAWNS the sandbox (attaching to an existing bwrap netns fails with
    # EPERM on the real home), so the child command runs inside pasta's own
    # user+net namespace. No --map-host-loopback / --map-guest-addr (absent in
    # 20240220). --no-map-gw stops the gateway address mapping to host loopback,
    # so the only host loopback port a turn can reach is the explicit -T
    # forward. -t/-u/-U none: nothing from outside is forwarded into the turn.
    # DNS: the host resolv.conf holds only the 127.0.0.53 stub, which pasta
    # skips as a loopback nameserver once --no-map-gw is set. "-D 127.0.0.53"
    # names the resolver explicitly and "--dns-forward" makes pasta answer
    # PASTA_DNS:53 inside the turn by forwarding to it.
    return [PASTA, "--config-net", "--quiet", "--no-map-gw",
            "-t", "none", "-u", "none", "-U", "none", "-T", str(PASTA_HOST_PORT),
            # Verified on a real home: --dns-forward alone relays to the host
            # stub (127.0.0.53); adding -D 127.0.0.53 made every lookup
            # fail. Since A2 nft does not let the turn reach the stub: the
            # query is redirected by engine gid to that engine's synthetic
            # DNS forwarder (murage-egress-proxy dns, 127.0.0.1:53NN).
            "--dns-forward", PASTA_DNS,
            "--", "/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--pasta-child", turn_dir]

def write_turn_dir(argv, blobs, gid, root=TURN_ROOT, name=None):
    """Root: materialise everything the sandbox needs as files for the turn uid.

    Directory root:<turn group> 0750, files root:<turn group> 0640, inside the
    private mount namespace's tmpfs, so only the turn uid can read them and
    they vanish with the namespace. gid=None skips chown (tests)."""
    directory = root + "/" + (name or "t-" + secrets.token_hex(8))
    os.mkdir(directory, 0o750)
    if gid is not None:
        os.chown(directory, 0, gid)
    os.chmod(directory, 0o750)
    def put(filename, data):
        fd = os.open(directory + "/" + filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        try:
            os.write(fd, data)
            if gid is not None:
                os.fchown(fd, 0, gid)
            os.fchmod(fd, 0o640)
        finally:
            os.close(fd)
    for filename, data in blobs.items():
        put(filename, data if isinstance(data, bytes) else data.encode("utf-8"))
    put("plan.json", json.dumps({"argv": argv, "files": sorted(blobs)}).encode("utf-8"))
    return directory

def network_ready(route="/proc/self/net/route", route6="/proc/self/net/ipv6_route"):
    # pasta configures the tap, address and default route in its namespace.
    try:
        with open(route) as stream:
            for line in list(stream)[1:]:
                f = line.split()
                if len(f) > 7 and f[0] != "lo" and f[1] == "00000000" and f[7] == "00000000":
                    return True
        with open(route6) as stream:
            for line in stream:
                f = line.split()
                if len(f) > 9 and f[0] == "0" * 32 and f[1] == "00" and f[9] != "lo":
                    return True
    except OSError:
        pass
    return False

def load_turn_plan(directory, root=TURN_ROOT):
    # Everything here refuses by raising; the caller has not exec'd anything.
    if not isinstance(directory, str) or os.path.dirname(directory) != root or not re.fullmatch(r"t-[0-9a-f]{16}", os.path.basename(directory)):
        raise ValueError("Cloud turn plan directory is outside its grant")
    dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.path.realpath(directory) != directory:
            raise ValueError("Cloud turn plan directory must be real")
        info = os.fstat(dirfd)
        if info.st_uid == os.getuid() or info.st_mode & 0o022:
            raise ValueError("Cloud turn plan directory is writable by the turn")
        def read(filename):
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dirfd)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid == os.getuid() or st.st_mode & 0o022:
                os.close(fd)
                raise ValueError("Cloud turn plan file is writable by the turn")
            return fd
        with os.fdopen(read("plan.json"), "rb") as stream:
            plan = json.loads(stream.read(1024 * 1024 + 1))
        argv, names = plan.get("argv") if isinstance(plan, dict) else None, plan.get("files") if isinstance(plan, dict) else None
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and "\0" not in a for a in argv) or argv[0] != "/usr/bin/bwrap" or "--" not in argv:
            raise ValueError("Invalid cloud turn plan")
        if not isinstance(names, list) or len(names) > PLAN_FILES_MAX or not all(isinstance(n, str) and re.fullmatch(r"[a-z0-9]{1,16}", n) for n in names) or len(set(names)) != len(names):
            raise ValueError("Invalid cloud turn plan files")
        options = argv[:argv.index("--")]
        used = []
        for index, arg in enumerate(options):
            if arg.startswith(FD_TOKEN):
                before = options[index - 1] if index else ""
                if arg[len(FD_TOKEN):] not in names or before not in {"--seccomp", "--ro-bind-data"}:
                    raise ValueError("Invalid cloud turn plan descriptor")
                if before == "--ro-bind-data":
                    path = options[index + 1] if index + 1 < len(options) else ""
                    if path != "/etc/resolv.conf" and not path.startswith(("/data/engine-homes/", WORKSPACE_ROOT + "/")) and not RENDER_PATTERN.match(path):
                        raise ValueError("Cloud turn file is outside its grant")
                used.append(arg)
            elif arg == "--tmpfs" and not (index >= 2 and options[index - 2] == "--size" and re.fullmatch(r"[1-9][0-9]{0,12}", options[index - 1])):
                raise ValueError("Cloud turn plan tmpfs has no size cap")
            elif arg in {"--seccomp", "--ro-bind-data"} and not (index + 1 < len(options) and options[index + 1].startswith(FD_TOKEN)):
                raise ValueError("Invalid cloud turn plan descriptor")
        if options.count("--seccomp") != 1 or FD_TOKEN + "seccomp" not in used or any(a in {"--unshare-net", "--info-fd", "--block-fd"} for a in options):
            raise ValueError("Cloud turn plan is missing its seccomp filter")
        return dirfd, argv, names, read
    except BaseException:
        os.close(dirfd)
        raise

def pasta_child(directory, root=TURN_ROOT, route="/proc/self/net/route", route6="/proc/self/net/ipv6_route", execv=os.execv, uid_map="/proc/self/uid_map", turn_uid=None):
    """Runs inside pasta's user+net namespace. The ONLY path to bwrap.

    Any refusal raises before execv, so the sandboxed command never starts."""
    # pasta's user namespace maps the turn user to uid 0, so a namespace-local
    # uid check cannot tell it from real root. Require exactly pasta's single
    # mapping of the turn user's real uid; real root (the initial namespace)
    # maps the whole range and is refused.
    if turn_uid is None:
        turn_uid = pwd.getpwnam("murage-turn").pw_uid
    with open(uid_map) as stream:
        mapping = [line.split() for line in stream if line.strip()]
    if mapping != [["0", str(turn_uid), "1"]]:
        raise ValueError("Cloud turn plan must run as the turn user inside pasta")
    dirfd, argv, names, read = load_turn_plan(directory, root)
    try:
        if not network_ready(route, route6):
            raise OSError("Cloud turn network setup failed")
        fds = {}
        for name in names:
            fd = read(name)
            os.set_inheritable(fd, True)  # bwrap reads it after exec
            fds[FD_TOKEN + name] = str(fd)
        split = argv.index("--")
        argv = [fds.get(a, a) for a in argv[:split]] + argv[split:]
    finally:
        os.close(dirfd)
    execv(argv[0], argv)
    raise OSError("Cloud turn sandbox did not start")

def browser_mount_args(mounts, home, args, resolver=None, host=False, sockets=None):
    # bwrap owns its pid namespace, so the userns that mounts /proc owns it.
    # Chromium builds its own user/pid/net sandbox, so this argv deliberately has
    # no --disable-userns and no --seccomp; the murage-browser AppArmor profile
    # (via murage-browser-bwrap) grants the browser sandbox its user namespaces.
    argv = [BROWSER_BWRAP, "--unshare-user", "--unshare-pid", "--die-with-parent", "--unshare-ipc", "--unshare-uts", "--new-session", "--cap-drop", "ALL"]
    for path in ["/usr", "/bin", "/lib", "/lib64", "/opt/murage", "/etc/ssl", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"]:
        if os.path.exists(path):
            argv += ["--ro-bind", path, path]
    if resolver is not None:
        argv += ["--ro-bind-data", str(resolver), "/etc/resolv.conf"]
    argv += ["--proc", "/proc", "--dev", "/dev"]
    # The home's ancestors are the sandbox user's own in bwrap's root tmpfs: a
    # process could rename /data/browser away and recreate the socket pathname
    # writable beside the real one. So /data is its own tmpfs, remounted
    # read-only once the home is bound into it: /data is a mount point (rename
    # fails with EBUSY) and /data/browser sits in a read-only mount (EROFS).
    # The read-only flag is locked for any user namespace the browser creates.
    argv += ["--tmpfs", "/data"]
    for source, path in mounts:
        argv += ["--bind", source, path]
    argv += ["--remount-ro", "/data"]
    argv += ["--symlink", home + "/tmp", "/tmp"]
    if not host:
        # Only the host's sandbox may bring the session daemon up: every other
        # sandbox sees the socket directory (where the daemon binds its socket
        # and writes .pid/.cdp) read-only, stacked over the writable profile.
        # connect() to a unix socket works on a read-only mount; bind() does not.
        # The source is root-pinned (open_directory, never a link) and anchored.
        if not sockets:
            raise ValueError("Cloud browser command needs its session directory")
        argv += ["--ro-bind", sockets, home + "/sockets"]
    return argv + ["--chdir", home, "--", "/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--browser-host" if host else "--browser-child", json.dumps({"home": home, "args": args})]

def erase_browser_tree(target, uid, gid):
    child = os.fork()
    if child == 0:
        try:
            os.setgroups([]); os.setgid(gid); os.setuid(uid)
            shutil.rmtree(target)
            os._exit(0)
        except Exception:
            os._exit(1)
    _, status = os.waitpid(child, 0)
    if status != 0:
        raise ValueError("Cloud browser cleanup failed")

def cleanup_browser(root, bot, uid, gid, erase=erase_browser_tree, stop=browser_stop):
    plan = validate_browser_request({"mode": "browser-cleanup", "bot": bot}, root)
    home, staging = plan["home"], root + "/.cleanup-" + bot
    target = staging + "/profile"
    if os.path.lexists(home):
        info = os.lstat(home)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700 or os.path.lexists(target):
            raise ValueError("Invalid cloud browser profile")
        stop(home)
        if not os.path.lexists(staging):
            os.mkdir(staging, 0o700); os.chown(staging, uid, gid)
        info = os.lstat(staging)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Invalid cloud browser quarantine")
        os.rename(home, target)
    if not os.path.lexists(staging):
        return
    info = os.lstat(staging)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Invalid cloud browser quarantine")
    if os.path.lexists(target):
        info = os.lstat(target)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
            raise ValueError("Invalid cloud browser quarantine")
        erase(target, uid, gid)
    # A failed or interrupted erase leaves this deterministic identity. Retry
    # cannot mistake missing original HOME for success or sweep another bot.
    os.rmdir(staging)

BROWSER_ROOT = "/data/browser"
BROWSER_LOCK_FD = 7        # inherited across the exec into systemd-run; closed once the scope is entered
BROWSER_LOCK_BUSY = 75     # EX_TEMPFAIL: another launch or cleanup of this id holds the lock
BROWSER_LOCK_WAIT = 5.0

BROWSER_STALE_INSTANCE = 76  # a newer server process owns this home: the request is refused, nothing launched
INSTANCE_DIR = "/data/server-home"
INSTANCE_NAME = ".server-instance"
INSTANCE_MAX = 65            # token (<= 64) plus one newline

class BrowserLockBusy(Exception):
    pass

class StaleServerInstance(Exception):
    pass

def read_current_instance(directory=INSTANCE_DIR, name=INSTANCE_NAME, owner=None):
    """The current server instance id, from a file only the app user can write.

    Strict: the directory and file must be owned by the app user and not writable by
    anyone else, the final component is opened with O_NOFOLLOW (no symlink), the file
    is a regular single-link file of bounded size, and the content is exactly one
    token and a newline. Anything else raises ValueError, never a guess."""
    if owner is None:
        owner = pwd.getpwnam("murage").pw_uid
    dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(dirfd)
        if info.st_uid != owner or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError("Invalid cloud server instance directory")
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dirfd)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o022 or info.st_size > INSTANCE_MAX:
                raise ValueError("Invalid cloud server instance file")
            data = os.read(fd, INSTANCE_MAX + 1)
        finally:
            os.close(fd)
    finally:
        os.close(dirfd)
    match = re.fullmatch(rb"([A-Za-z0-9_-]{22,64})\n", data)
    if not match:
        raise ValueError("Invalid cloud server instance")
    return match.group(1).decode("ascii")

def fence_server_instance(request, **where):
    """Called with the id's lock held, before the scope is entered. Raises StaleServerInstance
    when the requesting server is not the current one; ValueError when the request or file is bad."""
    requested = request.get("instance")
    if not valid_instance(requested):
        raise ValueError("Invalid cloud browser server instance")
    if requested != read_current_instance(**where):
        raise StaleServerInstance()

def browser_lock(root, bot, wait=BROWSER_LOCK_WAIT, sleep=time.sleep, owner=0, kind="lock"):
    """Exclusive per-id lock on a root-only file in the root-owned browser dir.

    flock belongs to the open file description, so it outlives a killed sudo
    wrapper while the root child runs and is released by the kernel when the
    last holder exits. A bounded non-blocking retry; busy raises BrowserLockBusy,
    which the app must treat as "not yet clean", never as clean."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", bot):
        raise ValueError("Invalid cloud browser identity")
    if kind not in {"lock", "host"}:  # host: serializes session-host starts, never cleanup
        raise ValueError("Invalid cloud browser lock")
    fd = os.open(root + "/." + kind + "-" + bot, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1:
            raise ValueError("Invalid cloud browser lock")
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BrowserLockBusy()
                sleep(0.05)
    except BaseException:
        os.close(fd)
        raise

def hold_prescope_lock(bot):
    os.makedirs(BROWSER_ROOT, mode=0o711, exist_ok=True)
    lock = browser_lock(BROWSER_ROOT, bot)
    os.dup2(lock, BROWSER_LOCK_FD, inheritable=True)
    os.close(lock)

def release_prescope_lock():
    os.closerange(BROWSER_LOCK_FD, BROWSER_LOCK_FD + 1)  # never raises on a closed descriptor

def locked_browser_cleanup(root, bot, uid, gid, home, wait=BROWSER_LOCK_WAIT, owner=0, stop=browser_stop, erase=erase_browser_tree):
    lock = browser_lock(root, bot, wait, owner=owner)
    try:
        stop(home)
        cleanup_browser(root, bot, uid, gid, erase=erase, stop=lambda _home: None)
    finally:
        os.close(lock)

def launch_browser(request):
    plan = validate_browser_request(request)
    account = pwd.getpwnam(plan["user"])
    root, home = "/data/browser", plan["home"]
    os.makedirs(root, mode=0o711, exist_ok=True)
    parent = os.lstat(root)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) != 0o711:
        raise ValueError("Invalid cloud browser directory")
    if request["mode"] == "browser-cleanup":
        # The whole transaction runs under the id's lock: cleanups never overlap
        # and never interleave with a launch's pre-scope window.
        locked_browser_cleanup(root, request["bot"], account.pw_uid, account.pw_gid, home)
        return
    if os.path.lexists(root + "/.cleanup-" + request["bot"]):
        raise ValueError("Cloud browser cleanup is pending")
    if not os.path.lexists(home):
        os.mkdir(home, 0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
    directory = os.lstat(home)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != account.pw_uid or stat.S_IMODE(directory.st_mode) != 0o700:
        raise ValueError("Invalid cloud browser profile")
    sockets = home + "/sockets"
    if not os.path.lexists(sockets):
        os.mkdir(sockets, 0o700)
        os.chown(sockets, account.pw_uid, account.pw_gid)
    directory = os.lstat(sockets)  # a link or a file planted here refuses the launch; open_directory never follows
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != account.pw_uid:
        raise ValueError("Invalid cloud browser profile")
    # Verify (hash or digest-cache hit) exactly once per launch; the in-join
    # check only re-compares the file identity recorded here.
    stamps = {}
    command = manifest_command("browser", BROWSER_BINARY, stamps=stamps)
    manifest_command("browser", BROWSER_CHROME, stamps=stamps)
    namespace = browser_namespace()
    # FD3 JSON was already parsed. A fresh sanitized helper exec erases its
    # key material before persistent forks, and precedes any profile anchors.
    namespace.ensure(request["bot"])
    bot, session, args = request["bot"], request["settings"]["AGENT_BROWSER_SESSION"], plan["args"]
    host = request["mode"] == "browser-host"
    live = activity = pump = wait = reaper = None
    # Every launch's sandbox lives in its own cgroup leaf under this launch's
    # scope, created here by root before the sandbox exists and entered by the
    # bwrap child before it drops privileges: it ends as a whole when the
    # command ends, at idle or cap (the host), or when this launcher dies (the
    # reaper below). A daemon a client starts with a socket directory of its
    # own dies with the command's leaf and never outlives it or escapes the
    # scope's limits. Fail closed: no leaf, no launch.
    sandbox = SandboxCgroup.create()
    if host:
        # Held by this root launcher until the host's sandbox exits (6.2).
        live = hold_host_live(root, bot, session)
    elif requires_host(args):
        # The daemon must not be born in this command's sandbox (rig581):
        # open and MCP start the host, the other clients need it live (H1).
        require_host(request, home, start=args[:2] == ["--json", "open"] or args[:1] == ["mcp"])
    # The session's clock (6.1): every launch, the host's and each command's
    # (the MCP server's and the relays' included), is supervised by this root
    # launcher on the same trusted clock, opened here before the sandbox
    # exists (opening it is this launch's own activity stamp) and read nowhere
    # else: 5 min without real activity, or 6 h, ends the sandbox's whole leaf.
    # A daemon a client keeps alive in an MCP sandbox therefore lives exactly
    # as long as the session is in use, like the host's. Only the host's end
    # closes the daemon first; a command's end is its leaf's kill alone.
    activity = open_host_activity(root, bot, session)
    wait = lambda child: supervise_session_host(child, home, session, activity, sandbox, end=end_session if host else end_command)
    if not host:
        if args[:1] == ["mcp"] or args[:1] == ["relay"]:
            # Root pump in front of stdin: relay chunks and MCP frames are activity
            # on the trusted clock, and every MCP frame first needs a live host,
            # started on demand (one gate per frame, fail closed).
            mcp = args[:1] == ["mcp"]
            before = (lambda: require_host(request, home)) if mcp else None
            pump = start_pump(before, activity_toucher(lambda: touch_host_activity(root, bot, session)), framed=mcp)
    launcher = os.getpid()
    def prepare(resolver):
        private_mount_namespace()
        pins = [(open_directory(home), home)]
        if not host:
            pins.append((open_directory(sockets), sockets))
        mounts = anchor_mounts(pins)
        return browser_mount_args(mounts[:1], home, args, resolver, host=host, sockets=None if host else mounts[1][0])
    def validate():
        # Runs in the unprivileged child just before exec: cheap path and
        # identity checks only, never a second full-file hash. After the uid
        # drop: the sandbox dies with this launcher (bwrap's --die-with-parent
        # pid 1 then dies with bwrap, and the pid namespace with it).
        for path, stamp in stamps.items():
            recheck_stamp(path, stamp)
        arm_death_signal(launcher)
    try:
        reaper = start_reaper(sandbox)  # after the pump: the pump never holds the reaper's pipe
        status = namespace.join(request["bot"], prepare, account, plan["env"], validate, wait=wait, enter=sandbox.enter)
    finally:
        # The command's end: whatever the sandbox left behind (a lingering
        # Chrome, a daemon born in this command's sandbox) ends with its leaf.
        sandbox.kill()
        if reaper is not None:
            stop_reaper(reaper)
        sandbox.remove()
        if pump is not None:
            stop_pump(pump)
        for fd in (live, activity):
            if fd is not None:
                os.close(fd)
    sys.exit(status if status >= 0 else 128 - status)

# The saved browser session (server/browser-restore-store.ts). The home server cannot read
# /data/browser/<bot>, so the launcher runs the store's steps as the browser user and hands the
# answer back on stdout. The rules live in one place: this launcher runs the server's own bundled
# step (server/browser-restore-cli.ts, pinned in the engine manifest as "browserRestore"), it holds
# no copy of them.
#
# Generations: every browser host (ensure_session_host) starts from a freshly split saved session,
# whoever starts it, the server or the MCP pump after an idle exit. The split gets a generation id,
# kept root-side next to the host's live lock (.restore-<bot>.<session>: "<32 hex> split|hosted").
# The server reads the current generation's snapshot (browser-restore) and every visit mark names the
# generation it belongs to (browser-restore-mark): a mark from an obsolete generation is answered
# "stale" and never written, so it can never make a later merge drop storage the new run never touched.
#
# Isolation: every step runs in its own mount and pid namespace (run_browser_restore_step) that holds
# only this bot's browser home, bound from a descriptor opened without following links, over an empty
# /data/browser, with its own /proc and /tmp. All bots share the browser uid, so this, not a path
# check, is what keeps a link or a rename planted by the sandboxed browser from reaching another bot.
# The server-asked modes run in their own limited scope (scope_plan) and the step's whole tree ends at
# its deadline; the step refuses oversize input itself (browser-restore-cli.ts).
BROWSER_RESTORE_MODES = frozenset({"browser-restore", "browser-restore-mark"})
BROWSER_RESTORE_KEYS = frozenset({"mode", "bot", "args", "settings", "instance"})
BROWSER_RESTORE_SETTINGS = frozenset({"AGENT_BROWSER_SESSION", "AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE_SAVE", "AGENT_BROWSER_RESTORE"})
BROWSER_RESTORE_SCRIPT = "browser-restore-cli"
BROWSER_RESTORE_OUTPUT_MAX = 32 * 1024 * 1024  # a long-used profile's saved storage, as JSON
BROWSER_RESTORE_WAIT = 25.0
BROWSER_RESTORE_HEAP_MB = 512
BROWSER_RESTORE_SCOPE_PROPERTIES = ["TasksMax=64", "MemoryMax=768M", "TimeoutStopSec=5", "BindsTo=murage-home.service", "After=murage-home.service", "RuntimeMaxSec=90"]
BROWSER_RESTORE_GENERATION = re.compile(r"[a-f0-9]{32}", re.ASCII)
CLONE_NEWNS, CLONE_NEWPID = 0x00020000, 0x20000000
MS_NOSUID, MS_NODEV, MS_NOEXEC, MS_BIND, MS_REC, MS_PRIVATE = 2, 4, 8, 4096, 16384, 262144
# An origin as the browser names it (location.origin): scheme, host and an optional port. Nothing else.
BROWSER_RESTORE_ORIGIN = re.compile(r"https?://(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::([0-9]{1,5}))?", re.ASCII)
BROWSER_RESTORE_ORIGIN_MAX = 300

def browser_restore_origin(value):
    if not isinstance(value, str) or len(value) > BROWSER_RESTORE_ORIGIN_MAX:
        return False
    match = BROWSER_RESTORE_ORIGIN.fullmatch(value)
    return match is not None and (match.group(1) is None or 1 <= int(match.group(1)) <= 65535)

def validate_browser_restore_request(request, browser_root="/data/browser"):
    """{"mode":"browser-restore","args":[]} or {"mode":"browser-restore-mark","args":[<generation>, <origin>]},
    with the bot, the server instance and the session settings every browser request carries. Strict: no
    other key, no other setting, the key a 64-character hex string, restore on. Returns the plan the step runs."""
    if not isinstance(request, dict) or set(request) != BROWSER_RESTORE_KEYS or request["mode"] not in BROWSER_RESTORE_MODES:
        raise ValueError("Invalid cloud browser restore request")
    bot = request["bot"]
    if not isinstance(bot, str) or not re.fullmatch(r"[\w-]{1,64}", bot, flags=re.ASCII):
        raise ValueError("Invalid cloud browser identity")
    if not valid_instance(request["instance"]):
        raise ValueError("Invalid cloud browser server instance")
    args, mark = request["args"], request["mode"] == "browser-restore-mark"
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args) or (len(args) != 2 or not BROWSER_RESTORE_GENERATION.fullmatch(args[0]) or not browser_restore_origin(args[1]) if mark else args != []):
        raise ValueError("Invalid cloud browser restore arguments")
    settings = request["settings"]
    if not isinstance(settings, dict) or not {"AGENT_BROWSER_SESSION", "AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE_SAVE"} <= set(settings) <= BROWSER_RESTORE_SETTINGS:
        raise ValueError("Invalid cloud browser settings")
    session, key = settings["AGENT_BROWSER_SESSION"], settings["AGENT_BROWSER_ENCRYPTION_KEY"]
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", session, flags=re.ASCII):
        raise ValueError("Invalid cloud browser session")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key, flags=re.ASCII):
        raise ValueError("Invalid cloud browser key")
    if settings["AGENT_BROWSER_RESTORE_SAVE"] != "auto" or settings.get("AGENT_BROWSER_RESTORE", session) != session:
        raise ValueError("Invalid cloud browser restore")
    home = browser_root + "/" + bot
    # The step's whole environment: these five names, nothing is inherited.
    env = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "AGENT_BROWSER_RESTORE": session,
           "AGENT_BROWSER_ENCRYPTION_KEY": key, "AGENT_BROWSER_RESTORE_SAVE": "auto"}
    return {"user": "murage-browser", "bot": bot, "home": home, "session": session, "mark": mark, "generation": args[0] if mark else None,
            "argv": ["mark", args[1]] if mark else ["prepare"], "env": env}

def browser_restore_script(manifest_path=ENGINE_MANIFEST, manifest_uid=0, cache_root=None, node=None, script_root=None):
    """The step's bundled script, root-owned, immutable and matching its manifest digest
    (engine-manifest.json "browserRestore"), under the verified node: the checks proxy_script makes."""
    cache_root = DIGEST_CACHE if cache_root is None else cache_root
    path = (script_root or MCP_PROXY_ROOT) + "/" + BROWSER_RESTORE_SCRIPT + ".js"
    try:
        real = immutable_path(path, manifest_uid)
        immutable_path(node or NODE, manifest_uid)
    except FileNotFoundError:
        raise Refusal("Cloud browser restore step is missing")
    immutable_path(manifest_path, manifest_uid)
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != manifest_uid or info.st_mode & 0o022:
            raise Refusal("Cloud engine manifest must be root-owned and immutable")
        manifest = json.load(stream)
    entries = manifest.get("browserRestore") if isinstance(manifest, dict) else None
    entry = next((item for item in entries if isinstance(item, dict) and item.get("path") == path), None) if isinstance(entries, list) else None
    if not entry or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64:
        raise Refusal("Cloud browser restore step is not listed")
    fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != manifest_uid or info.st_mode & 0o022:
            raise Refusal("Cloud browser restore step is not immutable")
        stamp = file_stamp(info)
        if not cached_digest(cache_root, manifest_uid, real, stamp, entry["sha256"]):
            if hash_stream(stream) != entry["sha256"]:
                raise Refusal("Cloud browser restore step digest mismatch")
            store_digest(cache_root, manifest_uid, real, stamp, entry["sha256"])
    return path

def browser_restore_home(home, uid):
    """True when the bot's browser home and its saved-session directories are the browser user's own plain
    directories (never a link, never another owner); False when there is no home yet. Anything else raises:
    the sandboxed browser can plant a link in its own home, and the step must never follow one out of it."""
    try:
        info = os.lstat(home)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Invalid cloud browser profile")
    current = home
    for part in (".agent-browser", "sessions"):
        current += "/" + part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            return True
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
            raise ValueError("Invalid cloud browser profile")
    return True

def read_restore_generation(root, bot, session, owner=0):
    """(generation, "split" | "hosted") last recorded for this session, or None. Root-side only: the file sits
    in the root-owned browser directory, beside the host's live lock, where no browser process can write."""
    try:
        fd = trusted_session_file(root, bot, session, "restore", os.O_RDONLY, owner)
    except (OSError, ValueError):
        return None
    try:
        data = os.read(fd, 64)
    finally:
        os.close(fd)
    match = re.fullmatch(rb"([a-f0-9]{32}) (split|hosted)\n", data)
    return (match.group(1).decode("ascii"), match.group(2).decode("ascii")) if match else None

def write_restore_generation(root, bot, session, generation, state, owner=0):
    if not BROWSER_RESTORE_GENERATION.fullmatch(generation) or state not in {"split", "hosted"}:
        raise ValueError("Invalid cloud browser restore generation")
    fd = trusted_session_file(root, bot, session, "restore", os.O_WRONLY | os.O_CREAT, owner)
    try:
        os.ftruncate(fd, 0)
        os.write(fd, (generation + " " + state + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)

def drop_restore_generation(root, bot, session):
    """No current generation: marks are stale and a snapshot has nothing to read until the next split."""
    try:
        os.unlink(root + "/.restore-" + bot + "." + session)
    except FileNotFoundError:
        pass

def confine_restore_step(plan, root, uid, libc=None):
    """In the step's root child, already in its own mount namespace: nothing propagates out, /data/browser
    (root) is an empty tmpfs holding only this bot's home, bound from a descriptor opened without following
    a link (so a rename or link the browser planted meanwhile binds nothing else), and /tmp, /var/tmp and
    /dev/shm are private. Returns the home's path inside the namespace."""
    libc = libc or ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    def mount(source, target, kind, flags, data):
        if libc.mount(source, target.encode(), kind, flags, data) != 0:
            raise OSError(ctypes.get_errno(), "Cloud browser restore mount failed")
    mount(None, "/", None, MS_REC | MS_PRIVATE, None)
    home = os.open(plan["home"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(home)
        if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Invalid cloud browser profile")
        mount(b"tmpfs", root, b"tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, b"mode=0711,size=64k")
        target = root + "/" + plan["bot"]
        os.mkdir(target, 0o700)
        mount(("/proc/self/fd/%d" % home).encode(), target, None, MS_BIND, None)
    finally:
        os.close(home)
    for path in ("/tmp", "/var/tmp", "/dev/shm"):
        if os.path.isdir(path) and not os.path.islink(path):
            mount(b"tmpfs", path, b"tmpfs", MS_NOSUID | MS_NODEV, b"mode=1777,size=1m")
    return target

def run_browser_restore_step(plan, argv, node, script, uid, gid, wait=BROWSER_RESTORE_WAIT, limit=BROWSER_RESTORE_OUTPUT_MAX, drop=True,
                             isolate=True, root=BROWSER_ROOT):
    """node script <argv> as the browser user with the plan's environment and nothing else, working in the
    pinned home, stdin and stderr closed, stdout read back (bounded, with a deadline). Returns the bytes.

    The child below is the step's whole tree: a session of its own and, isolated (always, outside tests),
    new mount and pid namespaces whose init is the step (confine_restore_step). At the deadline, or past
    the output bound, that child is killed: its init then gets its parent-death signal, and the kernel ends
    every process in the namespace with it, a forked or detached one included."""
    readfd, writefd = os.pipe()
    parent = os.getpid()
    child = os.fork()
    if child == 0:
        try:
            os.close(readfd)
            os.setsid()
            arm_death_signal(parent)
            home = plan["home"]
            if isolate:
                libc = ctypes.CDLL(None, use_errno=True)
                libc.unshare.argtypes = [ctypes.c_int]
                if libc.unshare(CLONE_NEWNS | CLONE_NEWPID) != 0:
                    os._exit(1)
                home = confine_restore_step(plan, root, uid, libc)
            middle = os.getpid()
            # Held open by the middle child for its whole life: the step's race check that the middle is still
            # there once its death signal is armed (from inside the new pid namespace getppid() is 0).
            alive_read, alive_write = os.pipe()
            step = os.fork()
            if step == 0:
                try:
                    os.close(alive_write)
                    if isolate:
                        libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
                        if libc.mount(b"proc", b"/proc", b"proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, None) != 0:
                            os._exit(1)
                    pinned = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                    os.fchdir(pinned)
                    null = os.open(os.devnull, os.O_RDWR)
                    os.dup2(null, 0); os.dup2(writefd, 1); os.dup2(null, 2)
                    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                    if drop:
                        os.setgroups([]); os.setgid(gid); os.setuid(uid)
                        if os.getuid() == 0 or os.geteuid() == 0:
                            os._exit(1)
                    # After the uid drop (commit_creds clears the setting): die with the middle child.
                    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0):
                        os._exit(1)
                    if select.select([alive_read], [], [], 0)[0]:
                        os._exit(1)  # the middle is already gone: its end of the pipe closed
                    maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
                    os.closerange(3, maximum if maximum != resource.RLIM_INFINITY else 1048576)
                    os.execve(node, [node, "--max-old-space-size=%d" % BROWSER_RESTORE_HEAP_MB, script] + argv, plan["env"])
                finally:
                    os._exit(1)
            os.close(alive_read)
            os.close(writefd)
            _, status = os.waitpid(step, 0)
            os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
        finally:
            os._exit(1)
    os.close(writefd)
    chunks, size, failed = [], 0, False
    deadline = time.monotonic() + wait
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([readfd], [], [], left)[0]:
                failed = True
                break
            part = os.read(readfd, 1024 * 1024)
            if not part:
                break
            size += len(part)
            if size > limit:
                failed = True
                break
            chunks.append(part)
    finally:
        os.close(readfd)
        if failed:
            for kill in (lambda: os.killpg(child, signal.SIGKILL), lambda: os.kill(child, signal.SIGKILL)):
                try:
                    kill()
                except (ProcessLookupError, PermissionError):
                    pass
        _, status = os.waitpid(child, 0)
    if failed or status != 0:
        raise Refusal("Cloud browser restore failed")
    return b"".join(chunks)

def restore_step(plan, argv, account, node=None, script=None, **options):
    node = node or NODE
    script = script or browser_restore_script(node=node)
    return run_browser_restore_step(plan, argv, node, script, account.pw_uid, account.pw_gid, **options)

def launch_browser_restore(request, root=BROWSER_ROOT, account=None, fence=None, alive=session_alive, live=host_live, owner=0,
                           node=None, script=None, drop=True, out=None, wait=BROWSER_RESTORE_WAIT, limit=BROWSER_RESTORE_OUTPUT_MAX, isolate=True):
    """Runs one restore step for the bot under the id's lock (so no browser launch, host start or cleanup of the
    same id overlaps it), fenced to the current server instance. Writes the step's one JSON line to `out`.

    browser-restore: a running host (or a split no host has used yet) answers its generation's snapshot,
    read only; with no host it splits now and records a new generation, which the next host start takes
    over without splitting again. A running session's daemon is never split under.
    browser-restore-mark: only for the current generation, else {"state":"stale"} and nothing is written."""
    plan = validate_browser_restore_request(request, root)
    account = account or pwd.getpwnam(plan["user"])
    out = out or sys.stdout.buffer
    bot, session = request["bot"], plan["session"]
    nothing = b'{"state":"none","logs":[]}\n'
    stale = b'{"state":"stale"}\n'
    if not os.path.lexists(root):
        out.write(stale if plan["mark"] else nothing); out.flush()
        return
    parent = os.lstat(root)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or stat.S_IMODE(parent.st_mode) != 0o711:
        raise ValueError("Invalid cloud browser directory")
    step = lambda argv: restore_step(plan, argv, account, node, script, wait=wait, limit=limit, drop=drop, isolate=isolate, root=root)
    lock = browser_lock(root, bot, owner=owner)
    try:
        (fence or fence_server_instance)(request)
        if os.path.lexists(root + "/.cleanup-" + bot):
            raise ValueError("Cloud browser cleanup is pending")
        current = read_restore_generation(root, bot, session, owner)
        if plan["mark"]:
            if current is None or current[0] != plan["generation"]:
                data = stale
            elif not browser_restore_home(plan["home"], account.pw_uid):
                raise Refusal("Cloud browser restore has no store to mark")
            else:
                data = step(plan["argv"])
        elif not browser_restore_home(plan["home"], account.pw_uid):
            data = nothing
        elif live(root, bot, session, owner) or alive(plan["home"], session) or (current and current[1] == "split"):
            data = step(["snapshot", current[0]]) if current else nothing
        else:
            generation = secrets.token_hex(16)
            drop_restore_generation(root, bot, session)
            data = step(["prepare", generation])
            write_restore_generation(root, bot, session, generation, "split", owner)
    finally:
        os.close(lock)
    out.write(data); out.flush()

def split_for_host(request, home, root=None, owner=0, alive=session_alive, live=host_live, account=None, **options):
    """Called by ensure_session_host with the id's lock held, right before a new host starts: that host's engine
    run starts from a split saved session, so it restores only cookies at launch and every origin is eligible
    for lazy restore again. A split the server made since the last host (still "split") is taken over as is.
    Best effort: a failure leaves no generation (the engine restores as before) and never stops the host.
    Returns the new host's generation or None."""
    root = root or BROWSER_ROOT
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    if settings.get("AGENT_BROWSER_RESTORE_SAVE") != "auto":
        return None
    bot, session = request.get("bot"), settings.get("AGENT_BROWSER_SESSION")
    try:
        current = read_restore_generation(root, bot, session, owner)
        if current and current[1] == "split":
            write_restore_generation(root, bot, session, current[0], "hosted", owner)
            return current[0]
        drop_restore_generation(root, bot, session)
        if live(root, bot, session, owner) or alive(home, session):
            return None
        plan = validate_browser_restore_request({"mode": "browser-restore", "bot": bot, "args": [], "instance": request.get("instance"),
                                                 "settings": {key: value for key, value in settings.items() if key in BROWSER_RESTORE_SETTINGS}}, root)
        account = account or pwd.getpwnam(plan["user"])
        if plan["home"] != home or not browser_restore_home(home, account.pw_uid):
            return None
        generation = secrets.token_hex(16)
        restore_step(plan, ["prepare", generation], account, root=root, **options)
        write_restore_generation(root, bot, session, generation, "hosted", owner)
        return generation
    except Exception:
        try:
            drop_restore_generation(root, bot, session)
        except Exception:
            pass
        return None

def immutable_path(path, owner_uid):
    # Check both the lookup path and canonical target. Root-owned filesystem
    # links (e.g. /bin -> /usr/bin) are allowed; writable ancestors are not.
    for candidate in (path, os.path.realpath(path)):
        current = "/"
        for component in [""] + candidate.split("/")[1:]:
            current = os.path.join(current, component)
            info = os.lstat(current)
            if info.st_uid not in {0, owner_uid} or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022):
                raise ValueError("Cloud executable path must be root-owned and immutable")
    return os.path.realpath(path)

def file_stamp(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]

def recheck_stamp(path, stamp, owner_uid=0):
    # Same path and file identity as verified earlier; ctime cannot be reset by
    # an unprivileged writer, so identical identity means identical content.
    path = immutable_path(path, owner_uid)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
    finally:
        os.close(fd)
    if file_stamp(info) != stamp or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise ValueError("Cloud engine executable changed after verification")

def hash_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()

def cache_name(path, stamp):
    return hashlib.sha256(json.dumps([path] + stamp).encode()).hexdigest()

def cache_dir_fd(cache_root, owner_uid, create):
    # Returns an fd for a root-only cache directory, or None. Never trusts a
    # directory with a wrong owner or any group/other access.
    if create and not os.path.lexists(cache_root):
        try:
            os.mkdir(cache_root, 0o700)
        except OSError:
            return None
    try:
        fd = os.open(cache_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    info = os.fstat(fd)
    if info.st_uid != owner_uid or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        return None
    return fd

def cached_digest(cache_root, owner_uid, path, stamp, expected):
    fd = cache_dir_fd(cache_root, owner_uid, False)
    if fd is None:
        return False
    try:
        entry = os.open(cache_name(path, stamp), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(entry, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 4096:
                return False
            value = json.loads(stream.read(4097))
        return isinstance(value, dict) and value.get("path") == path and value.get("stamp") == stamp and value.get("sha256") == expected
    except (OSError, ValueError):
        return False
    finally:
        os.close(fd)

def store_digest(cache_root, owner_uid, path, stamp, digest):
    # Best effort and atomic: O_EXCL temp entry, then rename. Failure only
    # costs a re-hash next time.
    fd = cache_dir_fd(cache_root, owner_uid, True)
    if fd is None:
        return
    temp = ".tmp-" + secrets.token_hex(8)
    try:
        entry = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(entry, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps({"path": path, "stamp": stamp, "sha256": digest}))
        os.rename(temp, cache_name(path, stamp), src_dir_fd=fd, dst_dir_fd=fd)
    except OSError:
        try:
            os.unlink(temp, dir_fd=fd)
        except OSError:
            pass
    finally:
        os.close(fd)

def manifest_command(engine, command, manifest_path=ENGINE_MANIFEST, manifest_uid=0, engine_root="/data/engine-homes", cache_root=None, stamps=None):
    cache_root = DIGEST_CACHE if cache_root is None else cache_root
    if not isinstance(command, str) or "\0" in command:
        raise ValueError("Invalid cloud engine executable")
    if "/" not in command:
        command = shutil.which(command, path="/opt/murage/bin:/usr/local/bin:/usr/bin:/bin")
    if not isinstance(command, str) or not os.path.isabs(command) or command.startswith(engine_root + "/"):
        raise ValueError("Cloud engine executable is not listed")
    command = immutable_path(command, manifest_uid)
    if command.startswith(os.path.realpath(engine_root) + "/"):
        raise ValueError("Cloud engine executable is not listed")
    immutable_path(manifest_path, manifest_uid)
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        owner = os.fstat(stream.fileno())
        if not stat.S_ISREG(owner.st_mode) or owner.st_uid != manifest_uid or owner.st_mode & 0o022:
            raise ValueError("Cloud engine manifest must be root-owned and immutable")
        manifest = json.load(stream)
    entries = manifest.get(engine) if isinstance(manifest, dict) else None
    entry = next((item for item in entries if isinstance(item, dict) and item.get("path") == command), None) if isinstance(entries, list) else None
    if not entry or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64:
        raise ValueError("Cloud engine executable is not listed")
    # Only native binaries ship today. Interpreted engine grants must be
    # introduced with exact immutable script/digest/argument bindings in B2b.
    if "script" in entry or "scriptSha256" in entry or re.fullmatch(r"(?:ba|da|z|k|c|fi)?sh|node(?:js)?|python[0-9.]*|perl[0-9.]*|ruby[0-9.]*", os.path.basename(command)):
        raise ValueError("Cloud engine interpreter grants are not supported")
    fd = os.open(command, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        binary = os.fstat(stream.fileno())
        if not stat.S_ISREG(binary.st_mode) or binary.st_uid != manifest_uid or binary.st_mode & 0o022 or not binary.st_mode & 0o111:
            raise ValueError("Cloud engine executable is not immutable")
        if stream.read(4) != b"\x7fELF":
            raise ValueError("Cloud engine executable must be native")
        stamp = file_stamp(binary)
        # The path checks above already ran for this call; a cache hit needs
        # the identical identity AND the manifest's expected digest.
        if not cached_digest(cache_root, manifest_uid, command, stamp, entry["sha256"]):
            stream.seek(0)
            actual = hash_stream(stream)
            if actual != entry["sha256"]:
                raise ValueError("Cloud engine executable digest mismatch")
            store_digest(cache_root, manifest_uid, command, stamp, actual)
    if stamps is not None:
        stamps[command] = stamp
    return command

FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
FS_CASEFOLD_FL = 0x40000000
FS_IMMUTABLE_FL = 0x00000010

def inode_flags(fd):
    """The inode's FS_IOC_GETFLAGS word (a 4-byte int, read into a long-sized buffer)."""
    flags = bytearray(8)
    fcntl.ioctl(fd, FS_IOC_GETFLAGS, flags)
    return int.from_bytes(flags[:4], sys.byteorder)

def set_immutable(fd):
    """r5 R5.1: freeze a workspace placeholder. Root's CAP_LINUX_IMMUTABLE in the initial
    user namespace is what makes this succeed; nothing a turn or the server holds can undo
    it. A seam: the test rig, which lacks the capability, replaces it with a recorder."""
    flags = (inode_flags(fd) | FS_IMMUTABLE_FL).to_bytes(4, sys.byteorder) + bytes(4)
    fcntl.ioctl(fd, FS_IOC_SETFLAGS, bytearray(flags))

def canonical_path(path):
    """Design 3.1: a str, no NUL, absolute, os.path.normpath(p) == p and no empty, "."
    or ".." component. Bytes are compared as given: no normalization, no case folding."""
    if not isinstance(path, str) or "\0" in path or not path.startswith("/") or os.path.normpath(path) != path or any(part in {"", ".", ".."} for part in path.split("/")[1:]):
        raise Refusal("Cloud turn directory is not canonical")
    return path

def casefolded(path):
    """True when the directory carries ext4's casefold flag (the image never sets it;
    an invariant check). A filesystem without the ioctl is not casefolded."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        flags = bytearray(8)
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, flags)
        return bool(int.from_bytes(flags[:4], sys.byteorder) & FS_CASEFOLD_FL)
    except OSError:
        return False
    finally:
        os.close(fd)

def checked_directory(path, root):
    if not isinstance(path, str) or not path.startswith(root + "/"):
        raise ValueError("Cloud turn directory is outside its grant")
    canonical_path(path)
    if os.path.realpath(path) != path or not os.path.isdir(path):
        raise ValueError("Cloud turn directory must be a real directory")
    if casefolded(path):
        raise Refusal("Cloud turn directory is casefolded")
    return path

def open_directory(path):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.split("/")[1:]:
            if not component or component in {".", ".."}:
                raise ValueError("Invalid cloud turn path")
            nextfd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nextfd
        return fd
    except Exception:
        os.close(fd)
        raise

_PRIVATE_MOUNT_NS = False

def private_mount_namespace():
    # Must run BEFORE open_directory(): Linux refuses to bind-mount a mount
    # that belongs to another namespace (EINVAL), and a directory fd opened
    # before unshare(CLONE_NEWNS) still refers to the parent namespace's
    # mount. The first real home hit exactly that on every turn.
    global _PRIVATE_MOUNT_NS
    libc = ctypes.CDLL(None, use_errno=True)
    libc.unshare.argtypes = [ctypes.c_int]
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    if libc.unshare(0x00020000) != 0:
        raise OSError(ctypes.get_errno(), "Cloud turn mount namespace failed")
    if libc.mount(None, b"/", None, 16384 | 262144, None) != 0:
        raise OSError(ctypes.get_errno(), "Cloud turn mount propagation failed")
    _PRIVATE_MOUNT_NS = True

def anchor_mounts(mounts):
    # bwrap realpaths bind sources before mounting. Anchor open directories in
    # our private mount namespace first, so subsequent path renames cannot
    # redirect a bind to another engine home. These mountpoints are root-owned.
    if not _PRIVATE_MOUNT_NS:
        raise ValueError("Cloud turn mounts require the private namespace first")
    root = "/run/murage-turn"
    os.makedirs(root, mode=0o711, exist_ok=True)
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError("Cloud turn mount directory is not root-owned")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    if libc.mount(b"tmpfs", root.encode(), b"tmpfs", 2 | 4, b"mode=0711") != 0:
        raise OSError(ctypes.get_errno(), "Cloud turn mount staging failed")
    anchors = []
    for index, (fd, destination) in enumerate(mounts):
        path = root + "/" + str(index)
        os.mkdir(path, 0o755)
        if libc.mount(("/proc/self/fd/" + str(fd)).encode(), path.encode(), None, 4096, None) != 0:
            raise OSError(ctypes.get_errno(), "Cloud turn directory mount failed")
        os.close(fd)
        anchors.append((path, destination))
    return anchors

# What a turn request may carry (CLOUD-ENGINES-DESIGN.md 1.0.3). There is no `files`:
# every config file an engine reads is rendered here from `render` (typed parameters),
# and `args` must match the engine's grammar (ARGV_RULES). A login turn is built by
# validate_login_request and may also carry "pty".
TURN_KEYS = frozenset({"unit", "engine", "command", "args", "cwd", "env", "scratch", "render", "bot"})
# r5 R5.2: the bot a turn runs for (the shape of botWorkspacePath and validate_browser_request).
# The server stamps it (cloudTurnLaunch); it selects the bot's own state store and nothing else.
BOT_SHAPE = re.compile(r"[\w-]{1,64}", re.ASCII)
# The reserved directory under an engine home that holds every bot's store (bots/<bot>/...):
# never a turn's cwd, never the head of a state pattern.
BOTS_DIR = "bots"

def validate_request(request, manifest_path=ENGINE_MANIFEST, manifest_uid=0, engine_root="/data/engine-homes", cache_root=None, login=False):
    if not isinstance(request, dict):
        raise Refusal("Invalid cloud turn request")
    if "files" in request:
        raise Refusal("Cloud turn request carries files")
    if set(request) - TURN_KEYS - ({"pty"} if login else set()):
        raise Refusal("Cloud turn request has an unknown key")
    engine = request.get("engine")
    if engine not in ENGINES:
        raise ValueError("Cloud engine is not registered")
    home = checked_directory(engine_root + "/" + engine, engine_root)
    bot = request.get("bot")
    if bot is not None and (not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None):
        raise Refusal("Cloud turn bot is not allowed")
    cwd = request.get("cwd", home)
    if cwd != home:
        inside = isinstance(cwd, str) and cwd.startswith(home + "/")
        # The bot stores are the root launcher's alone: a cwd inside one would bind it into a turn.
        if inside and BOTS_DIR in cwd[len(home) + 1:].split("/"):
            raise Refusal("Cloud turn cwd is not allowed: " + BOTS_DIR)
        checked_directory(cwd, home if inside else WORKSPACE_ROOT)
    command, args, env = request.get("command"), request.get("args"), request.get("env")
    command = manifest_command(engine, command, manifest_path, manifest_uid, engine_root, cache_root)
    if not isinstance(args, list) or not all(isinstance(arg, str) and "\0" not in arg for arg in args):
        raise ValueError("Invalid cloud engine arguments")
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) and "=" not in k and "\0" not in k + v for k, v in env.items()):
        raise ValueError("Invalid cloud engine environment")
    scratch = scratch_paths(engine, home, request.get("scratch", []))
    render = validate_render(engine, request.get("render"), render_unit_hex(request), login, manifest_path, manifest_uid, cache_root)
    # The argv grammar runs on the request's tokens; placeholders become the paths of
    # the files rendered for this turn.
    args = check_argv(engine, args, render, login)
    if engine == "fuigoAgent":
        # Every Fuigo shell command asks Murage, on every spawn but Full access (fuigo_config_text).
        render["bashAsk"] = not fuigo_full_access(args)
    # A probe (--version, auth status) runs outside any bot: without a bot it stages and
    # collects nothing. Every other non-login turn names its bot (r5 R5.2).
    if bot is None and not login and args not in [list(probe) for probe in ARGV_PROBES.get(engine, ())]:
        raise Refusal("Cloud turn names no bot")
    # The request's env is a proposal: engine_environment() keeps only the names this
    # engine is allowed, pins every path itself and drops the rest (never a strip list).
    env, dropped = engine_environment(engine, home, env, scratch)
    if dropped:
        # Names only, never values: a credential under a wrong name must not reach the journal.
        print("Cloud turn environment dropped: " + " ".join(sorted(dropped)), file=sys.stderr)
    # C-mode sign-ins are rendered from the root store, never from the request or a staged
    # file; a login renders none (it runs on the base configuration).
    render["credentials"] = {} if login else c_credentials(home, engine)
    signin_environment(engine, env, render)
    env.update(render_environment(engine, home, render))
    if engine == "opencodeGo" and render["credentials"].get("api") and opencode_oauth_staged(home, bot):
        # 1.0.3 cannot combine them: the key entries win, and the turn says so once.
        print(OPENCODE_SHADOWED, file=sys.stderr)
    return engine, home, cwd, command, args, env, render, bot

def validate_login_request(request, engine_root="/data/engine-homes", tombstones=None):
    """Turn the login request into what main() runs (r9 "launcher modes").

    Keys: {mode, engine, action, pty?, unit?, bot?, secret?, provider?}. `login` becomes the
    ordinary turn request the sandbox path runs (command, args, cwd and env built here from
    LOGIN_COMMANDS; a B login carries its bot, so launch() admits it and stages that bot's
    sign-in set). `logout` and `enroll-key` run no CLI: they become a publish
    ({"engine", "publish": action, "bot"?, "secret"?, "provider"?}) of the addressed store.
    Everything else refuses (a login renders the base configuration: no route, no MCP)."""
    if not isinstance(request, dict) or set(request) - LOGIN_KEYS or request.get("mode") != "login":
        raise ValueError("Invalid cloud login request")
    engine, action = request.get("engine"), request.get("action")
    if not isinstance(engine, str) or engine not in LOGIN_COMMANDS or not isinstance(action, str):
        raise ValueError("Invalid cloud login engine")
    if action not in {"login", "logout", "enroll-key"} or (action == "enroll-key" and engine not in ENROLL_ENGINES):
        raise ValueError("Invalid cloud login action")
    if not isinstance(request.get("pty", False), bool):
        raise ValueError("Invalid cloud login terminal")
    bot, secret, provider = request.get("bot"), request.get("secret"), request.get("provider")
    if bot is not None and (not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None):
        raise Refusal("Cloud turn bot is not allowed")
    # A B sign-in is per bot and names it; Claude's C sign-in and a key enrollment are
    # engine-wide and never do (r8 R4, r9 "launcher modes").
    if action == "login" and engine not in LOGIN_C_ENGINES and bot is None:
        raise Refusal("Cloud sign-in names no bot")
    if bot is not None and (action == "enroll-key" or (action == "login" and engine in LOGIN_C_ENGINES)):
        raise Refusal("Cloud sign-in takes no bot")
    if (secret is not None) != (action == "enroll-key") or (secret is not None and (not isinstance(secret, str) or LOGIN_SECRET_SHAPE.fullmatch(secret) is None)):
        raise Refusal("Cloud sign-in key is not allowed")
    wants_provider = action == "enroll-key" and engine == "opencodeGo"
    if (provider is not None) != wants_provider or (provider is not None and (not isinstance(provider, str) or LOGIN_PROVIDER_SHAPE.fullmatch(provider) is None)):
        raise Refusal("Cloud sign-in provider is not allowed")
    # Admission re-checks this under the bot lock; refusing here too keeps a deleted bot
    # from ever reaching a scope (r8 fixture 17).
    if bot is not None and tombstoned(bot, tombstones):
        raise Refusal("Cloud bot was deleted")
    if action != "login":
        publish = {"engine": engine, "publish": action}
        for key, value in (("bot", bot), ("secret", secret), ("provider", provider), ("unit", request.get("unit"))):
            if value is not None:
                publish[key] = value
        return publish
    command, actions = LOGIN_COMMANDS[engine]
    home = engine_root + "/" + engine
    env = {"LANG": "C.UTF-8", "TERM": "xterm-256color", "XDG_CONFIG_HOME": home + "/.config", "XDG_CACHE_HOME": home + "/.cache", "XDG_DATA_HOME": home + "/.local/share"}
    for key, value in LOGIN_ENV[engine].items():
        env[key] = home + value if value.startswith("/") else value
    turn = {"engine": engine, "command": command, "args": list(actions[action]), "cwd": home, "env": env}
    if bot is not None:
        turn["bot"] = bot
    if "unit" in request:
        turn["unit"] = request["unit"]
    if request.get("pty"):
        turn["pty"] = True
    return turn

# Root-owned policy files from the image, bound read-only into every turn of the engine.
# Fuigo's two system tiers carry the R2/R3 pins (managed/fuigo-*.toml).
MANAGED_POLICY_PATHS = {
    "claudeAgent": ["/etc/claude-code/managed-settings.json"], "codex": ["/etc/codex/requirements.toml"], "grokAgent": ["/etc/grok/requirements.toml"],
    "fuigoAgent": ["/etc/fuigo/requirements.toml", "/etc/fuigo/managed_config.toml"],
}

def managed_policy_paths(engine):
    return list(MANAGED_POLICY_PATHS.get(engine, []))

BROKER_DIR = "/data/broker"
# The turn's private render directory: the two plain or per-turn files that are not
# config in the engine home (Claude's --mcp-config file and system prompt) live in the
# turn's own /tmp tmpfs at a launcher-composed path, so nothing outlives the turn.
RENDER_PATTERN = re.compile(r"^/tmp/murage-render-[0-9a-f]{16}/(mcp\.json|prompt\.txt)$")
SCRATCH_PATTERN = re.compile(r"^native/provider-turns/(hermesAgent|fuigoAgent)-[A-Za-z0-9]{6,32}$")
def scratch_paths(engine, home, scratch):
    # Per-turn routed homes are fresh tmpfs mounts inside the namespace, so the
    # server never creates anything under the engine home. Each entry must be a
    # plain relative path of an exact shape, owned by this engine, with no
    # symlink on any component that already exists.
    if not isinstance(scratch, list) or len(scratch) > 2:
        raise ValueError("Invalid cloud turn scratch")
    paths = []
    for relative in scratch:
        if not isinstance(relative, str) or "\0" in relative or relative.startswith("/") or ".." in relative.split("/") or os.path.normpath(relative) != relative or not SCRATCH_PATTERN.match(relative) or not relative.split("/")[2].startswith(engine + "-"):
            raise ValueError("Cloud turn scratch is outside its grant")
        path = home + "/" + relative
        current = home
        for part in relative.split("/"):
            current += "/" + part
            try:
                if stat.S_ISLNK(os.lstat(current).st_mode):
                    raise ValueError("Cloud turn scratch crosses a symlink")
            except FileNotFoundError:
                break
        paths.append(path)
    return paths

# OpenCode 1.19.0 (read from the shipped binary, Config.ensureGitignore): at startup,
# for every config directory it loads (XDG_CONFIG_HOME/opencode, OPENCODE_CONFIG_DIR,
# and a .opencode directory in HOME or, with project config on, up from the working
# folder) it runs ensureDir(dir), then writes dir/.gitignore with exactly this text
# unless that file already exists. Only a PermissionDenied failure is ignored; a
# read-only mount fails with EROFS, which ends the run as "Unknown:
# FileSystem.writeFile (.../.gitignore)". The file's existence is all it checks, so
# staging it read-only in each shadowed config directory lets the turn start while
# the managed config there stays unmodifiable.
OPENCODE_GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore"

# OpenCode 1.19.0 never needs npm for a Go or Zen turn: every SDK the Go and Zen
# catalogues name (@ai-sdk/openai-compatible, openai, anthropic, google, mistral) is
# compiled into the binary (its provider table maps each to an embedded chunk), so
# provider loading imports them and ~/.cache/opencode/packages stays empty. Its only
# on-demand npm fetches are (from the shipped binary): Npm.install of
# @opencode-ai/plugin@1.19.0 into every config directory it loads that is writable
# (Global config, ~/.opencode, OPENCODE_CONFIG_DIR; skipped when the directory is not
# writable), Npm.add of a configured plugin or a provider npm missing from that table,
# and LSP server downloads. The launcher closes all of them: OpenCode's config
# directory is pinned to the read-only shadow (a request naming a writable one, as
# the 2026-10-15 rigoc measurement did, made the refused registry.npmjs.org call),
# ~/.opencode is shadowed read-only too, OPENCODE_PURE drops external plugins and
# OPENCODE_DISABLE_LSP_DOWNLOAD stops LSP installs. Its home and every XDG base
# (packages/core/src/global.ts: OPENCODE_TEST_HOME, xdg-basedir) are pinned below too.

# Turn environment (ENGINES-ENV-ALLOWLIST-DESIGN.md). The request's env is a proposal:
# the launcher pins every home, config, cache and XDG path itself, each engine gets
# exactly the variables it needs, and every other name is dropped. There is no strip
# list to keep up with: Grok Build 1.0.52 alone reads 40+ GROK_* path variables, Kimi
# Code 2.2.0 KIMI_SHARE_DIR / KIMI_CODE_CACHE_DIR / KIMI_PLUGIN_ROOT, Claude Code
# CLAUDE_CODE_PLUGIN_DIRS / CLAUDE_ENV_FILE / CLAUDE_CODE_TMPDIR, OpenCode 1.19.0
# OPENCODE_TEST_HOME and the XDG bases, Codex 0.162.1 CODEX_HOME (home-dir/src/lib.rs).
# Sources per engine are in the design note; each allowed name is one the server's
# cloudTurnEnvironment or a provider route sets and the engine reads as a value, never
# as a path. Pinned beats allowed beats dropped.

# Turn environment (ENGINES-ENV-ALLOWLIST-DESIGN.md). The request's env is a proposal:
# the launcher pins every home, config, cache and XDG path itself, each engine gets
# exactly the variables it needs, and every other name is dropped. There is no strip
# list to keep up with: Grok Build 1.0.52 alone reads 40+ GROK_* path variables, Kimi
# Code 2.2.0 KIMI_SHARE_DIR / KIMI_CODE_CACHE_DIR / KIMI_PLUGIN_ROOT, Claude Code
# CLAUDE_CODE_PLUGIN_DIRS / CLAUDE_ENV_FILE / CLAUDE_CODE_TMPDIR, OpenCode 1.19.0
# OPENCODE_TEST_HOME and the XDG bases, Codex 0.162.1 CODEX_HOME (home-dir/src/lib.rs).
# Sources per engine are in the design note; each allowed name is one the server's
# cloudTurnEnvironment or a provider route sets and the engine reads as a value, never
# as a path. Pinned beats allowed beats dropped.
COMMON_ENV = frozenset({"LANG", "LC_ALL", "TZ", "TERM"})
PINNED_PATH = "/opt/murage/bin:/usr/local/bin:/usr/bin:/bin"
# Fuigo's compat cells (fuigo.ts FUIGO_EXTERNAL_MCP_GATES). 1.0.3 pins all 19 to "0"
# (CLOUD-ENGINES-DESIGN.md 5.1): a request value, "1" included, is ignored like any
# pinned name, so the engine never imports the owner's Claude/Cursor/Codex surfaces.
FUIGO_COMPAT_GATES = tuple("FUIGO_" + surface + "_" + cell + "_ENABLED" for surface in ("CLAUDE", "CURSOR", "CODEX")
                           for cell in ("SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS")) + ("FUIGO_AGENTS_SKILLS_ENABLED",)
ENGINE_ENV_ALLOW = {
    "claudeAgent": frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                              "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_ATTRIBUTION_HEADER"}),
    "codex": frozenset({"OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "MURAGE_PROVIDER_API_KEY"}),
    # Grok Build runs on its own grok.com login in $GROK_HOME/auth.json; provider routing
    # on a Cloud home is refused server-side (grokRouteOnHome), so no route key is needed.
    "grokAgent": frozenset({"GROK_CONFIG"}),
    "kimiAgent": frozenset({"KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_PROVIDER_TYPE", "KIMI_MODEL_DISPLAY_NAME"}),
    "opencodeGo": frozenset({"OPENCODE_API_KEY", "OPENCODE_CONFIG_CONTENT"}),
    "fuigoAgent": frozenset({"FUIGO_API_KEY", "MURAGE_PROVIDER_API_KEY", "FUIGO_API_BASE_URL", "FUIGO_MODELS_BASE_URL", "FUIGO_ALLOW_UPSTREAM_HOSTS", "FUIGO_CONFIG"}),
}

# 1.0.4 audit 11-2: the two inline config overlays the drivers use to put the Flux memory
# headers (opt-out, non-owner isolation) on the engine's Flux requests. Unlike every other
# allowed name they carry a document, not a path or a credential, so each is accepted only
# when its value parses to exactly the shape the driver builds (flux-memory-headers.ts
# fuigoConfigOverlay / opencodeConfigOverlay; opencode-go.ts isolateOpenCodeFromPersonalSetup):
# a JSON object whose only content is the x-flux-memory-* request headers (and, for OpenCode,
# MCP servers switched off). It cannot carry a key, token, URL, command or path: those reach
# the engine as FUIGO_API_KEY / OPENCODE_API_KEY (already allowed above) or are rendered by
# the launcher. Anything else is dropped like any unlisted name, never passed on.
FLUX_MEMORY_HEADERS = {"x-flux-memory-app": re.compile(r"murage"), "x-flux-memory-capture": re.compile(r"off"), "x-flux-memory-inject": re.compile(r"off"),
                       # flux-memory-headers.ts SPACE_CHARSET / FLUX_READ_LIMIT: one space string, and at most 8 joined by ","
                       "x-flux-memory-space": re.compile(r"[A-Za-z0-9._:#-]{1,128}"),
                       "x-flux-memory-read": re.compile(r"[A-Za-z0-9._:#-]{1,128}(,[A-Za-z0-9._:#-]{1,128}){0,7}")}
INLINE_CONFIG_MAX = 8192
# The OpenCode turn permission set is carried once top level and once per OpenCode agent (opencode-go.ts).
OPENCODE_CONFIG_MAX = 65536

def _no_duplicate_keys(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out

def _only(value, *keys):
    """value is a dict whose keys are exactly `keys`."""
    return isinstance(value, dict) and set(value) == set(keys)

def _memory_headers(value):
    return isinstance(value, dict) and "x-flux-memory-app" in value and all(
        name in FLUX_MEMORY_HEADERS and isinstance(text, str) and FLUX_MEMORY_HEADERS[name].fullmatch(text) for name, text in value.items())

def _inline_config(value, limit=INLINE_CONFIG_MAX):
    if len(value.encode("utf-8", "surrogatepass")) > limit:
        return None
    try:
        return json.loads(value, object_pairs_hook=_no_duplicate_keys)
    except (ValueError, RecursionError):
        return None

def fuigo_config_value(value):
    """{"models": {"extra_headers": {x-flux-memory-*: ...}}}"""
    doc = _inline_config(value)
    return _only(doc, "models") and _only(doc["models"], "extra_headers") and _memory_headers(doc["models"]["extra_headers"])

# applyOpenCodeTurnPermission (opencode-go.ts) writes the turn's permission set on every OpenCode spawn: everything that
# acts asks, and only these read-only tools run unasked. The validator accepts that shape and nothing wider.
OPENCODE_UNASKED_TOOLS = frozenset({"glob", "grep", "list", "todoread", "todowrite"})
OPENCODE_AGENT_NAMES = frozenset({"build", "plan", "general", "explore"})
OPENCODE_TOOL_NAME = re.compile(r"[A-Za-z0-9_.*-]{1,64}")

def _opencode_permission(perm):
    if not isinstance(perm, dict) or perm.get("*") != "ask" or len(perm) > 256:
        return False
    for tool, rule in perm.items():
        if not isinstance(tool, str) or not OPENCODE_TOOL_NAME.fullmatch(tool):
            return False
        if tool == "read":
            if not isinstance(rule, dict) or rule.get("*") != "allow" or len(rule) > 256 or not all(
                    isinstance(k, str) and 0 < len(k) <= 256 and v in ("ask", "allow") for k, v in rule.items()):
                return False
        elif rule != ("allow" if tool in OPENCODE_UNASKED_TOOLS else "ask"):
            return False
    return True

def _opencode_agents(agent, perm):
    return isinstance(agent, dict) and bool(agent) and set(agent) <= OPENCODE_AGENT_NAMES and all(
        _only(entry, "permission") and entry["permission"] == perm for entry in agent.values())

def opencode_config_value(value):
    """{"provider": {"flux": {"options": {"headers": {x-flux-memory-*: ...}}}}} plus, optionally,
    "mcp": {name: {"enabled": false}}: the owner's MCP servers switched off, which only narrows.
    The turn's permission set (permission, agent, default_agent) rides along as one unit."""
    doc = _inline_config(value, OPENCODE_CONFIG_MAX)
    # The provider block is optional: isolateOpenCodeFromPersonalSetup (opencode-go.ts) writes {"mcp": ...} alone when no
    # memory overlay was built. A document with neither a provider nor a server to switch off carries nothing and is refused.
    if isinstance(doc, dict) and "permission" in doc:
        perm = doc["permission"]
        if not (_opencode_permission(perm) and _opencode_agents(doc.get("agent"), perm) and doc.get("default_agent") == "build"):
            return False
        doc = {key: item for key, item in doc.items() if key not in ("permission", "agent", "default_agent")}
        if not doc:
            return True
    if not isinstance(doc, dict) or not set(doc) <= {"provider", "mcp"} or not (doc.get("provider") or doc.get("mcp")):
        return False
    if "provider" in doc:
        provider = doc["provider"]
        if not (_only(provider, "flux") and _only(provider["flux"], "options") and _only(provider["flux"]["options"], "headers")
                and _memory_headers(provider["flux"]["options"]["headers"])):
            return False
    mcp = doc.get("mcp", {})
    return isinstance(mcp, dict) and all(re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) and _only(entry, "enabled") and entry["enabled"] is False for name, entry in mcp.items())

# Grok Build shares Fuigo's shell: grok.ts applyFluxMemory builds GROK_CONFIG with the same
# fuigoConfigOverlay, so it gets the same validator, for this engine only (1.0.4 audit 11-2 follow-up).
ENGINE_ENV_VALUE = {("fuigoAgent", "FUIGO_CONFIG"): fuigo_config_value, ("grokAgent", "GROK_CONFIG"): fuigo_config_value, ("opencodeGo", "OPENCODE_CONFIG_CONTENT"): opencode_config_value}
# Pinned per engine, relative to the engine home when the value starts with "/". Each
# name was found in the shipped binary or its documentation (design note).
ENGINE_ENV_PIN = {
    "claudeAgent": {"CLAUDE_CONFIG_DIR": "/.claude", "DISABLE_UPDATES": "1", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
                    "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
    "codex": {"CODEX_HOME": "/.codex"},
    "grokAgent": {"GROK_HOME": "/.grok", "GROK_DISABLE_AUTOUPDATER": "1"},
    "kimiAgent": {"KIMI_CODE_HOME": "/.kimi-code", "KIMI_CODE_NO_AUTO_UPDATE": "1"},
    "opencodeGo": {"OPENCODE_CONFIG": "/.config/opencode/opencode.json", "OPENCODE_CONFIG_DIR": "/.config/opencode", "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                   "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_PURE": "1", "OPENCODE_DISABLE_LSP_DOWNLOAD": "1",
                   # Astra r1 H: the model catalog is the binary's embedded snapshot (models-dev.ts: disk, then
                   # snapshot, then fetch). $HOME/.cache is fresh, so no disk catalog exists; with no fetch
                   # none is written or refreshed mid-turn either.
                   "OPENCODE_DISABLE_MODELS_FETCH": "1"},
    # Fuigo 1.0.32 refreshes subscription model lists at startup unless this is set (catalog.rs
    # spawn_startup_refresh); Murage owns the catalog, and 1.0.31 ignores the name. Fuigo's own
    # subagents are off: a subagent definition may name a wider permissionMode than the bot's,
    # and its calls would never reach Murage's approval layer (fuigo.ts FUIGO_SUBAGENTS_OFF).
    # Workflow runs, background scheduler loops and goal runs spawn `general-purpose` past
    # FUIGO_SUBAGENTS=0, and a workspace .fuigo/agents/general-purpose.md can redefine it, so
    # those are off too (fuigo.ts FUIGO_AGENT_SPAWNS_OFF). FUIGO_AGENT and
    # FUIGO_WORKSPACE_REWIND_GIT are in no allowlist, so a request's value is dropped.
    "fuigoAgent": {**{name: "0" for name in FUIGO_COMPAT_GATES}, "FUIGO_DISABLE_MODEL_REFRESH": "1", "FUIGO_SUBAGENTS": "0",
                   "FUIGO_WORKFLOWS": "0", "FUIGO_SCHEDULER_BACKGROUND_LOOPS": "0", "FUIGO_GOAL": "0"},
}
# Rule 74c (APP-GRANT-AMEND-14): the server hands every engine its pinned environment, and the
# launcher would drop those names as unallowed, so it pins the same values itself for every engine
# (pinned beats allowed). One table with shared/arg-vocabulary.ts ENV_PINS (POSIX values; the ssh
# transport is the plain resolved form, as the server's Cloud-home hand runs no probe); the absence
# pins need nothing here, since every unallowed name is dropped. TERM stays a COMMON_ENV name: the
# hand sends TERM=dumb. engine-env-pins-cloud.test.ts holds the two tables equal.
HANDED_ENV_PIN = {
    "PAGER": "cat", "GIT_PAGER": "cat", "MANPAGER": "cat", "SYSTEMD_PAGER": "cat", "PSQL_PAGER": "cat", "LESS": "",
    "GIT_EDITOR": "true", "GIT_SEQUENCE_EDITOR": "true", "EDITOR": "true", "VISUAL": "true", "PSQL_EDITOR": "true",
    "PSQLRC": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS": "", "SSH_ASKPASS_REQUIRE": "never",
    "GCM_INTERACTIVE": "0", "GIT_SSH_VARIANT": "ssh", "GIT_SSH_COMMAND": "'ssh' '-o' 'BatchMode=yes'",
    "RSYNC_RSH": "'ssh' '-o' 'BatchMode=yes'", "DEBIAN_FRONTEND": "noninteractive", "ZDOTDIR": "/dev/null",
}

# No allowed name may look like a path override; a future edit that allows one fails
# the launcher at load, before any turn.
PATH_NAME_SHAPE = re.compile(r"(HOME|DIR|DIRS|PATH|FILE|FILES|ROOT)($|_)|CONFIG|_TEST_|^XDG_|^(TMP|TEMP)$")

def check_env_allowlist(table):
    for engine, names in table.items():
        bad = sorted(name for name in names if PATH_NAME_SHAPE.search(name) and (engine, name) not in ENGINE_ENV_VALUE)
        if bad:
            raise ValueError("Cloud engine allowlist for " + engine + " names a path variable: " + " ".join(bad))

check_env_allowlist({"common": COMMON_ENV, **ENGINE_ENV_ALLOW})

def path_shaped_value(key, value):
    """An allowed, non-credential variable never names a path: a value that starts like one
    (TZ=:/etc/x, LANG=/x) or carries a .. component is dropped. Credentials are exempt: an
    engine never opens them, and a token may contain those characters."""
    if key.endswith(("_KEY", "_TOKEN")):
        return False
    return value.startswith(("/", "~", ":")) or ".." in value.split("/")

def pinned_environment(engine, home, scratch=()):
    env = {"HOME": home, "USERPROFILE": home, "TMPDIR": home + "/tmp", "PATH": PINNED_PATH, "XDG_CONFIG_HOME": home + "/.config",
           "XDG_CACHE_HOME": home + "/.cache", "XDG_DATA_HOME": home + "/.local/share", "XDG_STATE_HOME": home + "/.local/state"}
    env.update(HANDED_ENV_PIN)
    for key, value in ENGINE_ENV_PIN.get(engine, {}).items():
        env[key] = home + value if value.startswith("/") else value
    if engine == "fuigoAgent":
        # A routed Fuigo turn lives in the scratch tmpfs the launcher itself validated and
        # mounts (scratch_paths); otherwise the engine's own $HOME/.fuigo. Never the request's value.
        env["FUIGO_HOME"] = fuigo_home(home, scratch)
    return env

def fuigo_home(home, scratch=()):
    return scratch[0] if scratch else home + "/.fuigo"

def engine_environment(engine, home, proposal, scratch=()):
    """The engine's environment from the request's proposal: allowed names copied, every
    path pinned, everything else dropped. Returns (env, dropped names)."""
    pinned = pinned_environment(engine, home, scratch)
    allowed = COMMON_ENV | ENGINE_ENV_ALLOW.get(engine, frozenset())
    env, dropped = {}, []
    for key, value in proposal.items():
        if key in pinned:
            continue
        check = ENGINE_ENV_VALUE.get((engine, key))
        if check and key in allowed and not check(value):
            # Present but malformed: the driver meant a memory overlay, so running without it would
            # drop the opt-out. Refuse the turn; name only, never the value (Fable follow-up 2).
            raise Refusal("Cloud engine environment %s is malformed" % key)
        if key in allowed and (check(value) if check else not path_shaped_value(key, value)):
            env[key] = value
        else:
            dropped.append(key)
    env.update(pinned)
    return env, dropped

# ---------------------------------------------------------------------------
# 1.0.3: the launcher owns every engine configuration (lanes/release103/
# CLOUD-ENGINES-DESIGN.md, r3 over r2 over sections 1 to 8). The request carries typed
# `render` parameters; every config file an engine reads at startup is composed here,
# staged read-only, and checked once more after rendering. The request never names a
# config path or ships file bytes.

WORKSPACE_ROOT = "/data/home/workspaces"
NODE = "/usr/local/bin/node"
MCP_PROXY_ROOT = "/opt/murage/dist-server"

# Closed character classes (r2 R1, r3 Low). None admits `{`, `}`, `$`, `"`, `\`, a
# newline or a NUL, so neither OpenCode's {env:...}/{file:...} tokens, nor Fuigo's
# $VAR expansion, nor a JSON or TOML string terminator can be formed from request input.
ID_SHAPE = re.compile(r"[a-z][a-z0-9_-]{0,31}", re.ASCII)
# MCP server names: Claude tool prefixes and Codex TOML bare keys (A-Za-z0-9_-).
NAME_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", re.ASCII)
# Every component starts alphanumeric: no leading /, : or ., no `..` component (r3 Low).
MODEL_ID_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:[:/][A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}", re.ASCII)
HTTPS_URL_SHAPE = re.compile(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?|http://127\.0\.0\.1:[0-9]{1,5}(?:/[A-Za-z0-9._~/-]*)?", re.ASCII)
LABEL_SHAPE = re.compile(r"[A-Za-z0-9 ._-]{1,64}", re.ASCII)
INT_SHAPE = re.compile(r"[0-9]{1,9}", re.ASCII)
BROKER_SOCKET_SHAPE = re.compile(r"/data/broker/[A-Za-z0-9_-]{8,80}\.sock", re.ASCII)
UUID_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII)
TOOL_LIST_SHAPE = re.compile(r"[A-Za-z0-9_,:*() .-]{0,4096}", re.ASCII)
SECRET_MAX = 4 * 1024
TEXT_MAX = 256 * 1024
# r3 Low: aggregate limits, each refused with its own line.
RENDER_MAX = 512 * 1024
MCP_MAX = 16
PROXY_ENV_MAX = 64 * 1024
PROXY_ENV_NAMES_MAX = 64
ARGV_MAX_TOKENS = 64
ARGV_MAX_BYTES = 32 * 1024
CHAIN_MAX = 24
PLAN_FILES_MAX = 96

# MCP proxies: the only source of a command inside a rendered MCP stanza (design 2.3).
# script is relative to MCP_PROXY_ROOT without its extension (the bundled .js of
# scripts/bundle-server.mjs); "arg" is the one extra argument the kind takes. env lists
# the names the proxy reads (its process.env and turn-credential reads at base, plus the
# server's integration env for it); server/cloud-home/engine-render.ts carries the same
# table and engine-render-launcher.test.ts asserts the two are equal.
MCP_PROXIES = {
    "permission": {"script": "permission-proxy", "arg": "socket", "env": ()},
    "agents": {"script": "drivers/agents-proxy", "arg": None, "env": ("MURAGE_HARNESS_URL", "MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_COMMS_TOKEN", "MURAGE_TURN_DEPTH",
               "MURAGE_SKILL_AUTHORING_ENABLED", "MURAGE_IMAGE_LIBRARY", "MURAGE_PROJECT_ROLE", "MURAGE_GENERATE_IMAGE_WAIT_MS", "MURAGE_AGENTS_UNAVAILABLE")},
    "memory": {"script": "drivers/memory-proxy", "arg": None, "env": ("MURAGE_HARNESS_URL", "MURAGE_MEMORY_TOKEN")},
    "phone": {"script": "drivers/phone-proxy", "arg": None, "env": ("PH_ANDROID_SERIAL",)},
    "browser": {"script": "drivers/unified-browser-proxy", "arg": None, "env": ("MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_BROWSER_TRANSPORT", "MURAGE_BROWSER_CALL_TIMEOUT_MS",
                "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN")},
    "computer": {"script": "computer-proxy", "arg": None, "env": ("MURAGEBOX_BOX_ID", "MURAGEBOX_BOX_API", "MURAGEBOX_BOX_TOKEN", "MURAGEBOX_WAKE_BUDGET_MS",
                 "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN", "MURAGE_CONTROL_POLL_MS", "MURAGE_CONTROL_WAIT_MS")},
    "hostComputer": {"script": "drivers/host-computer-proxy", "arg": None, "env": ("MURAGE_BOT_ID", "MURAGE_THREAD_ID", "MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN")},
    "dweb": {"script": "drivers/dweb-proxy", "arg": None, "env": ("DWEB_URL", "DWEB_DISPLAY")},
    "connectors": {"script": "connector-proxy", "arg": None, "env": ("MURAGE_CONNECTOR_UPSTREAM_URL", "MURAGE_CONNECTOR_UPSTREAM_HEADERS", "MURAGE_HARNESS_URL",
                   "MURAGE_CONNECTORS_TOKEN", "MURAGE_BOT_ID", "MURAGE_THREAD_ID")},
    # The owner's own servers on a Cloud home are remote (design decision item 1): they
    # reach the server's relay through this proxy, named by `--server <NAME>`.
    "remote": {"script": "drivers/remote-mcp-proxy", "arg": "server", "env": ("MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN")},
    "vpsRelay": {"script": "cloud-home/vps-relay-mcp", "arg": None, "env": ("MURAGE_CONTROL_URL", "MURAGE_CONTROL_TOKEN")},
    # No command: rendered as {"type":"http","url":...} (Claude) or url = ... (Codex).
    "url": {"script": None, "arg": "url", "env": ()},
}
PROXY_ENV = frozenset(name for row in MCP_PROXIES.values() for name in row["env"])
# Codex: harness-owned servers are pre-quieted; a server marked "ask" keeps the
# on-request policy so its calls become approval cards (codex.ts mountMcpServer).
CODEX_MCP_TOOL_TIMEOUT_SEC = 7 * 24 * 60 * 60
CODEX_CUSTOM_MCP_STARTUP_TIMEOUT_SEC = 60
ROUTE_PROTOCOLS = {"openai": "chat_completions", "anthropic": "messages", "responses": "responses"}
EFFORTS = frozenset({"none", "low", "medium", "high", "xhigh", "max"})  # contracts.ts EFFORT_LEVELS
# Which typed parts each engine's templates take (design 2.2, r2 H1 table). Any other
# part refuses; an engine not listed renders nothing and takes no `render`.
RENDER_PARTS = {
    "claudeAgent": frozenset({"mcp", "systemPrompt"}),
    "codex": frozenset({"route", "mcp", "resume", "codexPolicy"}),
    "grokAgent": frozenset(),
    "kimiAgent": frozenset(),
    "opencodeGo": frozenset({"route"}),
    "fuigoAgent": frozenset({"route", "memoryTools"}),
}
ROUTE_KEYS = frozenset({"provider", "baseUrl", "model", "apiKey", "protocol", "contextSize", "label", "models", "headers"})
STANZA_KEYS = frozenset({"proxy", "socket", "server", "url", "env", "ask"})
# Template env_key names: each must be one the request can deliver (design 5.2).
TEMPLATE_ENV_KEYS = {"codex": ("MURAGE_PROVIDER_API_KEY",), "fuigoAgent": ("MURAGE_PROVIDER_API_KEY",)}

def secret_value(value):
    if not isinstance(value, str) or "\0" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= SECRET_MAX
    except UnicodeEncodeError:
        return False

def text_value(value):
    """TEXT (r3 N1): valid UTF-8, no NUL, at most 256 KiB; bytes preserved verbatim."""
    if not isinstance(value, str) or "\0" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= TEXT_MAX
    except UnicodeEncodeError:
        return False

def shaped(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None

def model_id(value):
    return shaped(MODEL_ID_SHAPE, value) and len(value) <= 128

def render_unit_hex(request):
    unit = request.get("unit") if isinstance(request, dict) else None
    if isinstance(unit, str) and TURN_UNIT_PATTERN.fullmatch(unit):
        return unit[len("murage-turn-"):-len(".scope")]
    return secrets.token_hex(8)

def render_dir(render):
    return "/tmp/murage-render-" + render["unit"]

def validate_route(engine, route):
    if not isinstance(route, dict) or set(route) - ROUTE_KEYS:
        raise Refusal("Cloud turn render route has an unknown key")
    if not shaped(ID_SHAPE, route.get("provider")):
        raise Refusal("Cloud turn render route provider is not allowed")
    if not shaped(HTTPS_URL_SHAPE, route.get("baseUrl")):
        raise Refusal("Cloud turn render route baseUrl is not allowed")
    if not model_id(route.get("model")):
        raise Refusal("Cloud turn render route model is not allowed")
    if not secret_value(route.get("apiKey")) or not route["apiKey"]:
        raise Refusal("Cloud turn render route apiKey is not allowed")
    out = {key: route[key] for key in ("provider", "baseUrl", "model", "apiKey")}
    if "protocol" in route:
        if route["protocol"] not in ROUTE_PROTOCOLS:
            raise Refusal("Cloud turn render route protocol is not allowed")
        out["protocol"] = route["protocol"]
    elif engine == "fuigoAgent":
        raise Refusal("Cloud turn render route protocol is missing")
    if "contextSize" in route:
        size = route["contextSize"]
        if isinstance(size, bool) or not isinstance(size, int) or not shaped(INT_SHAPE, str(size)) or not 1024 <= size <= 10000000:
            raise Refusal("Cloud turn render route contextSize is not allowed")
        out["contextSize"] = size
    if "label" in route:
        if not shaped(LABEL_SHAPE, route["label"]):
            raise Refusal("Cloud turn render route label is not allowed")
        out["label"] = route["label"]
    if "headers" in route:
        # The Flux Memory headers of the decided Codex provider table, rendered as its http_headers (Codex only).
        if engine != "codex" or not _memory_headers(route["headers"]):
            raise Refusal("Cloud turn render route headers are not allowed")
        out["headers"] = dict(route["headers"])
    if "models" in route:
        models = route["models"]
        if engine != "opencodeGo" or not isinstance(models, list) or not 1 <= len(models) <= 64 or not all(model_id(m) for m in models) or len(set(models)) != len(models):
            raise Refusal("Cloud turn render route models are not allowed")
        out["models"] = list(models)
    return out

def validate_mcp(engine, mcp):
    if not isinstance(mcp, dict):
        raise Refusal("Cloud turn render mcp is not an object")
    if len(mcp) > MCP_MAX:
        raise Refusal("Cloud turn render has too many MCP servers")
    out, names, size = {}, set(), 0
    for name, stanza in mcp.items():
        if not shaped(NAME_SHAPE, name):
            raise Refusal("Cloud turn MCP server name is not allowed")
        if not isinstance(stanza, dict) or set(stanza) - STANZA_KEYS:
            raise Refusal("Cloud turn MCP server has an unknown key")
        kind = stanza.get("proxy")
        if not isinstance(kind, str) or kind not in MCP_PROXIES:
            raise Refusal("Cloud turn MCP server kind is not allowed")
        row = MCP_PROXIES[kind]
        entry = {"proxy": kind, "ask": False}
        for key in ("socket", "server", "url"):
            if (key in stanza) != (row["arg"] == key):
                raise Refusal("Cloud turn MCP server " + key + " is not allowed")
        if row["arg"] == "socket":
            if not shaped(BROKER_SOCKET_SHAPE, stanza["socket"]):
                raise Refusal("Cloud turn MCP server socket is outside /data/broker")
            entry["socket"] = stanza["socket"]
        elif row["arg"] == "server":
            if not shaped(NAME_SHAPE, stanza["server"]):
                raise Refusal("Cloud turn MCP server server is not allowed")
            entry["server"] = stanza["server"]
        elif row["arg"] == "url":
            if not shaped(HTTPS_URL_SHAPE, stanza["url"]):
                raise Refusal("Cloud turn MCP server url is not allowed")
            entry["url"] = stanza["url"]
        if "ask" in stanza:
            if not isinstance(stanza["ask"], bool):
                raise Refusal("Cloud turn MCP server ask is not allowed")
            entry["ask"] = stanza["ask"]
        env = stanza.get("env", {})
        if not isinstance(env, dict):
            raise Refusal("Cloud turn MCP server env is not an object")
        for key, value in env.items():
            if key not in row["env"]:
                raise Refusal("Cloud turn MCP env name is not allowed for its proxy")
            if not secret_value(value):
                raise Refusal("Cloud turn MCP env value is not allowed")
            names.add(key)
            size += len(key) + len(value.encode("utf-8")) + 2
        entry["env"] = dict(env)
        out[name] = entry
    if len(names) > PROXY_ENV_NAMES_MAX:
        raise Refusal("Cloud turn MCP env has too many names")
    if size > PROXY_ENV_MAX:
        raise Refusal("Cloud turn MCP env exceeds its limit")
    return out

def proxy_script(kind, manifest_path=ENGINE_MANIFEST, manifest_uid=0, cache_root=None):
    """The kind's script, root-owned, immutable and matching its manifest digest
    (engine-manifest.json "mcpProxies"), the same checks manifest_command makes."""
    cache_root = DIGEST_CACHE if cache_root is None else cache_root
    path = MCP_PROXY_ROOT + "/" + MCP_PROXIES[kind]["script"] + ".js"
    try:
        real = immutable_path(path, manifest_uid)
        immutable_path(NODE, manifest_uid)
    except FileNotFoundError:
        raise Refusal("Cloud MCP proxy is missing")
    immutable_path(manifest_path, manifest_uid)
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != manifest_uid or info.st_mode & 0o022:
            raise Refusal("Cloud engine manifest must be root-owned and immutable")
        manifest = json.load(stream)
    entries = manifest.get("mcpProxies") if isinstance(manifest, dict) else None
    entry = next((item for item in entries if isinstance(item, dict) and item.get("path") == path), None) if isinstance(entries, list) else None
    if not entry or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64:
        raise Refusal("Cloud MCP proxy is not listed")
    fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != manifest_uid or info.st_mode & 0o022:
            raise Refusal("Cloud MCP proxy is not immutable")
        stamp = file_stamp(info)
        if not cached_digest(cache_root, manifest_uid, real, stamp, entry["sha256"]):
            if hash_stream(stream) != entry["sha256"]:
                raise Refusal("Cloud MCP proxy digest mismatch")
            store_digest(cache_root, manifest_uid, real, stamp, entry["sha256"])
    return path

def validate_render(engine, render, unit, login=False, manifest_path=ENGINE_MANIFEST, manifest_uid=0, cache_root=None):
    """The request's `render` (design 2.3), validated as a whole before any filesystem
    work. Returns the launcher's own copy; any unknown key, wrong type or value outside
    its shape refuses the turn."""
    out = {"engine": engine, "unit": unit, "login": bool(login), "route": None, "mcp": {}, "systemPrompt": None, "memoryTools": False, "resume": None, "codexPolicy": None}
    if render is None:
        return out
    if login:
        raise Refusal("Cloud login request carries render")
    if not isinstance(render, dict):
        raise Refusal("Cloud turn render is not an object")
    try:
        encoded = len(json.dumps(render, ensure_ascii=False).encode("utf-8"))
    except (UnicodeEncodeError, ValueError):
        raise Refusal("Cloud turn render is not valid UTF-8")
    if encoded > RENDER_MAX:
        raise Refusal("Cloud turn render exceeds its limit")
    parts = RENDER_PARTS.get(engine)
    if parts is None:
        if render:
            raise Refusal("Cloud engine takes no render")
        return out
    for key in render:
        if key not in parts:
            raise Refusal("Cloud turn render part is not allowed: " + key if key in {"route", "mcp", "systemPrompt", "memoryTools", "resume", "codexPolicy"} else "Cloud turn render has an unknown key")
    if "route" in render:
        out["route"] = validate_route(engine, render["route"])
    if "mcp" in render:
        out["mcp"] = validate_mcp(engine, render["mcp"])
        for stanza in out["mcp"].values():
            if MCP_PROXIES[stanza["proxy"]]["script"] is not None:
                stanza["script"] = proxy_script(stanza["proxy"], manifest_path, manifest_uid, cache_root)
    if "systemPrompt" in render:
        if not text_value(render["systemPrompt"]):
            raise Refusal("Cloud turn system prompt is not allowed")
        out["systemPrompt"] = render["systemPrompt"]
    if "memoryTools" in render:
        if not isinstance(render["memoryTools"], bool):
            raise Refusal("Cloud turn render memoryTools is not allowed")
        out["memoryTools"] = render["memoryTools"]
    if "resume" in render:
        # r4: the thread Codex will resume over the protocol (thread/resume), so the launcher
        # copies that one rollout into the turn's home (PERSISTED_STATE) and no other.
        if not shaped(UUID_SHAPE, render["resume"]):
            raise Refusal("Cloud turn render resume is not allowed")
        out["resume"] = render["resume"]
    if "codexPolicy" in render:
        # r5 R5.3 / r6 R3: the approval policy and sandbox this turn runs under. A resumed
        # rollout's turn_context records are rendered to these values on stage, so a record
        # a previous turn left can never loosen the next one.
        policy = render["codexPolicy"]
        if not isinstance(policy, dict) or set(policy) != {"approval", "sandbox"} or not isinstance(policy["approval"], str) or not isinstance(policy["sandbox"], str) \
                or policy["approval"] not in CODEX_APPROVALS or policy["sandbox"] not in CODEX_SANDBOX_POLICY:
            raise Refusal("Cloud turn render codexPolicy is not allowed")
        out["codexPolicy"] = {"approval": policy["approval"], "sandbox": policy["sandbox"]}
    if out["resume"] is not None and out["codexPolicy"] is None:
        raise Refusal("Cloud turn names no Codex policy")
    return out

def merged_proxy_env(render):
    """Every stanza's env in one map (r3 M5): a name in two stanzas with different
    values refuses the turn; equal values merge."""
    merged = {}
    for stanza in render["mcp"].values():
        for key, value in stanza["env"].items():
            if key in merged and merged[key] != value:
                raise Refusal("Cloud turn MCP env conflicts: " + key)
            merged[key] = value
    return merged

OPENCODE_AUTH_MAX = 64 * 1024
CLAUDE_TOKEN_SHAPE = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]{40,}", re.ASCII)
OPENCODE_SHADOWED = "Cloud OpenCode sign-in: key entries shadow the OAuth sign-in"

def c_credentials(home, engine):
    """The engine's C store as turns render it (r8 R3, r9 "state scopes"), read as root,
    fd-relative and O_NOFOLLOW: Claude {"token"}, Codex {"key"}, OpenCode {"api": {provider:
    entry}}; {} when the store is absent, signed out, damaged or holds a value outside its
    shape. Never staged, never collected."""
    try:
        home_fd = open_directory(home)
    except (OSError, ValueError):
        return {}
    try:
        store = signin_store(home_fd)
        try:
            _generation, record, files = store_current(store)
        finally:
            if store is not None:
                os.close(store)
    except (OSError, ValueError):
        return {}
    finally:
        os.close(home_fd)
    if record is None or record.get("kind") == "signout" or record.get("mode") is None:
        return {}
    def text(name, shape):
        try:
            value = files.get(name, b"").decode("ascii")
        except UnicodeDecodeError:
            return None
        return value if shape.fullmatch(value) else None
    if engine == "claudeAgent" and record.get("mode") == "oauth-token" and text("token", CLAUDE_TOKEN_SHAPE):
        return {"token": text("token", CLAUDE_TOKEN_SHAPE)}
    if engine == "codex" and record.get("mode") == "apikey" and text("key", LOGIN_SECRET_SHAPE):
        return {"key": text("key", LOGIN_SECRET_SHAPE)}
    if engine == "opencodeGo" and record.get("mode") == "api":
        entries = json_object(files.get("auth.json", b"")) or {}
        api = {provider: {"type": "api", "key": entry["key"]} for provider, entry in entries.items()
               if LOGIN_PROVIDER_SHAPE.fullmatch(provider) and isinstance(entry, dict) and entry.get("type") == "api"
               and isinstance(entry.get("key"), str) and LOGIN_SECRET_SHAPE.fullmatch(entry["key"])}
        return {"api": api} if api else {}
    return {}

def signin_environment(engine, env, render):
    """Applied after engine_environment(): the C store's sign-in is the only source of these
    variables (r8 R3.1, r9 "H Codex C"). Claude: CLAUDE_CODE_OAUTH_TOKEN from the store,
    else unset. Codex in key mode: neither OPENAI_API_KEY nor CODEX_API_KEY (app-server
    ignores the override; the key reaches Codex only in the rendered auth.json)."""
    credentials = (render.get("credentials") or {}) if isinstance(render, dict) else {}
    env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    env.pop("CODEX_API_KEY", None)
    if engine == "claudeAgent" and credentials.get("token"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = credentials["token"]
    if engine == "codex" and credentials.get("key"):
        env.pop("OPENAI_API_KEY", None)
    return env

def opencode_oauth_staged(home, bot):
    """True when the bot's B store holds an OpenCode oauth entry (the mixed-providers case)."""
    if bot is None:
        return False
    try:
        home_fd = open_directory(home)
    except (OSError, ValueError):
        return False
    try:
        store = signin_store(home_fd, bot)
        try:
            _generation, record, files = store_current(store)
        finally:
            if store is not None:
                os.close(store)
    except (OSError, ValueError):
        return False
    finally:
        os.close(home_fd)
    entries = json_object(files.get(".local/share/opencode/auth.json", b"")) if record is not None else None
    return any(isinstance(entry, dict) and entry.get("type") == "oauth" for entry in (entries or {}).values())

def render_environment(engine, home, render):
    """Environment the templates need, composed by the launcher (pinned): OpenCode's auth
    content and Codex's MCP proxy variables (named by env_vars in its config.toml).

    r9 "OpenCode": OPENCODE_AUTH_CONTENT is set only when the C store holds an `api` entry
    or the turn carries a route, and then carries exactly those entries plus the route.
    Otherwise it is unset, so OpenCode reads the staged auth.json (the bot's B store): even
    `{}` would hide those oauth entries (OpenCode returns the variable's map instead)."""
    env = {}
    if engine == "opencodeGo" and not render["login"]:
        auth = dict(((render.get("credentials") or {}).get("api") or {}))
        route = render["route"]
        if route:
            auth[route["provider"]] = {"type": "api", "key": route["apiKey"]}
        if auth:
            env["OPENCODE_AUTH_CONTENT"] = json.dumps(auth, sort_keys=True)
    if engine == "codex" and render["mcp"]:
        env.update(merged_proxy_env(render))
    return env

def toml_string(value):
    # JSON string escapes are valid TOML basic-string escapes.
    return json.dumps(value)

def json_text(value):
    return json.dumps(value, separators=(",", ":")) + "\n"

FUIGO_PINS = "[plugins]\nauto_discover = false\n[claude_compat]\nimported = true\n"
FUIGO_REQUIREMENTS = "[plugins]\nauto_discover = false\n[cli]\nuse_leader = false\n[claude_compat]\nimported = true\n"
FUIGO_MANAGED_CONFIG = "# managed by the Murage launcher\n"
FUIGO_MEMORY_TOOLS = ("memory_search", "memory_get", "memory_save", "memory_propose_correction")
OPENCODE_BASE = {"$schema": "https://opencode.ai/config.json", "autoupdate": False}
OPENCODE_COMPAT_NPM = "@ai-sdk/openai-compatible"
EMPTY_MCP = '{"mcpServers":{}}'

def claude_mcp_text(render):
    servers = {}
    for name, stanza in render["mcp"].items():
        row = MCP_PROXIES[stanza["proxy"]]
        if row["script"] is None:
            servers[name] = {"type": "http", "url": stanza["url"]}
            continue
        args = [stanza["script"]] + ([stanza["socket"]] if row["arg"] == "socket" else ["--server", stanza["server"]] if row["arg"] == "server" else [])
        servers[name] = {"command": NODE, "args": args, "env": {"ELECTRON_RUN_AS_NODE": "1", **stanza["env"]}}
    return json.dumps({"mcpServers": servers}, separators=(",", ":"))

def codex_config_text(render):
    text = "check_for_update_on_startup = false\n"
    route = render["route"]
    if route:
        text += "[model_providers." + route["provider"] + "]\nname = " + toml_string(route.get("label", "Selected provider")) + "\nbase_url = " + toml_string(route["baseUrl"]) + \
            "\nwire_api = \"responses\"\nenv_key = \"MURAGE_PROVIDER_API_KEY\"\n"
        if route.get("headers"):
            text += "http_headers = { " + ", ".join(toml_string(k) + " = " + toml_string(v) for k, v in sorted(route["headers"].items())) + " }\n"
    for name, stanza in render["mcp"].items():
        row = MCP_PROXIES[stanza["proxy"]]
        text += "[mcp_servers." + name + "]\n"
        if row["script"] is None:
            text += "url = " + toml_string(stanza["url"]) + "\n"
        else:
            args = [stanza["script"]] + ([stanza["socket"]] if row["arg"] == "socket" else ["--server", stanza["server"]] if row["arg"] == "server" else [])
            text += "command = " + toml_string(NODE) + "\nargs = [" + ", ".join(toml_string(a) for a in args) + "]\n"
            text += "env = { ELECTRON_RUN_AS_NODE = \"1\" }\nenv_vars = [" + ", ".join(toml_string(k) for k in sorted(stanza["env"])) + "]\n"
        text += "tool_timeout_sec = " + str(CODEX_MCP_TOOL_TIMEOUT_SEC) + "\n"
        text += ("startup_timeout_sec = " + str(CODEX_CUSTOM_MCP_STARTUP_TIMEOUT_SEC) + "\n") if stanza["ask"] else "default_tools_approval_mode = \"auto\"\n"
    return text

def fuigo_full_access(args):
    """Full access is exactly `--permission-mode bypassPermissions` (the owner's own choice); anything else asks."""
    return any(arg == "--permission-mode" and args[i + 1:i + 2] == ["bypassPermissions"] for i, arg in enumerate(args))

def fuigo_config_text(render):
    text = "[cli]\nuse_leader = false\n" + FUIGO_PINS
    route = render["route"]
    if route:
        name = route["provider"]
        text += "[models]\ndefault = \"murage_selected\"\nsession_summary = \"murage_selected\"\nprompt_suggestion = \"murage_selected\"\nweb_search = \"murage_selected\"\n" \
            "image_description = \"murage_selected\"\nallowed_models = [\"murage_selected\"]\n[model_providers." + name + "]\nbase_url = " + toml_string(route["baseUrl"]) + \
            "\nenv_key = \"MURAGE_PROVIDER_API_KEY\"\napi_backend = \"" + ROUTE_PROTOCOLS[route["protocol"]] + "\"\nauth_scheme = \"" + \
            ("x_api_key" if route["protocol"] == "anthropic" else "bearer") + "\"\n[model.murage_selected]\nmodel = " + toml_string(route["model"]) + \
            "\nmodel_provider = \"" + name + "\"\n"
    # Fuigo 1.0.32: `ask = ["Bash"]` sends every shell command to Murage as a permission request, past the
    # engine's own read-only auto-allow. Rules are order-independent (deny > ask > allow; resolution.rs), so
    # no workspace allow or bypass defaultMode lifts it, and this file is mounted read-only for the turn.
    # A render without the flag (the template check) asks too.
    ask = render.get("bashAsk", True)
    if ask or render["memoryTools"]:
        text += "\n[permission]\n"
        if ask:
            text += "ask = [\"Bash\"]\n"
        if render["memoryTools"]:
            rules = ",\n".join("{ action = \"allow\", tool = \"mcp\", pattern = \"murage-memory__" + tool + "\" }" for tool in FUIGO_MEMORY_TOOLS)
            text += "rules = [\n" + rules + "\n]\n"
    return text

def opencode_config_text(render):
    config = dict(OPENCODE_BASE)
    route = render["route"]
    if route:
        # No options.apiKey: the key reaches OpenCode only in OPENCODE_AUTH_CONTENT (r2 H1).
        models = route.get("models") or [route["model"]]
        config["provider"] = {route["provider"]: {"npm": OPENCODE_COMPAT_NPM, "name": route.get("label", route["provider"]),
                              "options": {"baseURL": route["baseUrl"]}, "models": {model: {"name": model} for model in models}}}
    return json_text(config)

# Rendered destinations by symbolic name. PARSED files are read by an interpolating or
# structured parser and get the post-render scan; PLAIN files are read by nothing that
# interpolates (r3 N1: only Claude's --append-system-prompt-file text).
PARSED_FILES = frozenset({
    "claude.settings", "claude.settings.local", "claude.mcp",
    "codex.config", "codex.auth",
    "grok.config",
    "kimi.config", "kimi.tui", "kimi.mcp", "kimi.cwd.local", "kimi.cwd.mcp",
    "opencode.config", "opencode.gitignore",
    "fuigo.config", "fuigo.managed", "fuigo.requirements", "fuigo.sandbox", "fuigo.trusted-plugins", "fuigo.trusted-hook-projects", "fuigo.claude-json",
})
PLAIN_FILES = frozenset({"claude.prompt"})
RENDER_SCAN = ("{env:", "{file:", "${")

def check_rendered_tables():
    if PARSED_FILES & PLAIN_FILES:
        raise ValueError("Cloud rendered file is both parsed and plain")
    # r8 R3.1 / r9 "H Codex C": these come only from the C store, never from a request.
    if any(name in names for names in ENGINE_ENV_ALLOW.values() for name in ("CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY")):
        raise ValueError("Cloud engine allowlist names a C-store sign-in variable")
    for engine, names in TEMPLATE_ENV_KEYS.items():
        for name in names:
            if name not in ENGINE_ENV_ALLOW.get(engine, frozenset()):
                raise ValueError("Cloud template env_key is not deliverable: " + name)
    check_env_allowlist({"proxies": PROXY_ENV})
    taken = COMMON_ENV.union(*ENGINE_ENV_ALLOW.values(), *(frozenset(pin) for pin in ENGINE_ENV_PIN.values()),
                             {"HOME", "USERPROFILE", "TMPDIR", "PATH", "FUIGO_HOME", "OPENCODE_AUTH_CONTENT", "ELECTRON_RUN_AS_NODE", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"})
    if PROXY_ENV & taken:
        raise ValueError("Cloud MCP proxy env name is also an engine name: " + " ".join(sorted(PROXY_ENV & taken)))
    for template in (FUIGO_REQUIREMENTS, fuigo_config_text({"route": None, "memoryTools": False})):
        for pin in ("[plugins]\nauto_discover = false\n", "use_leader = false\n", "[claude_compat]\nimported = true\n"):
            if pin not in template:
                raise ValueError("Cloud Fuigo template is missing a pin")
    for bad in ("/model", ":model", "../model", ".model", "a/../b", "a//b", "-m"):
        if model_id(bad):
            raise ValueError("Cloud MODEL_ID admits a path shape")

check_rendered_tables()

def grant_root(path, home):
    if path == home or path.startswith(home + "/"):
        return home
    if path.startswith(WORKSPACE_ROOT + "/"):
        return WORKSPACE_ROOT + "/" + path[len(WORKSPACE_ROOT) + 1:].split("/")[0]
    raise Refusal("Cloud turn directory is outside its grant")

def directory_chain(path, home):
    """`path` and each parent up to its grant root ($home or /data/home/workspaces/<ws>), inclusive."""
    root = grant_root(path, home)
    chain = [path]
    while path != root:
        path = os.path.dirname(path)
        chain.append(path)
        if len(chain) > CHAIN_MAX:
            raise Refusal("Cloud turn directory is too deep")
    return chain

def add_dirs(args):
    return [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--add-dir"] + [a[len("--add-dir="):] for a in args if a.startswith("--add-dir=")]

# r5 R5.1: the union of every engine's project config directory names. Every turn masks
# all of them in every workspace directory it binds, whatever its engine, so a sibling
# turn of another engine also holds a mount point there.
MASK_NAMES = (".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode")
PLACEHOLDER_ATTEMPTS = 8
PLACEHOLDER_OPEN = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# Test seam: called as PLACEHOLDER_RACE(dfd, name) after this launcher's own mkdirat and
# open, where a concurrent rmdir would land (interleaving M6). None in production.
PLACEHOLDER_RACE = None

def ensure_placeholder(dfd, name, immutable=set_immutable):
    """r5 R5.1: a tmpfs mask is a mount on a dentry of the shared workspace, and Linux lets
    a writer in another namespace rmdir or rename that dentry, taking the mask with it
    (an ancestor-cwd turn is such a writer). So root first makes <dir>/<name> an immutable
    directory, which nobody can remove, rename, enter or replace, and bwrap mounts the mask
    over it (mounting does not modify the directory). Permanent on purpose: only the
    release mode clears the flag, and a reset or undo (murage-commands finish_swap) with
    every writer stopped, which freezes each one again where it lands. A directory created here is root 0555; one that
    already exists keeps its owner, mode and content (an owner's repository .claude/ stays
    on disk, hidden by the tmpfs). Fd-relative throughout; the placed object is verified to
    be the inode that was frozen, and a name that keeps changing under us refuses the turn.
    Returns True when this call created the directory."""
    for _attempt in range(PLACEHOLDER_ATTEMPTS):
        created = False
        try:
            fd = os.open(name, PLACEHOLDER_OPEN, dir_fd=dfd)
        except FileNotFoundError:
            try:
                os.mkdir(name, 0o555, dir_fd=dfd)
            except FileExistsError:
                continue  # another launcher (M7) or a writer got there first: look again
            try:
                fd = os.open(name, PLACEHOLDER_OPEN, dir_fd=dfd)
            except FileNotFoundError:
                continue
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise Refusal("Cloud turn mask path is not a plain directory: " + name)
                raise
            created = True
            if PLACEHOLDER_RACE is not None:
                PLACEHOLDER_RACE(dfd, name)
        except OSError as error:
            # A symlink, file, FIFO or socket at the name: left in place for the owner.
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Refusal("Cloud turn mask path is not a plain directory: " + name)
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode):
                raise Refusal("Cloud turn mask path is not a plain directory: " + name)
            if not inode_flags(fd) & FS_IMMUTABLE_FL:
                immutable(fd)
            # An rmdir between the open and here leaves st_nlink 0; a replacement leaves
            # another inode at the name. Either way, start over.
            try:
                placed = os.stat(name, dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if os.fstat(fd).st_nlink >= 2 and (placed.st_dev, placed.st_ino) == (info.st_dev, info.st_ino):
                return created
        finally:
            os.close(fd)
    raise Refusal("Cloud turn mask path is contested: " + name)

def placeholder_dirs(engine, home, cwd, args):
    """Every workspace directory the plan binds and masks in: the cwd and each Claude
    --add-dir (render_plan masks MASK_NAMES in exactly these)."""
    dirs = [cwd] + (add_dirs(args) if engine == "claudeAgent" else [])
    return [d for i, d in enumerate(dirs) if d != home and d.startswith(WORKSPACE_ROOT + "/") and d not in dirs[:i]]

def ensure_placeholders(directories, anchors=()):
    """Root, after anchor_mounts and before the privilege drop. An anchored directory is
    opened through its anchor, the inode the turn will actually bind, so a rename of the
    path since it was pinned cannot send the placeholders elsewhere."""
    by_destination = {destination: path for path, destination in anchors}
    for directory in directories:
        dfd = open_directory(by_destination.get(directory, directory))
        try:
            for name in MASK_NAMES:
                ensure_placeholder(dfd, name, immutable=set_immutable)
        finally:
            os.close(dfd)

def regroup_workspace(rootfd, server_uid, turn_gid):
    """Re-group the server-owned part of a workspace tree for the turn (group rw, setgid
    directories). A MASK_NAMES entry is neither changed nor entered: a placeholder is
    immutable (fchown would fail with EPERM), and what an owner keeps inside one is
    never shown to an engine anyway."""
    for _directory, dirs, files, dirfd in os.fwalk(".", dir_fd=rootfd, follow_symlinks=False):
        dirs[:] = [d for d in dirs if d not in MASK_NAMES]
        for entry in ["."] + [f for f in files if f not in MASK_NAMES]:
            try:
                fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
            except OSError:
                continue
            try:
                st = os.fstat(fd)
                if st.st_uid == server_uid and (stat.S_ISDIR(st.st_mode) or (stat.S_ISREG(st.st_mode) and st.st_nlink == 1)):
                    os.fchown(fd, -1, turn_gid)
                    os.fchmod(fd, stat.S_IMODE(st.st_mode) | ((st.st_mode & 0o700) >> 3) | (stat.S_ISGID if stat.S_ISDIR(st.st_mode) else 0))  # setgid: new files keep group murage-turn though the turn's egid is the engine group
            finally:
                os.close(fd)

def workspace_masks(files, shadows):
    """r4: a mask is never conditional on what exists. The old check-then-mount (mount a
    workspace mask only over a path that already exists) left a window in which another
    turn could create <cwd>/.claude/settings.json after the check and before bwrap ran,
    and the shared writable workspace then showed it to this turn's engine (Astra r2 H).
    Every mask is mounted every turn; bwrap creates a missing mount point itself, so an
    absent mask directory leaves one empty, turn-owned dot-directory in the owner's folder
    (never a file: no rendered file is placed in the workspace outside a shadow, asserted
    here). That empty directory is not removed afterwards on purpose: rmdir from outside a
    running turn's namespace would detach that turn's mask (Linux detach_mounts) and
    reopen exactly the window this closes. A mask path that exists as a symlink refuses
    the turn (a courtesy message; bwrap would fail on a dangling one anyway)."""
    def in_workspace(path):
        return path.startswith(WORKSPACE_ROOT + "/")
    for path in shadows:
        if in_workspace(path):
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise Refusal("Cloud turn mask path is not a plain directory: " + os.path.basename(path))
    for path, _text, _name in files:
        if in_workspace(path) and not any(path.startswith(shadow + "/") for shadow in shadows):
            raise Refusal("Cloud rendered file would land in the workspace")
    return files, shadows

def render_plan(engine, home, cwd, render, scratch=(), extra_dirs=()):
    """Every file and shadow of a turn: (files [(path, text, name)], shadows [dir]).
    Files are bound read-only (--ro-bind-data); shadows are empty tmpfs mounts
    remounted read-only. Only launcher constants and validated parts reach a file.

    r4: project-level files that sit directly in a workspace directory are not masked
    with a file bind (that would create an empty file in the owner's folder); each is
    closed by a pin the grammar or the environment makes mandatory instead, and
    check_rendered_tables asserts those pins hold: Claude's <dir>/.mcp.json by the
    required --strict-mcp-config, OpenCode's <cwd>/opencode.json(c) by the pinned
    OPENCODE_DISABLE_PROJECT_CONFIG=1, Fuigo's <dir>/.mcp.json and <dir>/.cursor by the
    19 compat gates pinned to 0 plus the rendered [claude_compat] imported = true and
    [plugins] auto_discover = false tiers (r2 R3 closures 1 and 2)."""
    files, shadows, staged = [], [], {}
    def put(path, text, name):
        # cwd == $home makes a project mask and a home file the same path: one bind.
        if path in staged:
            if staged[path] != text:
                raise Refusal("Cloud rendered file is staged twice")
            return
        staged[path] = text
        files.append((path, text, name))
    def shadow(path):
        if path not in shadows:
            shadows.append(path)
    chain = directory_chain(cwd, home)
    rdir = render_dir(render)
    if engine == "claudeAgent":
        put(home + "/.claude/settings.json", "{}\n", "claude.settings")
        put(home + "/.claude/settings.local.json", "{}", "claude.settings.local")
        if render["mcp"]:
            put(rdir + "/mcp.json", claude_mcp_text(render), "claude.mcp")
        if render["systemPrompt"] is not None:
            put(rdir + "/prompt.txt", render["systemPrompt"], "claude.prompt")
        # r3 M3: project settings above cwd and under --add-dir are masked too.
        for directory in chain + [d for d in extra_dirs if d not in chain]:
            if directory != home:
                shadow(directory + "/.claude")
    elif engine == "codex":
        put(home + "/.codex/config.toml", codex_config_text(render), "codex.config")
        key = (render.get("credentials") or {}).get("key")
        if key:
            # r9 "H Codex C": key mode is a read-only rendered auth.json holding exactly the
            # key (app-server ignores CODEX_API_KEY); an engine write fails on the bind.
            put(home + "/.codex/auth.json", json.dumps({"OPENAI_API_KEY": key}), "codex.auth")
        # r3 M4: project .codex layers from cwd to the grant root.
        for directory in chain:
            if directory != home:
                shadow(directory + "/.codex")
    elif engine == "grokAgent":
        put(home + "/.grok/config.toml", "[cli]\nauto_update = false\n", "grok.config")
        # r5: Grok Build is the binary Fuigo is rebranded from, and its project loader reads
        # <dir>/.grok/config.toml from cwd up to the repository root (project_config.rs,
        # find_project_configs) and, through its Claude compatibility, <dir>/.claude, so the
        # chain is shadowed as Fuigo's is. Names checked against xai-org/grok-build main
        # (d7f2fa79; the repository carries no 1.0.52 tag). $home/.grok is the turn's own state.
        for directory in chain:
            if directory != home:
                shadow(directory + "/.grok")
                shadow(directory + "/.claude")
    elif engine == "kimiAgent":
        put(home + "/.kimi-code/config.toml", "hooks = []\n", "kimi.config")
        put(home + "/.kimi-code/tui.toml", '[upgrade]\nauto_install = false\n[status_line]\ncommand = ""\n', "kimi.tui")
        put(home + "/.kimi-code/mcp.json", EMPTY_MCP, "kimi.mcp")
        if cwd != home:
            shadow(cwd + "/.kimi-code")
        put(cwd + "/.kimi-code/local.toml", "", "kimi.cwd.local")
        put(cwd + "/.kimi-code/mcp.json", EMPTY_MCP, "kimi.cwd.mcp")
    elif engine == "opencodeGo":
        text = opencode_config_text(render)
        # The shadow directories are read-only, and OpenCode writes a .gitignore into
        # every config directory it loads unless one already exists (OPENCODE_GITIGNORE
        # above), so the file is staged in each. ~/.opencode is a config directory
        # OpenCode loads whenever it exists, so it is shadowed with the same content.
        for directory in [home + "/.config/opencode", home + "/.opencode"] + ([cwd + "/.opencode"] if cwd != home else []):
            shadow(directory)
        for name in ["opencode.json", "opencode.jsonc", "config.json"]:
            put(home + "/.config/opencode/" + name, text, "opencode.config")
        put(home + "/.config/opencode/.gitignore", OPENCODE_GITIGNORE, "opencode.gitignore")
        for name in ["opencode.json", "opencode.jsonc"]:
            put(home + "/.opencode/" + name, text, "opencode.config")
        put(home + "/.opencode/.gitignore", OPENCODE_GITIGNORE, "opencode.gitignore")
        for name in ["opencode.json", "opencode.jsonc"]:
            put(cwd + "/.opencode/" + name, text, "opencode.config")
        put(cwd + "/.opencode/.gitignore", OPENCODE_GITIGNORE, "opencode.gitignore")
    elif engine == "fuigoAgent":
        state = fuigo_home(home, list(scratch))
        # r2 R2: every tier is rendered read-only or an empty read-only shadow.
        put(state + "/config.toml", fuigo_config_text(render), "fuigo.config")
        put(state + "/managed_config.toml", FUIGO_MANAGED_CONFIG, "fuigo.managed")
        put(state + "/requirements.toml", FUIGO_REQUIREMENTS, "fuigo.requirements")
        put(state + "/sandbox.toml", "", "fuigo.sandbox")
        put(state + "/trusted-plugins", "", "fuigo.trusted-plugins")
        put(state + "/trusted-hook-projects", "", "fuigo.trusted-hook-projects")
        shadow(state + "/plugins")
        # r3 N2: the chain shadow excludes the turn's own $FUIGO_HOME (the writable
        # state mount on an unrouted turn); on a routed turn $home/.fuigo is shadowed.
        if state != home + "/.fuigo":
            shadow(home + "/.fuigo")
        # r2 R3: every path the Claude/Cursor/Codex import would read is masked.
        for name in [".claude", ".cursor", ".codex", ".agents"]:
            shadow(home + "/" + name)
        put(home + "/.claude.json", "{}", "fuigo.claude-json")
        for directory in chain:
            if directory + "/.fuigo" != state:
                shadow(directory + "/.fuigo")
            if directory != home:
                shadow(directory + "/.claude")
    # r5 R5.1: every engine masks every MASK_NAMES name in each workspace directory it binds
    # (placeholder_dirs), over the placeholders root has placed there.
    for directory in [cwd] + [d for d in extra_dirs if d != cwd]:
        if directory != home and directory.startswith(WORKSPACE_ROOT + "/"):
            for name in MASK_NAMES:
                shadow(directory + "/" + name)
    files, shadows = workspace_masks(files, shadows)
    for path, text, name in files:
        if name not in PARSED_FILES and name not in PLAIN_FILES:
            raise Refusal("Cloud rendered file is not classified")
        if os.path.normpath(path) != path:
            raise Refusal("Cloud rendered file path is not canonical")
        # Post-render scan over every parsed file (r2 R1, r3 N1): a future template edit
        # cannot reintroduce an interpolation token by accident.
        if name in PARSED_FILES and any(token in text for token in RENDER_SCAN):
            raise Refusal("Cloud rendered file carries an interpolation token")
    return files, shadows

# ---------------------------------------------------------------------------
# Argv allowlist (design 4). One grammar per engine; a single left-to-right pass where
# each token is a listed literal in its expected position, a listed flag with exactly
# one value when its Shape is not None, or a --flag=value form of the same. Anything
# else refuses the whole turn, naming only the flag or token kind.

class Shape:
    def __init__(self, name, check, path=False):
        self.name, self.check, self.path = name, check, path

def one_of(*values):
    allowed = frozenset(values)
    return Shape("one of " + ",".join(sorted(allowed)), lambda value, render: value in allowed)

def pattern(name, regex):
    return Shape(name, lambda value, render: shaped(regex, value))

def workspace_dir(value, render):
    try:
        canonical_path(value)
    except ValueError:
        return False
    return value.startswith(WORKSPACE_ROOT + "/") and os.path.realpath(value) == value and os.path.isdir(value) and not casefolded(value)

def render_part(part):
    def check(value, render):
        if part == "mcp":
            return value == "@render:mcp" and bool(render["mcp"])
        return value == "@render:system-prompt" and render["systemPrompt"] is not None
    return Shape("render " + part, check, path=True)

MODEL_ID = Shape("MODEL_ID", lambda value, render: model_id(value))
EFFORT = Shape("effort", lambda value, render: value in EFFORTS)
TOOL_LIST = pattern("TOOL_LIST", TOOL_LIST_SHAPE)
UUID = pattern("UUID", UUID_SHAPE)
WORKSPACE_DIR = Shape("WORKSPACE_DIR", workspace_dir, path=True)
# Codex `-c KEY=VALUE`: only the overrides the driver emits, each with its exact value.
CODEX_OVERRIDES = {
    "features.browser_use": "false", "features.browser_use_external": "false", "features.computer_use": "false",
    "features.shell_tool": "false", "features.apps": "false", "web_search": '"disabled"',
    # codex.ts 658: Murage fences what a bot remembers, so Codex's own memories stay off (this value only).
    "features.memories": "false",
    "plugins": '{ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
}

def codex_override(value, render):
    key, sep, rest = value.partition("=")
    if not sep:
        return False
    if key == "model_context_window":
        return shaped(INT_SHAPE, rest)
    return CODEX_OVERRIDES.get(key) == rest

CODEX_C = Shape("codex override", codex_override)

class ArgvRule:
    def __init__(self, flags, required=(), repeat=(), literals=(), tail=(), first=None):
        self.flags, self.required, self.repeat, self.literals, self.tail, self.first = dict(flags), tuple(required), frozenset(repeat), tuple(literals), tuple(tail), first

PERMISSION_MODES = one_of("default", "bypassPermissions")

# grok.ts grokPluginStub: <tmpdir>/murage-grok-isolation-<6 mkdtemp chars>/<plugin name>, the name being
# PLUGIN_NAME there. Anchored, no "..", one level under the stub directory. Only Grok 1.0.50+ with a personal
# plugin emits it (the image installs 1.0.52); the stub lives in the server's tmpdir, so a turn sandbox may not
# even see it, but the exact shape is accepted for parity with the driver and nothing broader.
GROK_PLUGIN_STUB = re.compile(r"/tmp/murage-grok-isolation-[A-Za-z0-9]{6}/(?!\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
def grok_plugin_stub(value, render):
    return GROK_PLUGIN_STUB.fullmatch(value) is not None and ".." not in value
GROK_PLUGIN_DIR = Shape("grok plugin stub", grok_plugin_stub, path=True)
ARGV_RULES = {
    # claude.ts 1427-1871
    "claudeAgent": ArgvRule({
        "-p": None, "--output-format": one_of("stream-json"), "--input-format": one_of("stream-json"), "--verbose": None,
        "--include-partial-messages": None, "--strict-mcp-config": None,
        "--permission-mode": one_of("default", "acceptEdits", "plan", "bypassPermissions"), "--model": MODEL_ID, "--effort": EFFORT,
        "--tools": TOOL_LIST, "--allowedTools": TOOL_LIST, "--disallowedTools": TOOL_LIST, "--add-dir": WORKSPACE_DIR,
        "--resume": UUID, "--session-id": UUID, "--permission-prompt-tool": one_of("mcp__muragebox__approve"),
        "--mcp-config": render_part("mcp"), "--append-system-prompt-file": render_part("systemPrompt"),
    }, required=("-p", "--output-format", "--input-format", "--verbose", "--include-partial-messages", "--strict-mcp-config"), repeat=("--add-dir",)),
    # codex.ts 232-250, 516-531; routes and MCP servers are rendered, never -c
    "codex": ArgvRule({"-c": CODEX_C}, repeat=("-c",), literals=("app-server",), first="app-server"),
    # grok.ts 248-257, 438 (--no-memory: Murage owns persistent memory), 373-385 (--no-leader; --plugin-dir stub per personal plugin)
    "grokAgent": ArgvRule({"--permission-mode": PERMISSION_MODES, "--no-memory": None, "--no-leader": None, "--plugin-dir": GROK_PLUGIN_DIR,
                           "-m": MODEL_ID, "--reasoning-effort": EFFORT},
                          # both flags required: scopeGrokHome (applyMountEnv) rejects an unknown or <1.0.50 CLI before spawn, so spawnArgs always emits both on a home
                          required=("--permission-mode", "--no-memory", "--no-leader"), repeat=("--plugin-dir",), literals=("agent", "stdio"), tail=("stdio",)),
    # kimi.ts 573-576
    "kimiAgent": ArgvRule({"-m": MODEL_ID}, literals=("acp",), tail=("acp",)),
    # opencode-go.ts: exactly ["acp"]
    "opencodeGo": ArgvRule({}, literals=("acp",), tail=("acp",)),
    # fuigo.ts 573-603
    "fuigoAgent": ArgvRule({"--permission-mode": PERMISSION_MODES, "--trust": None, "--no-memory": None, "--no-leader": None, "-m": MODEL_ID, "--reasoning-effort": EFFORT},
                           required=("--permission-mode", "--no-memory", "--no-leader"), literals=("agent", "stdio"), tail=("stdio",)),
}

# Exact argv the server runs outside a turn on a home (health, sign-in and model probes):
# each is a whole list, compared as a whole (index.ts testCliBinary and the drivers'
# --version probes, claude.ts claudeSignedIn `auth status --json`, codex.ts `login status`,
# opencode-go.ts `models`, fuigo.ts `models`).
ARGV_PROBES = {
    "claudeAgent": (["--version"], ["auth", "status", "--json"]),
    "codex": (["--version"], ["login", "status"]),
    "grokAgent": (["--version"],),
    "kimiAgent": (["--version"],),
    "opencodeGo": (["--version"], ["models"], ["models", "--verbose"]),
    "fuigoAgent": (["--version"], ["models"]),
}
# Second forms an engine is started in: Claude's one-shot approval review (claude.ts
# generateReview), prompt on stdin, no tools, no MCP servers, no session file.
ARGV_ALTERNATIVES = {
    "claudeAgent": (ArgvRule({"-p": None, "--model": MODEL_ID, "--output-format": one_of("text"), "--tools": TOOL_LIST, "--strict-mcp-config": None, "--no-session-persistence": None},
                             required=("-p", "--output-format", "--strict-mcp-config", "--no-session-persistence")),),
}

def path_like(value):
    return value.startswith(("-", "/", "~", ":")) or ".." in value.split("/")

def check_argv_rules(rules=None):
    """Import-time self-check (design test 8): no non-path Shape accepts a path, and no
    flag is also a literal."""
    table = rules or {engine: (rule,) + ARGV_ALTERNATIVES.get(engine, ()) for engine, rule in ARGV_RULES.items()}
    for engine, rule in table.items():
        for rule in (rule if isinstance(rule, tuple) else (rule,)):
            if set(rule.flags) & set(rule.literals):
                raise ValueError("Cloud argv grammar lists a flag twice for " + engine)
            for flag, shape in rule.flags.items():
                if shape is not None and not shape.path and any(shape.check(v, {"mcp": {"x": {}}, "systemPrompt": ""}) for v in ("/x", "../x", "~/x")):
                    raise ValueError("Cloud argv shape accepts a path: " + flag)
    # r4: the project-level files render_plan no longer masks with a file bind are each
    # closed by a mandatory pin; a grammar or environment edit that drops one fails here.
    if "--strict-mcp-config" not in ARGV_RULES["claudeAgent"].required:
        raise ValueError("Cloud Claude grammar must require --strict-mcp-config")
    if ENGINE_ENV_PIN["opencodeGo"].get("OPENCODE_DISABLE_PROJECT_CONFIG") != "1":
        raise ValueError("Cloud OpenCode environment must pin OPENCODE_DISABLE_PROJECT_CONFIG")
    if any(ENGINE_ENV_PIN["fuigoAgent"].get(name) != "0" for name in FUIGO_COMPAT_GATES):
        raise ValueError("Cloud Fuigo environment must pin every compat gate to 0")

check_argv_rules()

def check_argv(engine, args, render, login=False):
    """Refuse every argv the engine's grammar does not name (design 4.2); substitute the
    render placeholders. Only a flag or token kind ever reaches stderr, never a value."""
    if len(args) > ARGV_MAX_TOKENS:
        raise Refusal("Cloud engine arguments exceed their token limit")
    if sum(len(arg.encode("utf-8", "surrogatepass")) + 1 for arg in args) > ARGV_MAX_BYTES:
        raise Refusal("Cloud engine arguments exceed their size limit")
    if login:
        if engine not in LOGIN_COMMANDS or args not in [list(a) for a in LOGIN_COMMANDS[engine][1].values()]:
            raise Refusal("Cloud engine argument is not allowed: login command")
        return list(args)
    rule = ARGV_RULES.get(engine)
    if rule is None:
        raise Refusal("Cloud engine argument is not allowed: engine has no grammar")
    if args in [list(probe) for probe in ARGV_PROBES.get(engine, ())]:
        return list(args)
    try:
        return match_argv(rule, args, render)
    except Refusal as error:
        for alternative in ARGV_ALTERNATIVES.get(engine, ()):
            try:
                return match_argv(alternative, args, render)
            except Refusal:
                pass
        raise error

def match_argv(rule, args, render):
    if rule.first is not None and (not args or args[0] != rule.first):
        raise Refusal("Cloud engine argument is not allowed: missing " + rule.first)
    out, seen, literal = [], {}, 0
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--":
            raise Refusal("Cloud engine argument is not allowed: --")
        if token.startswith("-"):
            name, inline = (token.split("=", 1) + [None])[:2] if token.startswith("--") and "=" in token else (token, None)
            if name not in rule.flags:
                raise Refusal("Cloud engine argument is not allowed: " + (name if re.fullmatch(r"-{1,2}[A-Za-z][A-Za-z0-9-]{0,40}", name) else "flag"))
            shape = rule.flags[name]
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1 and name not in rule.repeat:
                raise Refusal("Cloud engine argument is not allowed: repeated " + name)
            if shape is None:
                if inline is not None:
                    raise Refusal("Cloud engine argument is not allowed: " + name)
                out.append(name)
                index += 1
                continue
            if inline is None:
                if index + 1 >= len(args):
                    raise Refusal("Cloud engine argument is not allowed: " + name)
                value = args[index + 1]
                index += 2
            else:
                value = inline
                index += 1
            if (not shape.path and path_like(value)) or not shape.check(value, render):
                raise Refusal("Cloud engine argument is not allowed: " + name)
            if shape.path and value.startswith("@render:"):
                value = render_dir(render) + ("/mcp.json" if value == "@render:mcp" else "/prompt.txt")
            out += [name, value]
            continue
        if literal >= len(rule.literals) or token != rule.literals[literal]:
            raise Refusal("Cloud engine argument is not allowed: unexpected token")
        literal += 1
        out.append(token)
        index += 1
    if literal != len(rule.literals):
        raise Refusal("Cloud engine argument is not allowed: missing " + rule.literals[literal])
    for name in rule.required:
        if name not in seen:
            raise Refusal("Cloud engine argument is not allowed: missing " + name)
    if rule.tail and tuple(args[-len(rule.tail):]) != rule.tail:
        raise Refusal("Cloud engine argument is not allowed: missing " + rule.tail[-1] + " last")
    return out

# Writable-state directories per engine, relative to its home (design 3.2, r2 R2): created
# root:<engine group> 2770 by the launcher inside the turn's home and pinned as their own
# mounts there. The CLIs write their sign-ins and runtime state into them; the rendered
# files bound inside stay read-only.
STATE_DIRS_EXTRA = {"fuigoAgent": [".fuigo"]}

# r4: the state allowlist (CLOUD-ENGINES-DESIGN.md, "r4: state allowlist"; Astra r2 H x3,
# closed as a class). A turn's $HOME is a tmpfs the launcher owns and that starts empty
# (mount_turn_home). Before the turn, root copies exactly the files named below from the
# bot's own stores under the engine home into it (stage_turn_home); after the turn, root
# copies them back (collect_turn_home; r5 R5.2, r9 "state scopes"). Nothing else crosses a turn: no config, instructions, trust list,
# plugin, hook, skill, managed or requirements file, CLAUDE.md, CLI state, cache or shell
# rc file, whatever a turn wrote and wherever. The disk home is never bind-mounted into a
# turn, so a turn can only change an allowlisted file, and only within its shape.
#
# Each persisted file is non-executable data the launcher checks on the way in and on the
# way out (STATE_SHAPES): a file that fails its shape is refused (left where it is, never
# copied, its relative path on stderr) and a path the table does not name is never copied.
# What persists is what the engines need to continue: the owner's sign-in tokens
# (RECOVERY_CREDENTIALS) and the one conversation a turn resumes (Claude --resume, Codex
# thread/resume), never a whole session store.
#
# Pattern components: a literal name, "*" (one STATE_NAME), "@id" (one of the turn's own
# session ids: Claude's --resume on the way in, --resume and --session-id on the way out;
# Codex's render.resume on the way in and, since the id of a thread Codex starts is not
# known before the turn, any UUID on the way out) and "@stamp" (Codex's rollout time
# stamp). An entry without "*", "@id" or "@stamp" is an exact file: its absence after a
# turn (the CLI's own logout) removes the disk copy too.
STATE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", re.ASCII)
STATE_STAMP = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}"
STATE_FILE_MAX = 64 * 1024 * 1024    # one persisted file
STATE_TOTAL_MAX = HOME_SIZE // 2      # every persisted file of a turn together
STATE_LIST_MAX = 4096                 # entries considered in one state directory
# Claude Code's CLI state ($CLAUDE_CONFIG_DIR/.claude.json): account and onboarding facts
# only. Its projects table (allowedTools, hasTrustDialogAccepted, per-project MCP),
# mcpServers, enabledPlugins and customApiKeyResponses are grants or registries: dropped.
CLAUDE_STATE_KEYS = frozenset({"oauthAccount", "hasCompletedOnboarding", "lastOnboardingVersion", "userID", "firstStartTime", "numStartups",
                               "installMethod", "autoUpdates", "claudeMaxTier", "hasAvailableSubscription", "bypassPermissionsModeAccepted"})
# r9 "state scopes": every entry carries a scope. `bot` lives in the bot's own store,
# <engine home>/bots/<bot>/<same relative path> (root 0700, created by the first collect,
# never mounted), collected under the `store-<bot>` lock. `signin` is the bot's B-mode
# sign-in set: staged from signin_source_dir() and handed back whole to publish_signin()
# under `cred-<engine>-<bot>`. There is no engine-wide scope: the legacy files at
# <engine>/.codex/auth.json and the like are never read by a turn (r9 "B fallback"; they
# stay in RECOVERY_CREDENTIALS for cleanup only). Claude's .credentials.json and OpenCode's
# .config/opencode/auth.json are not here at all: C-mode sign-ins are rendered, never staged.
PERSISTED_STATE = {
    "claudeAgent": ((".claude/.claude.json", "claude-state", "bot"),
                    (".claude/projects/*/@id.jsonl", "claude-jsonl", "bot"), (".claude/projects/*/@id/*/*.jsonl", "claude-jsonl", "bot")),
    "codex": ((".codex/auth.json", "codex-auth", "signin"), (".codex/sessions/*/*/*/rollout-@stamp-@id.jsonl", "codex-jsonl", "bot")),
    "grokAgent": ((".grok/auth.json", "json", "signin"),),
    "kimiAgent": ((".kimi-code/credentials/*.json", "json", "signin"),),
    "opencodeGo": ((".local/share/opencode/auth.json", "opencode-auth", "signin"),),
    "fuigoAgent": (),
}
STATE_SCOPES = frozenset({"bot", "signin"})

def json_object(data):
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None

def shape_json(data):
    """A JSON object, bytes preserved."""
    return data if json_object(data) is not None else None

def shape_codex_auth(data):
    """Codex's auth.json: a JSON object whose `tokens`, when present, is an object of
    strings (the account pin reads tokens.account_id); bytes preserved."""
    value = json_object(data)
    if value is None:
        return None
    tokens = value.get("tokens", {})
    if not isinstance(tokens, dict) or not all(isinstance(item, str) for item in tokens.values()):
        return None
    return data

def shape_opencode_auth(data):
    """OpenCode's auth.json in a B store: only its `oauth` entries (engine-refreshed sign-ins,
    r9 "OpenCode"); an `api` entry belongs to the C store and is dropped. Bytes preserved
    when nothing is dropped."""
    value = json_object(data)
    if value is None:
        return None
    kept = {key: entry for key, entry in value.items() if isinstance(entry, dict) and entry.get("type") == "oauth"}
    return data if len(kept) == len(value) else json.dumps(kept, sort_keys=True).encode("utf-8")

# r5 R5.3: each retained .claude.json key has one type; a value of another type is dropped.
CLAUDE_STATE_BOOLS = frozenset({"hasCompletedOnboarding", "autoUpdates", "hasAvailableSubscription", "bypassPermissionsModeAccepted"})
CLAUDE_STATE_STRINGS = frozenset({"lastOnboardingVersion", "userID", "firstStartTime", "installMethod", "claudeMaxTier"})

def claude_state_value(key, value):
    if key == "oauthAccount":
        return isinstance(value, dict) and len(value) <= 16 and all(item is None or isinstance(item, (str, bool)) for item in value.values())
    if key in CLAUDE_STATE_BOOLS:
        return isinstance(value, bool)
    if key in CLAUDE_STATE_STRINGS:
        return isinstance(value, str) and len(value) <= 256 and value.isprintable()
    if key == "numStartups":
        return isinstance(value, int) and not isinstance(value, bool)
    return False

def shape_claude_state(data):
    """A JSON object reduced to CLAUDE_STATE_KEYS, each value of its type (re-serialised,
    so nothing else survives)."""
    value = json_object(data)
    if value is None:
        return None
    return json.dumps({key: value[key] for key in sorted(value) if key in CLAUDE_STATE_KEYS and claude_state_value(key, value[key])}, sort_keys=True).encode("utf-8")

def jsonl_records(data):
    """[(line bytes, record or None for a blank line)], or None when the file is not UTF-8,
    holds a NUL, or has a non-empty line that is not one JSON object (r5 R5.3)."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if "\0" in text:
        return None
    out = []
    for line in data.split(b"\n"):
        if not line.strip():
            out.append((line, None))
            continue
        try:
            record = json.loads(line.decode("utf-8"))
        except ValueError:
            return None
        if not isinstance(record, dict):
            return None
        out.append((line, record))
    return out

def shape_jsonl(data):
    """UTF-8 lines, each empty or one JSON object, no NUL; bytes preserved. A transcript is
    parsed by its engine on resume; the launcher checks the shape."""
    return data if jsonl_records(data) is not None else None

# Settings keys, never transcript keys: no record Claude 2.1.285 writes has one. Claude runs
# nothing from a resumed transcript (hooks, helpers and MCP come from the rendered settings),
# so dropping them is a belt over the render, not the boundary.
CLAUDE_RECORD_DROP = frozenset({"hooks", "mcpServers", "permissions", "apiKeyHelper", "env", "enabledPlugins", "settings", "plugins"})

def shape_claude_jsonl(data):
    """A Claude transcript: jsonl whose records carry a string `type`; a record without one,
    or carrying a settings key, is dropped; every other line is kept byte for byte."""
    records = jsonl_records(data)
    if records is None:
        return None
    kept = [line for line, record in records if record is None or (isinstance(record.get("type"), str) and not CLAUDE_RECORD_DROP & set(record))]
    return b"\n".join(kept)

STATE_SHAPES = {"json": shape_json, "codex-auth": shape_codex_auth, "claude-state": shape_claude_state, "jsonl": shape_jsonl,
                "claude-jsonl": shape_claude_jsonl, "codex-jsonl": shape_jsonl, "opencode-auth": shape_opencode_auth}

# r6 R3 + r7 R4: a Codex rollout is staged rendered. Codex 0.162.1 restores a resumed
# thread's base instructions, tools, permissions and collaboration mode from its own
# session_meta, turn_context and event records, so those come only from the launcher:
# session_meta and turn_context are rebuilt from allowlists with this turn's cwd and
# render.codexPolicy, events survive only as plain user and agent messages, conversation
# records (response_item, compacted) pass byte for byte and any other record type is dropped.
# Collect stores what Codex wrote; it is rendered again on the next stage.
CODEX_APPROVALS = ("untrusted", "on-request", "never")
# SandboxPolicy as 0.162.1 serialises it (protocol.rs: tag "type", kebab-case;
# ReadOnly.network_access skipped when false; WorkspaceWrite.writable_roots skipped when
# empty, its three booleans always written), with no writable root or network granted.
CODEX_SANDBOX_POLICY = {
    "read-only": {"type": "read-only"},
    "workspace-write": {"type": "workspace-write", "network_access": False, "exclude_tmpdir_env_var": False, "exclude_slash_tmp": False},
    "danger-full-access": {"type": "danger-full-access"},
}
# session_id is kept beside the design's list: SessionMeta declares it without a serde
# default (protocol.rs at rust-v0.162.1), so a session_meta without it does not parse and
# the thread would not resume.
CODEX_META_KEYS = ("id", "session_id", "timestamp", "cwd", "originator", "cli_version", "source", "model_provider", "git")
CODEX_EVENTS = frozenset({"user_message", "agent_message"})
CODEX_VERBATIM = frozenset({"response_item", "compacted"})

def codex_line(record, payload):
    out = {"timestamp": record["timestamp"]} if isinstance(record.get("timestamp"), str) else {}
    out["type"], out["payload"] = record["type"], payload
    return json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

def render_codex_rollout(data, thread_id, cwd, policy):
    """The staged bytes of one shape-checked rollout, or None (refused) when its
    session_meta names another thread or no Codex policy is known."""
    records = jsonl_records(data)
    if records is None or policy is None or not isinstance(cwd, str):
        return None
    out = []
    for line, record in records:
        kind = record.get("type") if record is not None and isinstance(record.get("type"), str) else None
        payload = record.get("payload") if record is not None else None
        if kind in CODEX_VERBATIM:
            out.append(line)
        elif kind == "session_meta" and isinstance(payload, dict):
            if payload.get("id") != thread_id:
                return None
            meta = {key: payload[key] for key in CODEX_META_KEYS if key in payload}
            meta["cwd"] = cwd
            out.append(codex_line(record, meta))
        elif kind == "turn_context" and isinstance(payload, dict):
            context = {"cwd": cwd, "approval_policy": policy["approval"], "sandbox_policy": dict(CODEX_SANDBOX_POLICY[policy["sandbox"]])}
            context.update({key: payload[key] for key in ("model", "effort", "summary") if key in payload})
            out.append(codex_line(record, context))
        elif kind == "event_msg" and isinstance(payload, dict) and isinstance(payload.get("type"), str) and payload["type"] in CODEX_EVENTS and isinstance(payload.get("message"), str):
            out.append(codex_line(record, {"type": payload["type"], "message": payload["message"]}))
    return b"".join(line + b"\n" for line in out)
STATE_TOKENS = re.compile(r"(\*|@id|@stamp)")
STATE_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

def state_pattern(entry):
    """((literal or None, regex) per component, shape, exact)."""
    path, shape = entry[0], entry[1]
    components = []
    for component in path.split("/"):
        if not component or component in {".", ".."} or "/" in component:
            raise ValueError("Invalid cloud state pattern")
        regex = ""
        for part in STATE_TOKENS.split(component):
            if part == "*":
                regex += STATE_NAME.pattern
            elif part == "@id":
                regex += "(?P<id>" + UUID_SHAPE.pattern + ")"
            elif part == "@stamp":
                regex += STATE_STAMP
            else:
                regex += re.escape(part)
        literal = component if STATE_TOKENS.search(component) is None else None
        components.append((literal, re.compile(regex, re.ASCII)))
    return components, STATE_SHAPES[shape], all(literal is not None for literal, _ in components)

def state_patterns(engine, scope):
    """The engine's patterns of one scope ("bot" or "signin"), with each entry's shape name."""
    return [state_pattern(entry) + (entry[1],) for entry in PERSISTED_STATE.get(engine, ()) if entry[2] == scope]

def check_state_tables():
    for engine, entries in PERSISTED_STATE.items():
        for entry in entries:
            if len(entry) != 3 or entry[2] not in STATE_SCOPES:
                raise ValueError("Cloud state pattern has no scope: " + entry[0])
            components, _shape, _exact = state_pattern(entry)
            head = components[0][0]
            if head == BOTS_DIR:
                raise ValueError("Cloud state pattern starts with the reserved name: " + entry[0])
            # A session id is a conversation of one bot: it can only live in that bot's store.
            if "@id" in entry[0] and entry[2] != "bot":
                raise ValueError("Cloud state pattern names a session outside the bot store: " + entry[0])
            if head is None or not any(d == head or d.startswith(head + "/") or head.startswith(d + "/") for d in credential_dirs(engine)):
                raise ValueError("Cloud state pattern is outside the engine's state directories: " + entry[0])
            for literal, _regex in components:
                if literal is not None and STATE_NAME.fullmatch(literal) is None and literal not in {".claude", ".codex", ".grok", ".kimi-code", ".config", ".local", ".fuigo", ".credentials.json", ".claude.json"}:
                    raise ValueError("Cloud state pattern names a bad component: " + entry[0])
            if entry[0].endswith((".toml", ".md", ".sh", ".js", ".mjs", ".py")):
                raise ValueError("Cloud state pattern names a config or code file: " + entry[0])

def state_name_matches(component, name, ids):
    literal, regex = component
    if literal is not None:
        return name == literal
    match = regex.fullmatch(name)
    if match is None:
        return False
    found = match.groupdict().get("id")
    return found is None or ids is None or found in ids

def state_walk(root_fd, components, ids, visit, depth=0):
    """Call visit(parts, parent_fd, name) for every name under root_fd that matches the
    pattern components; directories are opened O_NOFOLLOW from their parent fd, so no
    symlink is ever followed and no path is ever opened by name."""
    component, rest = components[0], components[1:]
    if component[0] is not None:
        names = [component[0]]
    else:
        try:
            names = sorted(os.listdir(root_fd))
        except OSError:
            return
        if len(names) > STATE_LIST_MAX:
            raise Refusal("Cloud engine state directory is too large")
        names = [name for name in names if state_name_matches(component, name, ids)]
    for name in names:
        if not rest:
            try:
                os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue  # an exact file that does not exist yet (no sign-in): nothing to check
            visit((name,), root_fd, name)
            continue
        try:
            fd = os.open(name, STATE_DIR_FLAGS, dir_fd=root_fd)
        except OSError:
            continue  # absent, a symlink or not a directory: nothing to persist here
        try:
            state_walk(fd, rest, ids, lambda parts, parent, leaf: visit((name,) + parts, parent, leaf), depth + 1)
        finally:
            os.close(fd)

def read_state_file(parent_fd, name, owners):
    """The bytes of a regular, owner-checked, size-capped file; None otherwise. Never
    follows a symlink; a FIFO or device cannot block it (O_NONBLOCK, S_ISREG)."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent_fd)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (owners is not None and info.st_uid not in owners) or info.st_size > STATE_FILE_MAX:
            return None
        chunks, size = [], 0
        while size <= STATE_FILE_MAX:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b"".join(chunks) if size <= STATE_FILE_MAX else None
    finally:
        os.close(fd)

def write_state_file(parent_fd, name, data, uid, gid):
    """Atomic replace of parent/name: a unique 0600 temp file in the same directory,
    fsynced, owned by the turn user and the engine group, renamed over the name."""
    temp = ".murage-state-" + secrets.token_hex(8)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        if gid is not None:
            os.fchown(fd, uid if uid is not None else -1, gid)
    except BaseException:
        os.close(fd)
        os.unlink(temp, dir_fd=parent_fd)
        raise
    os.close(fd)
    try:
        os.rename(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    except OSError:
        os.unlink(temp, dir_fd=parent_fd)
        raise

def open_state_dir(root_fd, parts, engine, create, uid, gid):
    """fd of root/parts..., walking O_NOFOLLOW from root_fd. With create, a missing
    component is made: inside a credential directory chain root:<group> 2770 (what the
    CLIs sign into), deeper (a project or session directory) <turn>:<group> 0770. Without
    create, None when a component is missing. A component that exists and is not a
    directory refuses (the operator removes it; the launcher never does)."""
    fd = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            relative = "/".join(parts[:index + 1])
            try:
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                top = any(d == relative or d.startswith(relative + "/") for d in credential_dirs(engine))
                os.mkdir(part, 0o2770 if top else 0o770, dir_fd=fd)
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
                if gid is not None:
                    os.fchown(nextfd, 0 if top or uid is None else uid, gid)
                os.fchmod(nextfd, 0o2770 if top else 0o770)
            except OSError:
                os.close(fd)
                raise Refusal("Cloud engine home path is not a directory: " + relative)
            os.close(fd)
            fd = nextfd
        return fd
    except BaseException:
        os.close(fd)
        raise

def turn_state_ids(engine, args, render):
    """(ids copied in, ids copied out) for the "@id" component: Claude's --resume comes
    in, --resume and --session-id go out; Codex's render.resume comes in and any rollout
    id goes out (None = any UUID); every other engine resumes nothing across turns."""
    if engine == "claudeAgent":
        after = lambda flag: {args[i + 1] for i, a in enumerate(args[:-1]) if a == flag}
        resume, session = after("--resume"), after("--session-id")
        return frozenset(resume), frozenset(resume | session)
    if engine == "codex":
        resume = render.get("resume") if isinstance(render, dict) else None
        return frozenset({resume} if resume else ()), None
    return frozenset(), frozenset()

def credential_dirs(engine):
    """Writable-state directories (relative to the engine home): the CLI's credential
    directories plus its own state directory where it has one (Fuigo's $HOME/.fuigo)."""
    return sorted({os.path.dirname(path) for path in RECOVERY_CREDENTIALS.get(engine, []) if os.path.dirname(path)} | set(STATE_DIRS_EXTRA.get(engine, [])))

def prepare_credential_dirs(home_fd, engine, gid, owners):
    """Root, before the ownership transition, inside the turn's home: make every state
    directory of the engine root:<engine group> 2770, so the engine identity (egid =
    engine group) can create its files there. bwrap's --dir would otherwise leave it
    root 2755, and a CLI sign-in then fails with EACCES. Walks with directory fds and
    O_NOFOLLOW; a component that exists and is not a directory (file, symlink, FIFO,
    socket) refuses the turn and is left in place, and any directory owned by neither
    root nor the turn user is refused. gid=None skips the chown (tests)."""
    for relative in credential_dirs(engine):
        fd = os.dup(home_fd)
        try:
            for part in relative.split("/"):
                if not part or part in {".", ".."}:
                    raise ValueError("Invalid cloud credential directory")
                try:
                    nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
                except FileNotFoundError:
                    os.mkdir(part, 0o2770, dir_fd=fd)
                    nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
                except OSError:
                    # ELOOP (a symlink) or ENOTDIR (a file, FIFO or socket). The name is the
                    # launcher's own table entry; an operator removes the object.
                    raise Refusal("Cloud engine home path is not a directory: " + relative)
                os.close(fd)
                fd = nextfd
                info = os.fstat(fd)
                if info.st_uid not in owners:
                    raise ValueError("Invalid cloud credential directory owner")
                if gid is not None:
                    os.fchown(fd, -1, gid)
                os.fchmod(fd, 0o2770)
        finally:
            os.close(fd)

def bot_store_dir(home_fd, bot, parts=(), create=False):
    """fd of <engine home>/bots/<bot>/<parts...>, walked O_NOFOLLOW from home_fd; None when
    absent and not create. Created root 0700: the store is read and written only by this
    launcher and never mounted into a turn (r5 R5.2)."""
    if not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None:
        raise Refusal("Cloud turn bot is not allowed")
    fd = os.dup(home_fd)
    try:
        for part in (BOTS_DIR, bot) + tuple(parts):
            try:
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    return None
                os.mkdir(part, 0o700, dir_fd=fd)
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
                os.fchmod(nextfd, 0o700)
            except OSError:
                raise Refusal("Cloud engine home path is not a directory: " + BOTS_DIR)
            os.close(fd)
            fd = nextfd
        result, fd = fd, None
        return result
    finally:
        if fd is not None:
            os.close(fd)

# ---------------------------------------------------------------------------
# Versioned sign-in stores (r8 R2, r9 "H2 ancestors", r7 R2 generation rules). A store is
# a root 0700 directory `signin/` holding `current` (one line naming G) and generation
# directories `<G>/` (record.json plus the secret files at their relative paths). The C
# store is <engine home>/signin (launcher-rendered, never staged); a bot's B store is
# <engine home>/bots/<bot>/signin (staged into that bot's turns and logins, collected back).
# Every writer goes through publish_generation, so every publish advances G and a reader
# never sees a half-written set: `current` moves by rename only after the generation it
# names is durable, and the old generations go only after that (keep the last two).
fsync = os.fsync  # the one fsync seam of publication: fixture 18 records every call in order
SIGNIN_DIR = "signin"
SIGNIN_CURRENT = "current"
SIGNIN_RECORD = "record.json"
SIGNIN_GENERATION = re.compile(r"[0-9]{1,18}", re.ASCII)
SIGNIN_YEAR = 365 * 24 * 60 * 60
# The mode a B store's sign-in carries (r8 R3 modes table); a C store's mode is its writer's.
B_MODES = {"codex": "chatgpt", "grokAgent": "oauth", "kimiAgent": "oauth", "opencodeGo": "oauth"}
SIGNIN_MOVED = "Cloud engine sign-in changed during the turn; its refresh was not kept"

class SigninSnapshot(dict):
    """stage_turn_home's {relative path: sha256}, remembering the B generation staged (G0)."""
    generation = 0

def keep_flags(fd):
    """erase_tree's clearer for a store: nothing there is ever made immutable."""

def store_walk(fd, parts, create=False):
    """fd of fd/parts..., every level opened O_NOFOLLOW from its parent; None when a level
    is absent and not create. With create a missing level is made 0700 (root's) and its
    parent fsynced before the next level is made (r9 "H2 ancestors")."""
    fd = os.dup(fd)
    try:
        for part in parts:
            try:
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    return None
                os.mkdir(part, 0o700, dir_fd=fd)
                fsync(fd)
                nextfd = os.open(part, STATE_DIR_FLAGS, dir_fd=fd)
                os.fchmod(nextfd, 0o700)
            except OSError:
                raise Refusal("Cloud engine sign-in store is not a directory")
            os.close(fd)
            fd = nextfd
        result, fd = fd, None
        return result
    finally:
        if fd is not None:
            os.close(fd)

def signin_store(home_fd, bot=None, create=False):
    """fd of the engine's C store (bot None) or the bot's B store under the engine home."""
    if bot is not None and (not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None):
        raise Refusal("Cloud turn bot is not allowed")
    return store_walk(home_fd, (SIGNIN_DIR,) if bot is None else (BOTS_DIR, bot, SIGNIN_DIR), create)

def engine_signin_store(engine, bot=None, create=False, engine_root=None):
    """signin_store from the engine root, so a missing engine home is an ancestor too."""
    if engine not in ENGINES:
        raise ValueError("Cloud engine is not registered")
    rootfd = open_directory(engine_root or ENGINE_ROOT)
    try:
        home = store_walk(rootfd, (engine,), create)
    finally:
        os.close(rootfd)
    if home is None:
        return None
    try:
        return signin_store(home, bot, create)
    finally:
        os.close(home)

def read_current(store_fd):
    """G that `current` names; 0 when there is none yet (never signed in); None when it is
    unreadable (a damaged volume: read as signed out)."""
    try:
        fd = os.open(SIGNIN_CURRENT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=store_fd)
    except FileNotFoundError:
        return 0
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        text = os.read(fd, 64)
    finally:
        os.close(fd)
    try:
        name = text.decode("ascii").strip()
    except UnicodeDecodeError:
        return None
    return int(name) if SIGNIN_GENERATION.fullmatch(name) else None

def signin_parts(relative):
    parts = relative.split("/") if isinstance(relative, str) else [""]
    if any(part in {"", ".", ".."} or "\0" in part for part in parts) or len(parts) > CHAIN_MAX:
        raise ValueError("Invalid cloud sign-in path")
    return parts

def read_generation(store_fd, generation):
    """(record, {relative: bytes}) of generation G; (None, {}) when it is absent, damaged
    or incomplete. Only the files the record names are read, each a regular root file."""
    if not generation:
        return None, {}
    gfd = store_walk(store_fd, (str(generation),))
    if gfd is None:
        return None, {}
    try:
        owners = {os.geteuid()}
        data = read_state_file(gfd, SIGNIN_RECORD, owners)
        record = json_object(data) if data is not None else None
        listed = record.get("files") if record is not None else None
        if not isinstance(listed, dict):
            return None, {}
        files = {}
        for relative in listed:
            try:
                parts = signin_parts(relative)
            except ValueError:
                return None, {}
            parent = store_walk(gfd, parts[:-1])
            if parent is None:
                return None, {}
            try:
                body = read_state_file(parent, parts[-1], owners)
            finally:
                os.close(parent)
            if body is None:
                return None, {}
            files[relative] = body
        return record, files
    finally:
        os.close(gfd)

def signin_keys(data):
    """The top-level key set a non-login turn must keep (r7 R2 rule 3); [] for a non-JSON secret."""
    value = json_object(data)
    return sorted(value) if value is not None else []

# r6 R2's identity claims a non-login turn must keep (r7 R2 rule 3). Claude's sign-in is C now, so the
# one B-mode claim known is Codex ChatGPT's account; Grok, Kimi and OpenCode record key sets only.
SIGNIN_CLAIMS = {".codex/auth.json": (("tokens", "account_id"),)}

def signin_claims(relative, data):
    """{dotted path: string} of the record's claims present in a sign-in file; {} when none are known."""
    value, claims = json_object(data), {}
    for path in SIGNIN_CLAIMS.get(relative, ()):
        node = value
        for part in path:
            node = node.get(part) if isinstance(node, dict) else None
        if isinstance(node, str):
            claims[".".join(path)] = node
    return claims

def write_new_file(parent_fd, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        fsync(fd)
    finally:
        os.close(fd)

def publish_generation(store_dir_fd, files, record, unit):
    """Publish `files` ({relative path: bytes}, the complete set; {} is a sign-out) as G+1 of
    the store, the caller holding its cred-<engine>[-<bot>] section lock. record carries
    mode, kind, enrolledAt and expiresAt; the unit and each file's key set are added here.
    Returns G+1. The steps are r8 R2's, with r9's step 0 in front."""
    current = read_current(store_dir_fd)
    names = sorted(os.listdir(store_dir_fd))
    numbered = [int(name) for name in names if SIGNIN_GENERATION.fullmatch(name)]
    if current is None:
        current = max(numbered, default=0)  # unreadable `current`: keep every generation, start above them
    # 0. Orphans of an earlier crash: temp sets, temp pointers, and a generation above
    #    `current` (renamed in step 3 but never made current) are removed, then signin/ fsynced.
    for name in names:
        if name.startswith((".tmp-", ".current-")) or (SIGNIN_GENERATION.fullmatch(name) and int(name) > current):
            erase_tree(store_dir_fd, name, keep_flags)
    fsync(store_dir_fd)
    nxt, token = current + 1, secrets.token_hex(8)
    def entry(relative, data):
        claims = signin_claims(relative, data)
        return {"keys": signin_keys(data), **({"claims": claims} if claims else {})}
    record = dict(record, unit=unit, files={relative: entry(relative, data) for relative, data in sorted(files.items())})
    # 1. The whole set in a temp directory, every file O_EXCL 0600 and fsynced.
    temp = ".tmp-" + token
    os.mkdir(temp, 0o700, dir_fd=store_dir_fd)
    tfd = os.open(temp, STATE_DIR_FLAGS, dir_fd=store_dir_fd)
    dirs = {}
    try:
        for relative, data in sorted(files.items()) + [(SIGNIN_RECORD, json.dumps(record, sort_keys=True).encode("utf-8"))]:
            parts, parent = signin_parts(relative), tfd
            for depth in range(1, len(parts)):
                key = "/".join(parts[:depth])
                if key not in dirs:
                    os.mkdir(parts[depth - 1], 0o700, dir_fd=parent)
                    dirs[key] = os.open(parts[depth - 1], STATE_DIR_FLAGS, dir_fd=parent)
                parent = dirs[key]
            write_new_file(parent, parts[-1], data)
        # 2. Each subdirectory (deepest first), then the temp directory itself.
        for key in sorted(dirs, key=lambda key: (-key.count("/"), key)):
            fsync(dirs[key])
        fsync(tfd)
    finally:
        for fd in dirs.values():
            os.close(fd)
        os.close(tfd)
    # 3. The set becomes generation G+1; signin/ fsynced.
    os.rename(temp, str(nxt), src_dir_fd=store_dir_fd, dst_dir_fd=store_dir_fd)
    fsync(store_dir_fd)
    # 4. A fsynced temp pointer renamed over `current`; signin/ fsynced.
    pointer = ".current-" + token
    write_new_file(store_dir_fd, pointer, (str(nxt) + "\n").encode("ascii"))
    os.rename(pointer, SIGNIN_CURRENT, src_dir_fd=store_dir_fd, dst_dir_fd=store_dir_fd)
    fsync(store_dir_fd)
    # 5. Only now the generations older than the previous one go (the last two are kept).
    for name in sorted(os.listdir(store_dir_fd)):
        if SIGNIN_GENERATION.fullmatch(name) and int(name) < nxt - 1:
            erase_tree(store_dir_fd, name, keep_flags)
    return nxt

def store_current(store_fd):
    """(G, record, files) of the store's current generation; a store that is signed out,
    never signed in or damaged reads as ({G or None}, None, {})."""
    if store_fd is None:
        return 0, None, {}
    generation = read_current(store_fd)
    record, files = read_generation(store_fd, generation)
    return generation, record, files

# The bot's B-mode sign-in store: the two seams between the versioned store and the turn path.
def signin_source_dir(home_fd, bot):
    """(fd of the bot's current generation directory or None, G0): what stage copies from."""
    store = signin_store(home_fd, bot)
    if store is None:
        return None, 0
    try:
        generation = read_current(store)
        return (store_walk(store, (str(generation),)) if generation else None), generation
    finally:
        os.close(store)

def publish_signin(home_fd, engine, bot, files, unit, kind, enrolled=None):
    """Publish `files` ({relative path: bytes}, the complete set after the turn) as the bot's
    next B generation; kind is "signin", "refresh" or "signout" (a sign-out names no mode)."""
    store = signin_store(home_fd, bot, create=True)
    try:
        now = int(time.time())
        mode = B_MODES.get(engine) if files and kind != "signout" else None
        record = {"mode": mode, "kind": kind, "enrolledAt": enrolled if isinstance(enrolled, int) and kind == "refresh" else now, "expiresAt": None}
        return publish_generation(store, files, record, unit)
    finally:
        os.close(store)

def state_relative_id(components, name):
    match = components[-1][1].fullmatch(name)
    return match.groupdict().get("id") if match is not None else None

def matches_scope(engine, scope, relative):
    parts = relative.split("/")
    return any(len(components) == len(parts) and all(state_name_matches(c, p, None) for c, p in zip(components, parts))
               for components, _shape, _exact, _name in state_patterns(engine, scope))

def signin_rendered(engine, render):
    """True when the engine's sign-in is rendered from its C store for this turn, so its B
    set is neither staged nor collected: Codex with an enrolled key (r9 "H Codex C")."""
    return engine == "codex" and isinstance(render, dict) and bool((render.get("credentials") or {}).get("key"))

def stage_turn_home(home_fd, engine, turn_fd, gid, owners, ids, uid=None, bot=None, cwd=None, render=None):
    """Root, before the turn: the engine's state directories in the turn's home, then a
    copy of every allowlisted file the bot's stores hold that passes its shape (a Codex
    rollout rendered for this turn's cwd and render.codexPolicy). Returns the snapshot
    {relative path: sha256 of the copied bytes} collect_turn_home compares against, with
    the B generation it staged (G0) on .generation. gid=None skips every chown (tests); ids
    is turn_state_ids(). A turn without a bot (a probe, Claude's sign-in) gets its state
    directories and nothing else."""
    prepare_credential_dirs(turn_fd, engine, gid, owners)
    snapshot, total = SigninSnapshot(), 0
    if bot is None:
        return snapshot
    policy = render.get("codexPolicy") if isinstance(render, dict) else None
    signin_fd, snapshot.generation = (None, 0) if signin_rendered(engine, render) else signin_source_dir(home_fd, bot)
    sources = [("bot", bot_store_dir(home_fd, bot)), ("signin", signin_fd)]
    try:
        for scope, source_fd in sources:
            if source_fd is None:
                continue
            for components, shape, _exact, shape_name in state_patterns(engine, scope):
                def visit(parts, parent_fd, name):
                    nonlocal total
                    relative = "/".join(parts)
                    data = read_state_file(parent_fd, name, owners)
                    checked = shape(data) if data is not None else None
                    if checked is not None and shape_name == "codex-jsonl":
                        checked = render_codex_rollout(checked, state_relative_id(components, name), cwd, policy)
                    if checked is None:
                        print("Cloud engine state file refused: " + relative, file=sys.stderr)
                        return
                    total += len(checked)
                    if total > STATE_TOTAL_MAX:
                        raise Refusal("Cloud engine state exceeds its limit")
                    target = open_state_dir(turn_fd, parts[:-1], engine, True, uid, gid)
                    try:
                        write_state_file(target, name, checked, uid, gid)
                    finally:
                        os.close(target)
                    snapshot[relative] = hashlib.sha256(checked).hexdigest()
                state_walk(source_fd, components, ids[0] if scope == "bot" else None, visit)
    finally:
        for _scope, source_fd in sources:
            if source_fd is not None:
                os.close(source_fd)
    return snapshot

# r8 R5 / r9 "lock order": collect takes one section lock at a time, never two together.
# Admission locks (bot-<id>, ws-<owner>, entry locks) live in the same directory.
SECTION_LOCK_WAIT = 30.0
SECTION_LOCK_POLL = 0.05

@contextlib.contextmanager
def section_lock(name, wait=30.0):
    """Hold LIVE_DIR/<name> LOCK_EX for the block, waiting at most `wait` seconds."""
    try:
        os.mkdir(LIVE_DIR, 0o700)
    except FileExistsError:
        pass
    fd = os.open(LIVE_DIR + "/" + name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refusal("Cloud turn state was not persisted")
                time.sleep(SECTION_LOCK_POLL)
        yield
    finally:
        os.close(fd)

def turn_state_files(engine, scope, turn_fd, owners, ids_out):
    """[(relative, parts, checked bytes, id)] of the scope's files the turn's home holds; a
    file that fails its shape is named on stderr and returned with None bytes."""
    found = []
    for components, shape, exact, _name in state_patterns(engine, scope):
        def visit(parts, parent_fd, name):
            data = read_state_file(parent_fd, name, owners)
            checked = shape(data) if data is not None else None
            if checked is None:
                print("Cloud engine state file refused: " + "/".join(parts), file=sys.stderr)
            found.append(("/".join(parts), parts, checked, state_relative_id(components, name)))
        state_walk(turn_fd, components, ids_out, visit)
    return found

def codex_store_ids(store_fd, engine):
    """Every rollout id the bot's store already holds (walk bounded by STATE_LIST_MAX)."""
    seen = set()
    if store_fd is None:
        return seen
    for components, _shape, _exact, _name in state_patterns(engine, "bot"):
        state_walk(store_fd, components, None, lambda parts, parent_fd, name: seen.add(state_relative_id(components, name)))
    return seen

def collect_bot_state(home_fd, engine, turn_fd, snapshot, gid, owners, ids, uid, bot):
    """Under store-<bot>: the bot's conversation state back to bots/<bot>. Claude: the
    exact ids. Codex: the staged rollout, plus exactly one new rollout whose id the store
    does not hold yet (r6 R4); a collision or a second new rollout refuses every new one."""
    listed = turn_state_files(engine, "bot", turn_fd, owners, ids[1])
    found = [item for item in listed if item[2] is not None]
    if engine == "codex":
        fresh = [item for item in found if item[3] not in ids[0]]
        found = [item for item in found if item[3] in ids[0]]
        if len(fresh) == 1:
            existing = bot_store_dir(home_fd, bot)
            try:
                known = codex_store_ids(existing, engine)
            finally:
                if existing is not None:
                    os.close(existing)
            if fresh[0][3] not in known:
                found += fresh
                fresh = []
        for relative, _parts, _data, _id in fresh:
            print("Cloud engine state file refused: " + relative, file=sys.stderr)
    changed, total = [], 0
    writes = [item for item in found if snapshot.get(item[0]) != hashlib.sha256(item[2]).hexdigest()]
    present = {item[0] for item in listed}
    exact = ["/".join(literal for literal, _ in components) for components, _shape, is_exact, _name in state_patterns(engine, "bot") if is_exact]
    gone = [relative for relative in exact if relative in snapshot and relative not in present]
    if not writes and not gone:
        return changed
    store = bot_store_dir(home_fd, bot, create=True)
    try:
        for relative, parts, data, _id in writes:
            total += len(data)
            if total > STATE_TOTAL_MAX:
                raise Refusal("Cloud engine state exceeds its limit")
            target = open_state_dir(store, parts[:-1], engine, True, uid, gid)
            try:
                write_state_file(target, parts[-1], data, uid, gid)
            finally:
                os.close(target)
            changed.append(relative)
        for relative in gone:
            # An exact file the turn removed (Claude's CLI state after a sign-out).
            parts = relative.split("/")
            parent = open_state_dir(store, parts[:-1], engine, False, uid, gid)
            if parent is None:
                continue
            try:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and (owners is None or info.st_uid in owners):
                    os.unlink(parts[-1], dir_fd=parent)
                    changed.append(relative)
            except FileNotFoundError:
                pass
            finally:
                os.close(parent)
    finally:
        os.close(store)
    return changed

def collect_signin(home_fd, engine, turn_fd, snapshot, owners, bot, unit, login=False):
    """Under cred-<engine>-<bot>: the turn's sign-in set to publish_signin() when it differs
    from what was staged (r7 R2 commit rules). A file that fails its shape keeps the stored
    set as it is (a broken token never replaces, and never signs out, a good one). When
    `current` moved since stage (another turn published), the turn's whole sign-in change
    is discarded. A login turn's set is taken whole; a non-login turn's changed file must
    keep the record's mode, top-level key set and every claim (else that file is taken from
    G0 and named), and a file it deleted makes the generation a sign-out."""
    found = turn_state_files(engine, "signin", turn_fd, owners, None)
    if any(data is None for _relative, _parts, data, _id in found):
        return []
    files = {relative: data for relative, _parts, data, _id in found}
    before = {relative: digest for relative, digest in snapshot.items() if matches_scope(engine, "signin", relative)}
    changed = sorted({relative for relative, data in files.items() if before.get(relative) != hashlib.sha256(data).hexdigest()} | (set(before) - set(files)))
    if not changed:
        return []
    store = signin_store(home_fd, bot)
    try:
        current, record, base = store_current(store)
    finally:
        if store is not None:
            os.close(store)
    if current != getattr(snapshot, "generation", 0):
        print(SIGNIN_MOVED, file=sys.stderr)
        return []
    if login:
        new, kind = files, ("signin" if files else "signout")
    else:
        listed = record.get("files") if record is not None and record.get("mode") == B_MODES.get(engine) and record.get("kind") != "signout" else {}
        new, kind = {}, "refresh"
        for relative in sorted(set(base) | set(files)):
            if relative not in files:
                if relative in before:
                    kind = "signout"  # the turn removed a staged file: its CLI signed out
                else:
                    new[relative] = base[relative]  # never staged (refused on the way in): kept
                continue
            data = files[relative]
            if relative in changed:
                entry = listed.get(relative) if isinstance(listed, dict) else None
                if not isinstance(entry, dict) or entry.get("keys") != signin_keys(data) or (entry.get("claims") or {}) != signin_claims(relative, data):
                    print("Cloud engine sign-in file was not kept: " + relative, file=sys.stderr)
                    if relative in base:
                        new[relative] = base[relative]
                    continue
            new[relative] = data
        if kind == "refresh" and new == base:
            return []
    publish_signin(home_fd, engine, bot, new, unit, kind, record.get("enrolledAt") if record is not None else None)
    return changed

def collect_turn_home(home_fd, engine, turn_fd, snapshot, gid, owners, ids, uid=None, bot=None, unit=None, login=False, signin=True):
    """Root, after the turn: the bot's conversation state (collect_bot_state, under
    store-<bot>), then its sign-in set (collect_signin, under cred-<engine>-<bot>; not
    when signin is False, a sign-in rendered from the C store), each lock taken and
    released here. Anything else the turn wrote stays in the tmpfs and dies with it.
    Returns the relative paths written or removed."""
    if bot is None:
        return []
    changed, failure = [], None
    sections = [("store-" + bot, lambda: collect_bot_state(home_fd, engine, turn_fd, snapshot, gid, owners, ids, uid, bot))]
    if signin:
        sections.append(("cred-%s-%s" % (engine, bot), lambda: collect_signin(home_fd, engine, turn_fd, snapshot, owners, bot, unit, login)))
    for name, section in sections:
        try:
            with section_lock(name, SECTION_LOCK_WAIT):
                changed += section()
        except Exception as error:
            # One section's failure never costs the other its state.
            failure = failure or error
    if failure is not None:
        raise failure
    return changed

def mount_turn_home(uid, gid, root=TURN_ROOT, size=HOME_SIZE):
    """Root, in the private mount namespace, after anchor_mounts: the turn's $HOME, a tmpfs
    owned by the turn user (mode 0700, nosuid, nodev, capped at HOME_SIZE) that this
    launcher process keeps mounted until it has collected the turn's state. bwrap binds
    it at the engine home path. Returns (path, fd)."""
    if not _PRIVATE_MOUNT_NS:
        raise ValueError("Cloud turn home requires the private namespace first")
    path = root + "/home"
    os.mkdir(path, 0o700)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    options = "size=%d,mode=0700,uid=%d,gid=%d" % (size, uid, gid)
    if libc.mount(b"tmpfs", path.encode(), b"tmpfs", 2 | 4, options.encode()) != 0:  # MS_NOSUID | MS_NODEV
        raise OSError(ctypes.get_errno(), "Cloud turn home mount failed")
    fd = os.open(path, STATE_DIR_FLAGS)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError("Cloud turn home is not the turn's")
    return path, fd

def turn_mount_args(engine, mounts, home, cwd, command, args, render=None, scratch=(), turn_ids=None, turn_home=None):
    # Inside pasta the turn user is uid 0; launch() passes the turn user's ids so
    # the sandbox runs as murage-turn and files show their real owners.
    if render is None:
        render = validate_render(engine, None, secrets.token_hex(8))
    turn_home = turn_home or TURN_ROOT + "/home"
    identity = ["--uid", str(turn_ids[0]), "--gid", str(turn_ids[1])] if turn_ids else []
    argv = ["/usr/bin/bwrap", "--unshare-user", *identity, "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--disable-userns", "--new-session", "--cap-drop", "ALL"]
    for path in ["/usr", "/bin", "/lib", "/lib64", "/opt/murage"]:
        if os.path.exists(path):
            argv += ["--ro-bind", path, path]
    for path in ["/etc/ssl", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"]:
        if os.path.exists(path):
            argv += ["--ro-bind", path, path]
    argv += ["--proc", "/proc", "--dev", "/dev", "--size", str(TMP_SIZE), "--tmpfs", "/tmp"]
    # r4: $HOME is the launcher's tmpfs (mount_turn_home), holding only what
    # stage_turn_home copied in. Nothing of the disk home is mounted. TMPDIR ($HOME/tmp)
    # is created inside it.
    argv += ["--bind", turn_home, home, "--dir", home + "/tmp"]
    state = credential_dirs(engine)
    for source, path in mounts:
        if path == home:
            raise Refusal("Cloud turn binds the whole engine home")
        if any(path == home + "/" + d or path.startswith(home + "/" + d + "/") for d in state):
            raise Refusal("Cloud turn binds an engine state directory")
        argv += ["--bind", source, path]
    # Each state directory is its own mount, so a turn cannot rename or remove it and
    # drop the read-only config files bound inside (design 3.2).
    for relative in state:
        argv += ["--bind", turn_home + "/" + relative, home + "/" + relative]
    for path in managed_policy_paths(engine):
        argv += ["--ro-bind", path, path]
    # Claude's approval proxy dials a socket the server binds here (root:murage-turn
    # 2770). The server never writes inside an engine home, so this one directory,
    # and only for Claude, is bound in.
    if engine == "claudeAgent" and os.path.isdir(BROKER_DIR):
        argv += ["--bind", BROKER_DIR, BROKER_DIR]
    scratch = scratch_paths(engine, home, list(scratch))
    files, shadows = render_plan(engine, home, cwd, render, scratch, [a for a in add_dirs(args)] if engine == "claudeAgent" else [])
    # Scratch first, so a shadow or a file can land inside a scratch tmpfs (a routed
    # Fuigo turn's $FUIGO_HOME/plugins and config tiers).
    for path in scratch:
        argv += ["--size", str(SCRATCH_SIZE), "--tmpfs", path]
    for path in shadows:
        argv += ["--size", str(SHADOW_SIZE), "--tmpfs", path]
    blobs = {}
    if len(files) + 2 > PLAN_FILES_MAX:
        raise Refusal("Cloud turn renders too many files")
    for path, contents, _name in files:
        # pasta closes inherited descriptors, so contents travel as per-turn
        # files; the pasta child opens them and swaps the @fd: token for the
        # real descriptor. bwrap copies it into its private tmpfs and mounts
        # the result read-only at the engine's config path.
        token = "f" + str(len(blobs))
        blobs[token] = contents
        argv += ["--dir", os.path.dirname(path), "--perms", "0600", "--ro-bind-data", FD_TOKEN + token, path]
    for path in shadows:
        argv += ["--remount-ro", path]
    # The host stub resolver (127.0.0.53) does not exist inside the turn's own
    # netns; pasta forwards PASTA_DNS to it, and murage-egress.nft redirects that
    # query (by engine gid) to the per-engine synthetic DNS forwarder, never the stub.
    # Exactly one nameserver line, no search line (no suffix expansion).
    blobs["resolv"] = "nameserver " + PASTA_DNS + "\n"
    argv += ["--ro-bind-data", FD_TOKEN + "resolv", "/etc/resolv.conf"]
    argv += ["--chdir", cwd, "--", "/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--child", command] + args
    return argv, blobs

# Known credential stores used by the offered home engines. Config, history,
# workspace files and unrelated engine-home data are deliberately preserved.
RECOVERY_CREDENTIALS = {
    "claudeAgent": [".claude/.credentials.json"],
    "codex": [".codex/auth.json"],
    "grokAgent": [".grok/auth.json"],
    "opencodeGo": [".local/share/opencode/auth.json", ".config/opencode/auth.json"],
    "kimiAgent": [".kimi-code/credentials"],
}

check_state_tables()

# The wipe never opens a file (only directories, with O_DIRECTORY so a FIFO or
# device swapped in cannot block it), never follows a symlink (lstat + O_NOFOLLOW
# + unlinkat on dir fds), never crosses a mount, and walks iteratively so a deep
# tree cannot hit the recursion limit or a path-length limit. It is time bounded.
CLEANUP_DEADLINE_SECONDS = 20
CLEANUP_MAX_DEPTH = 20000

def erase_credential_at(parent, name, owners, deadline=None):
    if deadline is None:
        deadline = time.monotonic() + CLEANUP_DEADLINE_SECONDS
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = min(hard, CLEANUP_MAX_DEPTH + 64) if hard != resource.RLIM_INFINITY else CLEANUP_MAX_DEPTH + 64
        if soft != resource.RLIM_INFINITY and soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except (ValueError, OSError):
        pass
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    frames = []  # [parent_fd, name, dir_fd, remaining_entries]; parent_fd is None for the start entry
    start_dev = None

    def visit(parent_fd, entry):
        nonlocal start_dev
        if time.monotonic() > deadline:
            raise ValueError("Cloud credential cleanup timed out")
        info = os.stat(entry, dir_fd=parent_fd, follow_symlinks=False)
        if info.st_uid not in owners:
            raise ValueError("Invalid cloud credential owner")
        if stat.S_ISDIR(info.st_mode):
            if start_dev is None:
                start_dev = info.st_dev
            elif info.st_dev != start_dev:
                raise ValueError("Invalid cloud credential mount")
            if len(frames) >= CLEANUP_MAX_DEPTH:
                raise ValueError("Cloud credential tree too deep")
            fd = os.open(entry, flags, dir_fd=parent_fd)
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise ValueError("Cloud credential tree changed during cleanup")
                frames.append([parent_fd, entry, fd, os.listdir(fd)])
            except BaseException:
                os.close(fd)
                raise
        else:
            # A token file with a second name would keep the sign-in alive after this
            # unlink: refuse instead of reporting a sign-out (design 3.2, hard links).
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise LinkedCredential(entry)
            # Regular file, symlink, FIFO, socket or device: unlink never opens or follows it.
            os.unlink(entry, dir_fd=parent_fd)

    try:
        visit(parent, name)
        while frames:
            top = frames[-1]
            if top[3]:
                visit(top[2], top[3].pop())
                continue
            frames.pop()
            os.close(top[2])
            top[2] = -1
            os.rmdir(top[1], dir_fd=top[0])
    finally:
        for frame in frames:
            if frame[2] >= 0:
                os.close(frame[2])

def open_credential_parent(home, components, owners, dir_owners=None):
    """Dir fd of the credential's parent, or None when the credential is gone.

    A directory component may be owned by `dir_owners` (default `owners`): the
    launcher passes root too, because prepare_credential_dirs creates each engine's
    credential directories as root:<engine group> 2770. A component that is not a
    real directory (symlink, FIFO, file, device) was put there by a turn: it must be
    owned by `owners`, and is unlinked without being followed or opened and counts
    as "credential gone". Returns a new fd the caller closes."""
    if dir_owners is None:
        dir_owners = owners
    parent = os.dup(home)
    try:
        for component in components:
            for _ in range(3):  # a swap between lstat and open is retried
                try:
                    info = os.stat(component, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return None
                if info.st_uid not in (dir_owners if stat.S_ISDIR(info.st_mode) else owners):
                    raise ValueError("Invalid cloud credential directory owner")
                if not stat.S_ISDIR(info.st_mode):
                    os.unlink(component, dir_fd=parent)
                    return None
                try:
                    nextfd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0), dir_fd=parent)
                except (NotADirectoryError, FileNotFoundError, OSError) as error:
                    if isinstance(error, PermissionError):
                        raise
                    continue
                opened = os.fstat(nextfd)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    os.close(nextfd)
                    continue
                os.close(parent); parent = nextfd
                break
            else:
                raise ValueError("Cloud credential directory changed during cleanup")
        result, parent = parent, -1
        return result
    finally:
        if parent >= 0:
            os.close(parent)

def erase_signin_stores(home_fd):
    """Every versioned sign-in store of an engine home: its C store `signin/` and every
    bot's `bots/<bot>/signin/` (fd-relative, never following a link)."""
    try:
        erase_tree(home_fd, SIGNIN_DIR, keep_flags)
    except FileNotFoundError:
        pass
    try:
        bots = os.open(BOTS_DIR, STATE_DIR_FLAGS, dir_fd=home_fd)
    except OSError:
        return
    try:
        for name in sorted(os.listdir(bots)):
            try:
                bot = os.open(name, STATE_DIR_FLAGS, dir_fd=bots)
            except OSError:
                continue
            try:
                erase_tree(bot, SIGNIN_DIR, keep_flags)
            except FileNotFoundError:
                pass
            finally:
                os.close(bot)
    finally:
        os.close(bots)

def cleanup_engine_signins(request, root="/data/engine-homes", owners=None, root_owner=0):
    """Wipe every engine's known credentials. One engine's failure never stops the
    others; returns {engine: "ok"} or raises CleanupFailed carrying the per-engine map."""
    if request != {"mode": "engine-signin-cleanup"}:
        raise ValueError("Invalid cloud credential cleanup request")
    if owners is None:
        owners = {pwd.getpwnam("murage").pw_uid, pwd.getpwnam("murage-turn").pw_uid}
    rootfd = open_directory(root)
    results = {}
    try:
        info = os.fstat(rootfd)
        if info.st_uid != root_owner or info.st_mode & 0o022:
            raise ValueError("Invalid cloud engine root")
        for engine in RECOVERY_CREDENTIALS:
            if engine not in ENGINES:
                raise ValueError("Invalid cloud cleanup engine")
        for engine, paths in RECOVERY_CREDENTIALS.items():
            try:
                try:
                    home = os.open(engine, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                except FileNotFoundError:
                    results[engine] = "ok"
                    continue
                try:
                    # Engine homes are root:murage-eng-<engine>; files inside are murage-turn's.
                    if os.fstat(home).st_uid not in owners | {root_owner}:
                        raise ValueError("Invalid cloud engine owner")
                    failure = None
                    for relative in paths:
                        try:
                            parts = relative.split("/")
                            # Credential directories are root's (prepare_credential_dirs) or the
                            # CLI's; the erased entries themselves must be the turn user's.
                            parent = open_credential_parent(home, parts[:-1], owners, owners | {root_owner})
                            if parent is None:
                                continue
                            try:
                                erase_credential_at(parent, parts[-1], owners)
                            finally:
                                os.close(parent)
                        except FileNotFoundError:
                            pass
                        except Exception as error:  # keep wiping the engine's other paths
                            failure = failure or error
                    try:
                        # r9 "B fallback": the versioned stores go with the legacy files.
                        erase_signin_stores(home)
                    except Exception as error:
                        failure = failure or error
                    if failure is not None:
                        raise failure
                finally:
                    os.close(home)
                results[engine] = "ok"
            except LinkedCredential as error:
                results[engine] = "failed: LinkedCredential " + error.name
            except Exception as error:
                results[engine] = "failed: " + type(error).__name__
    finally:
        os.close(rootfd)
    if any(value != "ok" for value in results.values()):
        print(json.dumps(results), file=sys.stderr)
        raise CleanupFailed(results)
    return results

def publish_login(turn, engine_root=None, out=None):
    """A login request that runs no CLI (r9 "logout", "launcher modes"): root publishes the
    addressed store's next generation under its cred lock. `logout` is an empty generation
    (no bot: the engine's C store; a bot: that bot's B store); `enroll-key` is Codex's
    `key` or one OpenCode `api` entry merged into the C store's auth.json. The secret is
    written once, 0600 root, and never echoed. Returns 0."""
    engine, action, bot = turn.get("engine"), turn.get("publish"), turn.get("bot")
    if engine not in LOGIN_COMMANDS or action not in {"logout", "enroll-key"} or set(turn) - {"engine", "publish", "bot", "secret", "provider", "unit"}:
        raise ValueError("Invalid cloud engine sign-in publish")
    now = int(time.time())
    with section_lock("cred-" + engine + ("-" + bot if bot else ""), SECTION_LOCK_WAIT):
        store = engine_signin_store(engine, bot, create=True, engine_root=engine_root)
        try:
            if action == "logout":
                files, record = {}, {"mode": None, "kind": "signout", "enrolledAt": now, "expiresAt": None}
            elif engine == "codex":
                files, record = {"key": turn["secret"].encode("ascii")}, {"mode": "apikey", "kind": "enroll", "enrolledAt": now, "expiresAt": None}
            else:
                _generation, previous, base = store_current(store)
                entries = json_object(base.get("auth.json", b"")) if previous is not None and previous.get("mode") == "api" else None
                entries = {name: entry for name, entry in (entries or {}).items() if isinstance(entry, dict) and entry.get("type") == "api"}
                entries[turn["provider"]] = {"type": "api", "key": turn["secret"]}
                files = {"auth.json": json.dumps(entries, sort_keys=True).encode("utf-8")}
                record = {"mode": "api", "kind": "enroll", "enrolledAt": now, "expiresAt": None}
            publish_generation(store, files, record, turn.get("unit"))
        finally:
            os.close(store)
    label = LOGIN_LABEL[engine]
    if action == "logout":
        text = "Signed out of " + label + (" for this bot" if bot else "") + " on this Cloud home.\r\n"
    else:
        text = label + " key enrolled on this Cloud home.\r\n"
    out = out or sys.stdout
    out.write(text)
    out.flush()
    return 0

class CleanupFailed(ValueError):
    def __init__(self, results):
        super().__init__("Cloud credential cleanup failed for some engines")
        self.results = results

class LinkedCredential(Refusal):
    """A credential file with st_nlink > 1. The name is the CLI's own token file name
    (or a directory entry the walk reached), never file content."""
    def __init__(self, name):
        super().__init__("Cloud credential has a second link: " + (name if re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name or "") else "file"))
        self.name = name if re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name or "") else "file"

PROTECTED_HARDLINKS = "/proc/sys/fs/protected_hardlinks"

def check_protected_hardlinks(path=None):
    """The image default (1) stops a turn from hard-linking root-owned files it cannot
    write; without it the sign-out link check above is not enough (design 3.2)."""
    try:
        with open(path or PROTECTED_HARDLINKS) as stream:
            value = stream.read().strip()
    except OSError:
        value = ""
    if value != "1":
        raise Refusal("Cloud home requires fs.protected_hardlinks = 1")

def current_scope(cgroup="/proc/self/cgroup"):
    """The (slice, scope) leaf names of this process's cgroup v2 path, or None."""
    with open(cgroup) as stream:
        lines = [line.rstrip("\n").split(":", 2) for line in stream]
    paths = [line[2] for line in lines if len(line) == 3 and line[0] == "0"]
    parts = paths[0].split("/")[1:] if len(paths) == 1 else []
    return (parts[-2], parts[-1]) if len(parts) >= 2 else None

def scope_plan(request):
    """(unit, slice, properties) for requests that run untrusted code; None otherwise."""
    mode = request.get("mode")
    if mode in {"engine-signin-cleanup", "browser-cleanup", "bot-state-release", "bot-state-query"}:
        return None
    if mode in BROWSER_RESTORE_MODES:
        # The saved-session steps read and decrypt files the browser wrote: limited like a browser launch,
        # in a murage-browser-<bot>.* scope, so a cleanup of the bot finds and ends them too.
        validate_browser_restore_request(request)
        return ("murage-browser-" + request["bot"] + "." + secrets.token_hex(4) + ".scope", BROWSER_SLICE, BROWSER_RESTORE_SCOPE_PROPERTIES)
    if mode == "login":
        validate_login_request(request)
        return (turn_unit(request), TURN_SLICE, LOGIN_SCOPE_PROPERTIES)
    if mode in {"browser", "browser-host"}:
        validate_browser_request(request)
        # One scope per launch: several launches of the same bot overlap, and
        # "." cannot occur in a bot id, so murage-browser-<bot>.*.scope is
        # unambiguous for teardown (murage-browser-namespace.py kill_scopes).
        # Hosts, MCP servers and relays (long-lived) are capped by systemd too (6.1, H1); one-shot commands are not.
        # Every launch's root launcher enforces the idle limit and the cap on the sandbox itself (supervise_session_host).
        properties = HOST_SCOPE_PROPERTIES if mode == "browser-host" or request["args"][:1] in (["mcp"], ["relay"]) else BROWSER_SCOPE_PROPERTIES
        return ("murage-browser-" + request["bot"] + "." + secrets.token_hex(4) + ".scope", BROWSER_SLICE, properties)
    return (turn_unit(request), TURN_SLICE, TURN_SCOPE_PROPERTIES)

TURN_UNIT_PATTERN = re.compile(r"murage-turn-[0-9a-f]{16}\.scope")

def turn_unit(request):
    """The scope unit for an ordinary turn. The home server may pick the name
    ("unit") so it can read the turn's cgroup (listTree, RSS, stop confirmation)
    without /proc, which hidepid=2 hides from it. The name is accepted only in
    the exact murage-turn-<16 hex>.scope shape, always under TURN_SLICE; any
    other value refuses the request. systemd-run refuses a name already in use,
    so a repeated name fails closed. Without "unit" the launcher picks one."""
    if "unit" not in request:
        return "murage-turn-" + secrets.token_hex(8) + ".scope"
    unit = request["unit"]
    if not isinstance(unit, str) or TURN_UNIT_PATTERN.fullmatch(unit) is None:
        raise ValueError("Cloud turn scope name is invalid")
    return unit

def in_scope(plan, cgroup="/proc/self/cgroup", exact=False):
    unit, slice_name, _ = plan
    pattern = r"murage-browser-[A-Za-z0-9_-]{1,128}\.[0-9a-f]{8}\.scope" if unit.startswith("murage-browser-") else r"murage-turn-[0-9a-f]{16}\.scope"
    found = current_scope(cgroup)
    # exact: the request fixed the unit name, so the re-entered launcher must be in that very scope.
    return bool(found) and found[0] == slice_name and re.fullmatch(pattern, found[1]) is not None and (not exact or found[1] == unit)

SCOPE_REQUESTS = "/run/murage-turn-requests"

def take_scope_request(path, root=SCOPE_REQUESTS, owner=0):
    """Read and remove the request enter_scope() left for the re-executed launcher.

    systemd-run does not pass extra descriptors into a scope, so the request
    travels as a root-only file in a root-only directory. Only root can create
    it, and sudoers lets murage pass no arguments at all."""
    if not re.fullmatch(re.escape(root) + r"/r-[0-9a-f]{32}", path):
        raise ValueError("Cloud turn scope request is invalid")
    parent = os.lstat(root)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError("Cloud turn scope request is invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("Cloud turn scope request is invalid")
        os.unlink(path)
        with os.fdopen(fd, "rb") as stream:
            fd = -1
            return stream.read(1024 * 1024 + 1)
    finally:
        if fd >= 0:
            os.close(fd)

def enter_scope(payload, plan, execv=os.execv, root=SCOPE_REQUESTS, owner=0, admission=None):
    """Re-exec this launcher inside a transient scope. Never returns; any failure raises.

    systemd-run --scope moves its own process into the scope and execs the
    command, so the whole launcher tree (pasta, bwrap, the sandboxed command or
    the browser) is accounted to and limited by the scope. If the scope cannot
    be created systemd-run exits non-zero and nothing runs: the request fails
    closed (the request file is then removed by the next launch's sweep).
    A turn's admission record travels next to the request (r8 R1 step 1), root-only
    like the payload: {"request": ..., "admission": {...}}."""
    unit, slice_name, properties = plan
    if admission is not None:
        payload = b'{"request":' + payload + b',"admission":' + json.dumps(admission).encode("utf-8") + b"}"
    os.makedirs(root, mode=0o700, exist_ok=True)
    parent = os.lstat(root)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError("Cloud turn scope request directory is invalid")
    names = os.listdir(root)
    if len(names) >= 64:  # bounded staging: at most 64 x 1 MiB on /run
        raise ValueError("Cloud turn scope requests are backed up")
    for name in names:  # sweep requests whose scope never started
        try:
            if time.time() - os.lstat(root + "/" + name).st_mtime > 300:
                os.unlink(root + "/" + name)
        except OSError:
            pass
    path = root + "/r-" + secrets.token_hex(16)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
    argv = [SYSTEMD_RUN, "--scope", "--quiet", "--collect", "--slice=" + slice_name, "--unit=" + unit]
    for item in properties:
        argv += ["-p", item]
    argv += ["--", "/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--in-scope", path]
    execv(SYSTEMD_RUN, argv)

# r6 R1 to r9 (CLOUD-ENGINES-DESIGN.md): admission, liveness, release and tombstones. flock on
# root-owned files under LIVE_DIR is the state; nothing in the files is trusted beyond the
# entry's bot and roots, which only root writes. The supervisor (pre-scope, outside every
# namespace) admits a turn: bot-<bot> LOCK_SH, ws-<owner> LOCK_SH per workspace root the raw
# request names, tombstone check, then the entry LIVE_DIR/<unit> under LOCK_EX. The locks are
# handed through the exec on fixed inheritable descriptors (r8 R1, like BROWSER_LOCK_FD), so
# the in-scope launcher holds them too and a dead supervisor drops nothing while a child
# exists. Release (bot-state-release) takes bot, ws and store exclusively, treats an entry as
# live while its lock is held OR its scope's cgroup directory exists, and tombstones the id
# for good: ids are never reused (r8 H1a).
LIVE_DIR = "/run/murage-turn-live"   # shared with section_lock() above
TOMBSTONE_DIR = "/data/engine-homes/.deleted"
ENGINE_ROOT = "/data/engine-homes"
CGROUP_ROOT = "/sys/fs/cgroup"
ADMISSION_FD = 8           # first inheritable admission descriptor (BROWSER_LOCK_FD is 7)
CGROUP_GONE_WAIT = 15.0    # bounded wait for a stopped scope's cgroup directory to go
RELEASE_ENTRIES_MAX = 65536
BOT_SHAPE = re.compile(r"[\w-]{1,64}", re.ASCII)
LIVE_NAME = re.compile(r"(bot|ws|store)-[\w-]{1,64}|cred-[A-Za-z]+(-[\w-]{1,64})?|murage-turn-[0-9a-f]{16}\.scope", re.ASCII)
LOCK_TRACE = None          # test seam: a list recording (name, "sh"|"ex"|"un") in acquisition order
ADMISSION = None           # the in-scope launcher's admission record, set by main() before launch()

def live_dir_fd(create=True):
    """fd of LIVE_DIR: 0700, owned by this (root) process, on the host /run, so it exists
    before any private mount namespace and the overmount of /run/murage-turn cannot hide it."""
    if create:
        try:
            os.mkdir(LIVE_DIR, 0o700)
        except FileExistsError:
            pass
    fd = os.open(LIVE_DIR, STATE_DIR_FLAGS)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Invalid cloud live directory")
    except BaseException:
        os.close(fd)
        raise
    return fd

def live_lock(name, dir_fd):
    """Open (create) the lock file LIVE_DIR/<name>; regular, ours, one link. No lock yet."""
    if LIVE_NAME.fullmatch(name) is None:
        raise ValueError("Invalid cloud live name")
    fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise ValueError("Invalid cloud live file")
    except BaseException:
        os.close(fd)
        raise
    return fd

def take(fd, name, op):
    """flock with the order trace; a non-blocking miss raises BlockingIOError to the caller."""
    fcntl.flock(fd, op)
    if LOCK_TRACE is not None:
        LOCK_TRACE.append((name, "un" if op & fcntl.LOCK_UN else "sh" if op & fcntl.LOCK_SH else "ex"))

def workspace_owner(path):
    """The bot that owns a workspace root: <WORKSPACE_ROOT>/<bot> or <bot>.<suffix> (r6 R1);
    None for a path outside WORKSPACE_ROOT (the engine home)."""
    if not isinstance(path, str) or not path.startswith(WORKSPACE_ROOT + "/"):
        return None
    owner = path[len(WORKSPACE_ROOT) + 1:].split("/", 1)[0].split(".", 1)[0]
    if BOT_SHAPE.fullmatch(owner) is None:
        raise Refusal("Cloud turn workspace is invalid")
    return owner

def request_roots(request):
    """Owners of every workspace root the raw request names (cwd and Claude's --add-dirs),
    lexical. Strings only; full validation stays in launch()."""
    cwd, args = request.get("cwd"), request.get("args")
    paths = [cwd] if isinstance(cwd, str) else []
    if isinstance(args, list) and all(isinstance(a, str) for a in args):
        paths += add_dirs(args)
    return sorted({owner for owner in map(workspace_owner, paths) if owner is not None})

def request_bot(request):
    """The bot a raw request names, or None (a probe or a C-mode login). A bad shape refuses."""
    bot = request.get("bot")
    if bot is None:
        return None
    if not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None:
        raise Refusal("Cloud turn names a bad bot")
    return bot

def tombstoned(bot, root=None):
    try:
        info = os.lstat((root or TOMBSTONE_DIR) + "/" + bot)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode)

def write_tombstone(bot, root=None):
    """TOMBSTONE_DIR/<bot>, 0600, fsynced, then its directory fsynced, before anything is
    cleared (r8 H1a). Permanent: no mode removes it; a bot id is never reused."""
    root = root or TOMBSTONE_DIR
    try:
        os.mkdir(root, 0o700)
    except FileExistsError:
        pass
    dfd = os.open(root, STATE_DIR_FLAGS)
    try:
        info = os.fstat(dfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Invalid cloud tombstone directory")
        try:
            fd = os.open(bot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        except FileExistsError:
            return
        try:
            os.write(fd, json.dumps({"bot": bot, "deletedAt": int(time.time())}).encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(dfd)
    finally:
        os.close(dfd)

def remap_admission(fds, base=ADMISSION_FD):
    """Move the lock descriptors onto base+i, inheritable, without collisions (r9 M fd remap):
    (a) copy each above the target range and close the originals; (b) move any unrelated
    descriptor that sits on a target number above the range too (its mapping is returned, so
    the caller keeps using it); (c) dup2 in order; (d) close the copies; (e) verify each target
    is open and inheritable. The lock file identity is verified by verify_admission()."""
    top = base + len(fds)
    def above(fd):
        junk, copy = [], os.dup(fd)
        while copy < top:
            junk.append(copy)
            copy = os.dup(fd)
        for item in junk:
            os.close(item)
        return copy
    high = [above(fd) for fd in fds]
    for fd in fds:
        os.close(fd)
    moved = {}
    for number in range(base, top):
        try:
            fcntl.fcntl(number, fcntl.F_GETFD)
        except OSError:
            continue
        moved[number] = above(number)
        os.close(number)
    for i, copy in enumerate(high):
        os.dup2(copy, base + i, inheritable=True)
        os.close(copy)
    for i in range(len(fds)):
        if fcntl.fcntl(base + i, fcntl.F_GETFD) & fcntl.FD_CLOEXEC:
            raise OSError("Cloud turn admission descriptor is not inheritable")
    return moved

def admit(request, unit, bot=None):
    """Supervisor, pre-scope (r7 R1, r8 R1, r9): bot-<bot> LOCK_SH|NB, each ws-<owner> LOCK_SH|NB
    in lexical order, the tombstone check, the entry LIVE_DIR/<unit> under LOCK_EX|NB, then the
    handoff onto ADMISSION_FD+i. Any failure unwinds in reverse order and refuses. Returns the
    admission record the in-scope launcher verifies against its descriptors."""
    roots = request_roots(request)
    dfd = live_dir_fd()
    held, entry_made = [], False
    try:
        for name in (["bot-" + bot] if bot else []) + ["ws-" + owner for owner in roots]:
            fd = live_lock(name, dfd)
            try:
                take(fd, name, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                raise Refusal("Cloud bot state is being released")
            held.append((name, fd))
        if bot is not None and tombstoned(bot):
            raise Refusal("Cloud bot was deleted")
        entry = live_lock(unit, dfd)
        try:
            take(entry, unit, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(entry)
            raise Refusal("Cloud turn scope name is in use")
        held.append((unit, entry))
        entry_made = True
        os.ftruncate(entry, 0)
        os.write(entry, json.dumps({"bot": bot, "roots": roots, "unit": unit}).encode("utf-8"))
        os.fsync(entry)
        admission = {"fds": len(held), "names": [name for name, _ in held], "bot": bot, "roots": roots}
        remap_admission([fd for _, fd in held])
        return admission
    except BaseException:
        for _, fd in reversed(held):
            try:
                os.close(fd)
            except OSError:
                pass
        if entry_made:
            try:
                os.unlink(unit, dir_fd=dfd)
            except OSError:
                pass
        raise
    finally:
        os.close(dfd)

def verify_admission(admission, unit, bot):
    """In-scope launcher, before anything is staged (r8 R1 step 3): every ADMISSION_FD+i is
    open, inheritable and the very lock file the record names (fstat identity and, where
    /proc is there, the /proc/self/fd link under LIVE_DIR); the entry is this scope's unit;
    the bot is the admitted one; the locked re-admission re-checks the tombstone."""
    names = admission.get("names") if isinstance(admission, dict) else None
    if not isinstance(names, list) or not names or admission.get("fds") != len(names) or names[-1] != unit or admission.get("bot") != bot:
        raise ValueError("Cloud turn admission is missing")
    dfd = live_dir_fd(create=False)
    try:
        real = os.path.realpath(LIVE_DIR)
        for i, name in enumerate(names):
            fd = ADMISSION_FD + i
            try:
                flags = fcntl.fcntl(fd, fcntl.F_GETFD)
                info = os.fstat(fd)
            except OSError:
                raise ValueError("Cloud turn admission descriptor is missing")
            expect = os.stat(name, dir_fd=dfd, follow_symlinks=False)
            if flags & fcntl.FD_CLOEXEC or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or (info.st_dev, info.st_ino) != (expect.st_dev, expect.st_ino):
                raise ValueError("Cloud turn admission descriptor is wrong")
            try:
                link = os.readlink("/proc/self/fd/%d" % fd)
            except OSError:
                link = None
            if link is not None and link != real + "/" + name:
                raise ValueError("Cloud turn admission descriptor is wrong")
    finally:
        os.close(dfd)
    if bot is not None and tombstoned(bot):
        raise Refusal("Cloud bot was deleted")

def check_roots(admission, cwd, args):
    """r7 R1 roots fence: the validated cwd and add-dirs lie within the admitted roots."""
    owners = {owner for owner in map(workspace_owner, [cwd] + add_dirs(args)) if owner is not None}
    if not owners <= set(admission.get("roots", [])):
        raise Refusal("Cloud turn roots differ from admission")

def slice_cgroup_path(slice_name, unit, root=None):
    """<CGROUP_ROOT>/<a.slice>/<a-b.slice>/<unit>: systemd nests slices by their dashes."""
    parts = slice_name[:-len(".slice")].split("-")
    chain = ["-".join(parts[:i + 1]) + ".slice" for i in range(len(parts))]
    return (root or CGROUP_ROOT) + "/" + "/".join(chain) + "/" + unit

def scope_cgroup_present(slice_name, unit, root=None):
    try:
        return stat.S_ISDIR(os.lstat(slice_cgroup_path(slice_name, unit, root)).st_mode)
    except OSError:
        return False

def finish_admission(unit, slice_name=TURN_SLICE, wait=CGROUP_GONE_WAIT, sleep=time.sleep, clock=time.monotonic):
    """Supervisor, after systemctl stop returned: unlink the entry only once the scope's cgroup
    directory is gone (bounded). On expiry the entry stays (r9 M retention): release's rule
    (lock held OR cgroup present) keeps the turn live until the cgroup is really gone."""
    deadline = clock() + wait
    while scope_cgroup_present(slice_name, unit):
        if clock() >= deadline:
            try:
                sys.stderr.write("Cloud turn entry retained\n"); sys.stderr.flush()
            except Exception:
                pass
            return False
        sleep(0.1)
    try:
        dfd = live_dir_fd(create=False)
    except (OSError, ValueError):
        return False
    try:
        os.unlink(unit, dir_fd=dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)
    return True

def read_entry(dir_fd, name):
    """The entry's {bot, roots} as root wrote it, or None for anything else."""
    data = read_state_file(dir_fd, name, (os.geteuid(),))
    try:
        value = json.loads(data.decode("utf-8")) if data else None
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("roots"), list):
        return None
    return value

def entry_live(dir_fd, name, slice_name=TURN_SLICE, cgroup_root=None):
    """Live while the entry's lock is held (a probe LOCK_SH|NB fails) OR its scope's cgroup
    directory exists (r7 R1). The probe is released at once; it is never held across work."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    try:
        try:
            take(fd, name, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        take(fd, name, fcntl.LOCK_UN)
    finally:
        os.close(fd)
    return scope_cgroup_present(slice_name, name, cgroup_root)

def clear_immutable(fd):
    """Seam (the container user lacks CAP_LINUX_IMMUTABLE): clear FS_IMMUTABLE_FL on a directory fd."""
    value = inode_flags(fd)
    if value & FS_IMMUTABLE_FL:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, (value & ~FS_IMMUTABLE_FL).to_bytes(4, sys.byteorder) + bytes(4))

def erase_tree(parent_fd, name, clear=None, depth=0, budget=None):
    """Erase parent/name fd-relative, O_NOFOLLOW, bounded (CHAIN_MAX deep, RELEASE_ENTRIES_MAX
    entries). A directory named in MASK_NAMES has its immutable flag cleared first (r5 R5.1;
    the only other clearer is a reset with every writer stopped, murage-commands finish_swap). A symlink is unlinked, never followed."""
    budget = [RELEASE_ENTRIES_MAX] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0 or depth > CHAIN_MAX:
        raise Refusal("Cloud bot workspace is too large to release")
    try:
        fd = os.open(name, STATE_DIR_FLAGS, dir_fd=parent_fd)
    except OSError:
        os.unlink(name, dir_fd=parent_fd)
        return
    try:
        if name in MASK_NAMES:
            (clear or clear_immutable)(fd)
        for child in os.listdir(fd):
            erase_tree(fd, child, clear, depth + 1, budget)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent_fd)

def release_workspaces(bot, root=None, clear=None):
    """Erase <bot> and every <bot>.<suffix> under WORKSPACE_ROOT (literal names from the
    validated id; the store's later rmSync finds nothing)."""
    try:
        dfd = os.open(root or WORKSPACE_ROOT, STATE_DIR_FLAGS)
    except OSError:
        return
    try:
        for name in sorted(os.listdir(dfd)):
            if name == bot or name.startswith(bot + "."):
                erase_tree(dfd, name, clear)
    finally:
        os.close(dfd)

def release_bot_stores(bot, engine_root=None):
    """Remove <engine>/bots/<bot> under every engine (idempotent)."""
    for engine in sorted(ENGINES):
        try:
            dfd = os.open((engine_root or ENGINE_ROOT) + "/" + engine + "/bots", STATE_DIR_FLAGS)
        except OSError:
            continue
        try:
            erase_tree(dfd, bot)
        except FileNotFoundError:
            pass
        finally:
            os.close(dfd)

def bot_state_release(request, engine_root=None, workspace_root=None, clear=None, cgroup_root=None):
    """{"mode":"bot-state-release","bot"}: root, unscoped. bot-X, ws-X, store-X LOCK_EX|NB in order
    (unwind on failure, `Cloud bot state is in use`); every entry naming X or a root X owns must be
    dead (lock free AND cgroup gone) and is unlinked; then the tombstone (fsynced before any
    clearing), the workspace trees, and bots/X under every engine. Exit 0 is the only success."""
    bot = request.get("bot")
    if set(request) - {"mode", "bot"} or not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None:
        raise ValueError("Invalid cloud bot state request")
    dfd = live_dir_fd()
    held = []
    try:
        for name in ("bot-" + bot, "ws-" + bot, "store-" + bot):
            fd = live_lock(name, dfd)
            try:
                take(fd, name, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                raise Refusal("Cloud bot state is in use")
            held.append(fd)
        names = sorted(os.listdir(dfd))
        if len(names) > RELEASE_ENTRIES_MAX:
            raise Refusal("Cloud bot state is in use")
        for name in names:
            if TURN_UNIT_PATTERN.fullmatch(name) is None:
                continue
            entry = read_entry(dfd, name)
            if entry is None or (entry.get("bot") != bot and bot not in entry["roots"]):
                continue
            if entry_live(dfd, name, cgroup_root=cgroup_root):
                raise Refusal("Cloud bot state is in use")
            try:
                os.unlink(name, dir_fd=dfd)
            except FileNotFoundError:
                pass
        write_tombstone(bot)
        release_workspaces(bot, workspace_root, clear)
        release_bot_stores(bot, engine_root)
    finally:
        for fd in reversed(held):
            os.close(fd)
        os.close(dfd)

def signin_status(base):
    """(mode, signedIn, expiresAt ms) of a sign-in store `<base>/signin/` (C: <engine>/signin,
    B: <engine>/bots/<bot>/signin), or None when there is no store. `current` names the
    generation directory holding record.json; a `current` naming a missing directory, or a
    generation without a record, reads as signed out (r8 R2). Names and timestamps only."""
    signin = base + "/signin"
    try:
        info = os.lstat(signin + "/current")
    except OSError:
        return None
    if stat.S_ISDIR(info.st_mode):
        current = signin + "/current"
    elif stat.S_ISREG(info.st_mode):
        try:
            with open(signin + "/current", "rb") as stream:
                name = stream.read(64).decode("ascii").strip()
        except (OSError, UnicodeDecodeError):
            return (None, False, None)
        if re.fullmatch(r"[0-9]{1,18}", name) is None:
            return (None, False, None)
        current = signin + "/" + name
    else:
        return (None, False, None)
    try:
        with open(current + "/record.json", "rb") as stream:
            record = json.loads(stream.read(64 * 1024).decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return (None, False, None)
    if not isinstance(record, dict):
        return (None, False, None)
    mode = record.get("mode")
    mode = mode if isinstance(mode, str) and re.fullmatch(r"[a-z-]{1,32}", mode) else None
    signed = mode is not None and record.get("kind") != "signout"
    expires = record.get("expiresAt")
    expires = int(expires) * 1000 if isinstance(expires, (int, float)) and not isinstance(expires, bool) and expires > 0 else None
    return (mode, signed, expires if signed else None)

def bot_state_query(request, engine_root=None):
    """{"mode":"bot-state-query","bot"?}: root, unscoped. stdout JSON {"tombstoned", "engines":
    {<engine>: {"mode","signedIn","expiresAt"}}}; the engine's C store wins over the bot's B store
    (Codex: a key beats a ChatGPT sign-in). Never a secret."""
    bot = request.get("bot")
    if set(request) - {"mode", "bot"} or (bot is not None and (not isinstance(bot, str) or BOT_SHAPE.fullmatch(bot) is None)):
        raise ValueError("Invalid cloud bot state request")
    root = engine_root or ENGINE_ROOT
    engines = {}
    for engine in sorted(ENGINES):
        status = signin_status(root + "/" + engine)
        if (status is None or not status[1]) and bot is not None:
            status = signin_status(root + "/" + engine + "/bots/" + bot) or status
        if status is not None:
            engines[engine] = {"mode": status[0], "signedIn": status[1], "expiresAt": status[2]}
    return {"tombstoned": bool(bot) and tombstoned(bot), "engines": engines}

PTY_ROWS, PTY_COLS = 30, 100
PTY_CHUNK = 4096

def run_in_pty(argv, env, stdin_fd=0, stdout_fd=1):
    """Run argv with a pseudo-terminal as its stdin/stdout/stderr (a vendor CLI's
    interactive sign-in needs a tty) and relay it to this process's own stdin and
    stdout, the pipes the home server holds. The pty is allocated here, after the
    privilege drop, so the slave belongs to the turn user and exists only for this
    call. No bytes are logged or kept. Returns the command's exit status."""
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", PTY_ROWS, PTY_COLS, 0, 0))
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            for target in (0, 1, 2):
                os.dup2(slave, target)
            if slave > 2:
                os.close(slave)
            os.execve(argv[0], argv, env)
        finally:
            os._exit(127)
    os.close(slave)
    reading_stdin = True
    try:
        while True:
            watch = [master] + ([stdin_fd] if reading_stdin else [])
            ready, _, _ = select.select(watch, [], [], 1.0)
            if master in ready:
                try:
                    data = os.read(master, PTY_CHUNK)
                except OSError:  # EIO: the slave side is closed, the command is gone
                    break
                if not data:
                    break
                while data:
                    data = data[os.write(stdout_fd, data):]
            if stdin_fd in ready:
                data = os.read(stdin_fd, PTY_CHUNK)
                if not data:
                    reading_stdin = False  # the owner went away: let the command finish or be killed
                    try:
                        os.write(master, b"\x04")  # Ctrl-D, so a prompt ends instead of waiting
                    except OSError:
                        pass
                else:
                    while data:
                        try:
                            data = data[os.write(master, data):]
                        except OSError:
                            data = b""
    finally:
        os.close(master)
    _, status = os.waitpid(pid, 0)
    return 128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status)

# r9 "H Claude C": `claude setup-token` prints the long-lived token on the pty. For that
# login the child relays the pty into a pipe (not the server's stdout) and the ROOT parent
# of run_turn filters it: every token is replaced on the owner's stream, the first one is
# published to the C store, and no token byte ever reaches the server or the browser.
TOKEN_CARRY = 160
TOKEN_PATTERN = re.compile(rb"sk-ant-oat01-[A-Za-z0-9_-]{40,}")
TOKEN_CONTINUES = re.compile(rb"[A-Za-z0-9_-]*")
TOKEN_REPLACEMENT = b"[sign-in token enrolled by Murage]"

class TokenFilter:
    """Streaming redaction. A carry of at most TOKEN_CARRY bytes is held across reads so a
    token split between two reads is still matched (a token prefix too short to match is
    at most 52 bytes, so the carry always holds it whole); bytes outside a match pass
    through unchanged however long the stream. A match that reaches the end of the data
    and is longer than the carry is redacted at once, and the token characters that follow
    it in later reads are swallowed as its continuation. `token` is the first match."""
    def __init__(self):
        self.carry, self.token, self.within, self.peak = b"", None, None, 0

    def enroll(self, match):
        if self.token is None:
            self.token = match
            return True
        return False

    def feed(self, data, final=False):
        buf, self.carry, out = self.carry + data, b"", bytearray()
        if self.within is not None:
            # Inside a token already redacted: its remaining characters are swallowed.
            n = TOKEN_CONTINUES.match(buf).end()
            if self.within:
                self.token += buf[:n]
            if n == len(buf) and not final:
                return b""
            buf, self.within = buf[n:], None
        pos, hold = 0, None
        for match in TOKEN_PATTERN.finditer(buf):
            if match.end() == len(buf) and not final and len(buf) - match.start() <= TOKEN_CARRY:
                hold = match.start()  # may continue in the next read: keep it whole
                break
            out += buf[pos:match.start()] + TOKEN_REPLACEMENT
            first = self.enroll(match.group())
            pos = match.end()
            if match.end() == len(buf) and not final:
                self.within = first
        if hold is None:
            hold = len(buf) if final or self.within is not None else max(pos, len(buf) - TOKEN_CARRY)
        out += buf[pos:hold]
        self.carry = buf[hold:]
        self.peak = max(self.peak, len(self.carry))
        return bytes(out)

    def flush(self):
        return self.feed(b"", final=True)

def write_all(fd, data):
    """Write every byte or raise OSError (the reader went away)."""
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]

def relay_filtered(infd, outfd, chunk=PTY_CHUNK * 16):
    """Root parent: the login's pty bytes from the pipe, filtered, to the server's stdout as
    they arrive; drained to end of file even when the server stopped reading. Returns the
    captured token (str) or None."""
    filt, live = TokenFilter(), True
    while True:
        data = os.read(infd, chunk)
        for piece in ((filt.feed(data),) if data else (filt.flush(),)):
            if live and piece:
                try:
                    write_all(outfd, piece)
                except OSError:
                    live = False
        if not data:
            break
    return filt.token.decode("ascii") if filt.token is not None else None

def claude_token_publisher(unit=None, engine_root=None):
    """The capture run_turn calls at end of file: publish the token as the C store's next
    generation (r8 R3.1 record, a year's expiry); no token means not signed in. Returns the
    line the owner sees."""
    def publish(token):
        if token is None:
            return b"Claude is not signed in on this Cloud home: no sign-in token was received.\r\n"
        now = int(time.time())
        with section_lock("cred-claudeAgent", SECTION_LOCK_WAIT):
            store = engine_signin_store("claudeAgent", None, create=True, engine_root=engine_root)
            try:
                publish_generation(store, {"token": token.encode("ascii")}, {"mode": "oauth-token", "kind": "signin", "enrolledAt": now, "expiresAt": now + SIGNIN_YEAR}, unit)
            finally:
                os.close(store)
        return b"Signed in to Claude on this Cloud home.\r\n"
    return publish

def launch(request, login=False):
    check_protected_hardlinks()
    engine, home, cwd, command, args, env, render, bot = validate_request(request, login=login)
    if ADMISSION is not None:
        # r8 R1 step 3: the inherited admission descriptors are the very locks the supervisor
        # took; the locked re-admission re-checks the tombstone; the roots fence (r7 R1).
        found = current_scope()
        verify_admission(ADMISSION, found[1] if found else "", bot)
        check_roots(ADMISSION, cwd, args)
    account = pwd.getpwnam("murage-turn")
    server = pwd.getpwnam("murage")
    # Enter the private mount namespace, then pin the selected directories
    # before the ownership transition (see private_mount_namespace).
    private_mount_namespace()
    # r4: the engine home on disk is never mounted into a turn. The turn's $HOME is a
    # launcher-owned tmpfs (mount_turn_home) that root fills with the allowlisted state
    # files (stage_turn_home) and reads back after the turn (collect_turn_home).
    home_fd = open_directory(home)
    mounts = [(open_directory(cwd), cwd)] if cwd != home else []
    # The engine home is root:murage-eng-<engine> and holds no server-owned
    # files, so only the workspace is re-grouped; never widen the engine home, also when
    # cwd == home (then there is no separate workspace tree to re-group).
    for rootfd, _root in mounts:
        regroup_workspace(rootfd, server.pw_uid, account.pw_gid)
    engine_gid = grp.getgrnam("murage-eng-" + engine).gr_gid
    mounts = anchor_mounts(mounts)
    # r5 R5.1: root freezes a placeholder at every mask path before any turn code runs.
    ensure_placeholders(placeholder_dirs(engine, home, cwd, args), mounts)
    turn_home, turn_fd = mount_turn_home(account.pw_uid, engine_gid)
    owners = (0, account.pw_uid)
    ids = turn_state_ids(engine, args, render)
    snapshot = stage_turn_home(home_fd, engine, turn_fd, engine_gid, owners, ids, account.pw_uid, bot=bot, cwd=cwd, render=render)
    argv, blobs = turn_mount_args(engine, mounts, home, cwd, command, args, render, request.get("scratch", []), (account.pw_uid, account.pw_gid), turn_home=turn_home)
    argv = with_seccomp(argv, FD_TOKEN + "seccomp")
    blobs["seccomp"] = seccomp_filter()
    # Root materialises every file the sandbox needs while it still can; the
    # turn uid only ever reads them (see write_turn_dir).
    turn_dir = write_turn_dir(argv, blobs, account.pw_gid)
    def child(stdout_fd=None):
        # murage-sandbox gates execution of /usr/bin/bwrap (0750 root:murage-sandbox).
        # The engine group is the PRIMARY gid so the nft output hook can tell engines
        # apart (meta skgid; supplementary groups are invisible to it) and give each
        # its own egress allowlist. murage-turn's own group stays supplementary so
        # the turn dir and workspace group access is unchanged.
        os.setgroups([engine_gid, grp.getgrnam(SANDBOX_GROUP).gr_gid, account.pw_gid])
        os.setgid(engine_gid)
        os.setuid(account.pw_uid)
        os.umask(0o007)
        if request.get("pty") is True or stdout_fd is not None:
            # Sign-in terminal (login mode only; validate_login_request is the sole source of the
            # key). Claude's setup-token relays into run_turn's pipe, never the server's stdout.
            os._exit(run_in_pty(pasta_argv(turn_dir), env, stdout_fd=1 if stdout_fd is None else stdout_fd))
        # exec, never fork: the child becomes pasta, whose exit status is the sandboxed
        # command's. There is no fallback path that runs bwrap without pasta;
        # pasta_child (inside pasta) is the only caller of bwrap.
        os.execve(PASTA, pasta_argv(turn_dir), env)
    def collect():
        collect_turn_home(home_fd, engine, turn_fd, snapshot, engine_gid, owners, ids, account.pw_uid, bot=bot, unit=request.get("unit"),
                          login=login, signin=not signin_rendered(engine, render))
    capture = claude_token_publisher(request.get("unit")) if login and engine == "claudeAgent" else None
    sys.exit(run_turn(child, collect, capture=capture))

def run_turn(child, collect, signals=(signal.SIGTERM, signal.SIGHUP, signal.SIGINT), capture=None):
    """Fork: the child drops privileges and becomes the sandbox (child()); this root
    process keeps the turn's home mounted, waits, then persists the allowlisted state
    (collect()) and returns the sandbox's exit status. A stop signal kills the sandbox
    (bwrap --die-with-parent ends the tree) and still collects, so a stopped turn keeps
    its refreshed sign-in. The engine's stdio pipes are the child's alone: this process
    detaches from them so the home server sees end of file when the engine ends.

    With capture (Claude's setup-token login, r9 "H Claude C") a pipe is opened before the
    fork: the child relays the pty into it (child(write end)), and this root process keeps
    stdout, relays the filtered stream to it and, at end of file, hands the captured token
    to capture() (the C store publish) before collect()."""
    pipe = os.pipe() if capture is not None else None
    pid = os.fork()
    if pid == 0:
        try:
            if pipe is None:
                child()
            else:
                os.close(pipe[0])
                child(pipe[1])
        except BaseException:
            try:
                sys.stderr.write("Cloud turn launcher refused the request\n"); sys.stderr.flush()
            except Exception:
                pass
        os._exit(1)
    def stop(number, frame):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    for number in signals:
        signal.signal(number, stop)
    null = os.open("/dev/null", os.O_RDWR)
    os.dup2(null, 0)
    if pipe is not None:
        os.close(pipe[1])
        try:
            token = relay_filtered(pipe[0], 1)
        finally:
            os.close(pipe[0])
        try:
            note = capture(token)
        except Exception:
            note = None
            print("Cloud engine sign-in was not saved", file=sys.stderr)
        if note:
            try:
                write_all(1, note)
            except OSError:
                pass
    os.dup2(null, 1)
    os.close(null)
    _, status = os.waitpid(pid, 0)
    try:
        collect()
    except Refusal as error:
        print("Cloud turn state was not persisted: " + str(error), file=sys.stderr)
    except Exception:
        print("Cloud turn state was not persisted", file=sys.stderr)
    return 128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status)

def prctl_pdeathsig(number):
    if ctypes.CDLL(None, use_errno=True).prctl(1, number, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError("Cloud turn supervisor cannot arm its parent-death signal")

def run_bounded(argv, timeout):
    """Run argv with stdio on /dev/null and a deadline; failures are ignored."""
    try:
        null = os.open("/dev/null", os.O_RDWR)
        try:
            child = os.posix_spawn(argv[0], argv, {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, file_actions=[(os.POSIX_SPAWN_DUP2, null, 0), (os.POSIX_SPAWN_DUP2, null, 1), (os.POSIX_SPAWN_DUP2, null, 2)])
        finally:
            os.close(null)
    except Exception:
        return
    deadline = time.monotonic() + timeout
    while True:
        try:
            if os.waitpid(child, os.WNOHANG)[0]:
                return
        except ChildProcessError:
            return
        if time.monotonic() > deadline:
            try:
                os.kill(child, signal.SIGKILL); os.waitpid(child, 0)
            except OSError:
                pass
            return
        time.sleep(0.05)

def scope_runtime_max(properties):
    """The RuntimeMaxSec= seconds in a scope's properties, or None."""
    for item in properties:
        if item.startswith("RuntimeMaxSec="):
            return int(item.split("=", 1)[1])
    return None

def supervise_scope(unit, child, systemctl=None, prctl=prctl_pdeathsig, grace=10, max_runtime=None, after=None):
    """Fork; the child runs `child()` (which execs), this root process stays as a
    tiny supervisor that tears the scope down when the child ends or when its
    own caller (sudo, hence the home server) goes away. Returns the exit status.

    Nothing outside a root-created scope can stop what runs inside it, and
    bwrap --die-with-parent did not end the tree on a real home (RA-08). The
    supervisor holds no request data beyond the unit name and leaves the
    child's stdin/stdout/stderr untouched. Fail closed: if fork or the child's
    scope entry fails nothing runs and the status is non-zero."""
    systemctl = systemctl or SYSTEMCTL
    caught = []
    names = [signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGPIPE]
    previous = {n: signal.getsignal(n) for n in names + [signal.SIGCHLD]}
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False); os.set_blocking(wake_w, False)
    ppid = os.getppid()
    started = time.monotonic()
    try:
        signal.set_wakeup_fd(wake_w, warn_on_full_buffer=False)
        for n in names:
            signal.signal(n, lambda number, frame: caught.append(number))
        signal.signal(signal.SIGCHLD, lambda number, frame: None)
        prctl(signal.SIGTERM)
        if os.getppid() != ppid:  # the caller died before the death signal was armed
            caught.append(signal.SIGTERM)
        pid = os.fork()
    except BaseException:
        signal.set_wakeup_fd(-1)
        raise
    if pid == 0:
        try:
            signal.set_wakeup_fd(-1)
            for n, handler in previous.items():
                signal.signal(n, handler if handler is not None else signal.SIG_DFL)
            child()
        except BaseException:
            try:
                sys.stderr.write("Cloud turn launcher refused the request\n"); sys.stderr.flush()
            except Exception:
                pass
        os._exit(1)  # the child never returns into the supervisor's flow
    result = None
    while result is None and not caught:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done, status = pid, 255 << 8
        if done:
            result = status
            break
        if caught:
            break
        try:
            select.select([wake_r], [], [], 60)
            os.read(wake_r, 4096)
        except (BlockingIOError, InterruptedError):
            pass
    for number in names:
        signal.signal(number, signal.SIG_IGN)  # teardown must not be interrupted
    exited = result is not None  # the child ended by itself: its status wins over a late signal
    if result is None:
        # r4: the child is the launcher that holds the turn's home; SIGTERM lets it kill
        # the sandbox and persist the allowlisted state (run_turn) within the grace period
        # before the whole scope is killed.
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.monotonic() + grace
        while result is None and time.monotonic() < deadline:
            try:
                done, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done, status = pid, 255 << 8
            if done:
                result = status
                break
            time.sleep(0.02)
    for argv in (["kill", "--kill-whom=all", "--signal=SIGKILL", unit], ["stop", unit]):
        run_bounded([systemctl] + argv, grace)
    if after is not None:
        # r8 R1 step 4: the admission locks are still held here (this process's descriptors);
        # the entry goes only once the scope's cgroup is gone, else it is retained.
        try:
            after()
        except Exception:
            pass
    if result is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            result = os.waitpid(pid, 0)[1]
        except ChildProcessError:
            result = 255 << 8
    if caught and not exited:
        return 128 + caught[0]
    if exited and max_runtime and time.monotonic() - started >= max_runtime:
        # systemd ended the scope at RuntimeMaxSec=: a failure, even if the command exited 0 on SIGTERM
        try:
            sys.stderr.write("Cloud turn stopped: it ran past its time limit\n"); sys.stderr.flush()
        except Exception:
            pass
        return 124
    if os.WIFSIGNALED(result):
        return 128 + os.WTERMSIG(result)
    return os.WEXITSTATUS(result)

def main():
    if len(sys.argv) == 3 and sys.argv[1] in {"--browser-child", "--browser-host"}:
        if os.getuid() != pwd.getpwnam("murage-browser").pw_uid or os.geteuid() == 0:
            raise ValueError("Cloud browser requires the browser user")
        plan = json.loads(sys.argv[2]); home, args = plan["home"], plan["args"]
        maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
        os.closerange(3, maximum if maximum != resource.RLIM_INFINITY else 1048576)
        for path in ["tmp", "sockets", "profile", ".config", ".cache", ".local/share"]:
            os.makedirs(home + "/" + path, mode=0o700, exist_ok=True)
        session = os.environ["AGENT_BROWSER_SESSION"]
        if sys.argv[1] == "--browser-host":
            if args != HOST_WARMUP:
                raise ValueError("Invalid cloud browser host")
            sys.exit(run_session_host(home, session, os.environ))
        if args == ["--session", session, "close"]:
            browser_close(home, session)
            return
        if len(args) == 2 and args[0] == "relay" and args[1] in RELAY_DISCOVERY:
            sys.exit(run_relay(args[1], check=lambda: client_gate(home, session, args)))
        # Only ever a client of the host's daemon: never answer from stale
        # session files, never fork a daemon (the socket directory is read-only
        # here; the MCP server's stdin is gated per frame by the root pump).
        client_gate(home, session, args)
        os.execve(BROWSER_BINARY, [BROWSER_BINARY] + args, os.environ)
    if len(sys.argv) == 3 and sys.argv[1] == "--pasta-child":
        pasta_child(sys.argv[2])
    if len(sys.argv) >= 3 and sys.argv[1] == "--child":
        if os.getuid() != pwd.getpwnam("murage-turn").pw_uid or os.geteuid() == 0:
            raise ValueError("Cloud child requires the turn user")
        # bwrap retains inherited descriptors. Close the pinned host-directory
        # handles before untrusted code can use openat(fd, "../other-engine").
        maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
        os.closerange(3, maximum if maximum != resource.RLIM_INFINITY else 1048576)
        os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
    rescoped = len(sys.argv) == 3 and sys.argv[1] == "--in-scope"
    if not (len(sys.argv) == 1 or rescoped) or os.geteuid() != 0 or os.environ.get("SUDO_UID") != str(pwd.getpwnam("murage").pw_uid):
        raise ValueError("Cloud turn launcher requires the home server")
    if rescoped:
        payload = take_scope_request(sys.argv[2])
    else:
        with os.fdopen(3, "rb") as stream:
            payload = stream.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024 + (4096 if rescoped else 0):
        raise ValueError("Cloud turn request exceeds its limit")
    request = json.loads(payload)
    global ADMISSION
    if rescoped and isinstance(request, dict) and set(request) == {"request", "admission"}:
        # A turn admitted by its supervisor (enter_scope): the record is verified in launch().
        ADMISSION, request = request["admission"], request["request"]
    if not rescoped and isinstance(request, dict) and request.get("mode") == "browser-host":
        # Only a root launch of `open` starts a host (ensure_session_host), under the id's lock and fence.
        raise ValueError("Cloud browser host requests are internal")
    plan = scope_plan(request)
    if not rescoped:
        if plan:
            # murage-home runs with OOMScoreAdjust=-900, which children inherit:
            # untrusted turns and browsers must be the first OOM victims instead.
            with open("/proc/self/oom_score_adj", "w") as stream:
                stream.write("300")
            if plan[0].startswith("murage-turn-"):
                # Turns and logins: a root supervisor tears the scope down when the
                # caller goes away. Browsers must outlive the launch call. The supervisor
                # is the admission lock holder (r7 R1) and hands the locks through the exec (r8 R1).
                admission = admit(request, plan[0], request_bot(request))
                sys.exit(supervise_scope(plan[0], lambda: enter_scope(payload, plan, admission=admission), max_runtime=scope_runtime_max(plan[2]),
                                         after=lambda: finish_admission(plan[0], plan[1])))  # child execs
            if request.get("mode") == "browser":
                # Pre-scope window: hold the id's lock until the re-executed
                # launcher is inside its scope (it closes this fd then), so a
                # cleanup waits here and then finds and kills the scope.
                hold_prescope_lock(request["bot"])
                # r7: a launch queued by an older server process may take the lock only after the new
                # boot's cleanup. Re-read the current instance now, with the lock held and before the
                # scope: a stale request releases the lock and launches nothing.
                try:
                    fence_server_instance(request)
                except BaseException:
                    release_prescope_lock()
                    raise
            enter_scope(payload, plan)  # execs; nothing below runs unscoped
            raise OSError("Cloud turn scope was not entered")
    elif not plan or not (in_scope(plan, exact=True) if "unit" in request else in_scope(plan)):
        # Re-entered without the scope (or for a request that never gets one).
        raise ValueError("Cloud turn launcher is not inside its resource scope")
    if rescoped and plan[0].startswith("murage-turn-") and ADMISSION is None:
        # Every turn and sign-in scope is entered by its supervisor with an admission record
        # (r8 R1): a payload without one never runs, so nothing skips the tombstone check.
        raise Refusal("Cloud turn was not admitted")
    if rescoped and request.get("mode") in {"browser", "browser-host"}:
        try:
            os.close(BROWSER_LOCK_FD)  # scope entered and listed: cleanup can find it now
        except OSError:
            pass
    if request.get("mode") == "engine-signin-cleanup":
        cleanup_engine_signins(request)
    elif request.get("mode") == "bot-state-release":
        bot_state_release(request)
    elif request.get("mode") == "bot-state-query":
        sys.stdout.write(json.dumps(bot_state_query(request), sort_keys=True) + "\n"); sys.stdout.flush()
    elif request.get("mode") == "login":
        turn = validate_login_request(request)
        if "publish" in turn:
            # No CLI: logout and enroll-key are the launcher's own publish, still admitted
            # (bot lock, tombstone) like a turn; main() refused a scope without its record.
            found = current_scope()
            verify_admission(ADMISSION, found[1] if found else "", turn.get("bot"))
            sys.exit(publish_login(turn))
        launch(turn, login=True)
    elif request.get("mode") in BROWSER_RESTORE_MODES:
        launch_browser_restore(request)
    elif request.get("mode") in {"browser", "browser-host", "browser-cleanup"}:
        launch_browser(request)
    else:
        launch(request)

if __name__ == "__main__":
    try:
        main()
    except BrowserLockBusy:
        print("Cloud browser is busy", file=sys.stderr)
        sys.exit(BROWSER_LOCK_BUSY)
    except BrowserSessionDown as error:
        print(str(error), file=sys.stderr)
        sys.exit(BROWSER_SESSION_DOWN)
    except StaleServerInstance:
        print("Cloud browser launch refused: the server restarted", file=sys.stderr)
        sys.exit(BROWSER_STALE_INSTANCE)
    except Refusal as error:
        # Fixed launcher text naming at most a flag, key or launcher path, never a value.
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Cloud turn launcher refused the request", file=sys.stderr)
        sys.exit(1)
