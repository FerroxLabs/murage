#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Start each pinned Cloud engine binary on the configuration the launcher renders.

CLOUD-ENGINES-DESIGN.md test 19. For each engine this renders the turn with the
launcher's own code (validate_render, the exact argv the grammar accepts, the pinned
environment), starts the real binary and drives its protocol until initialization has
COMPLETED: Claude's stream-json `system`/`init` frame; Codex's app-server `initialize`
result AND a `thread/start` result carrying a thread id; for Grok/Kimi/OpenCode/Fuigo
the ACP `initialize` result AND a `session/new` result carrying a sessionId. An engine
that answers `session/new` or `thread/start` with its sign-in gate instead (no sign-in
exists here) has loaded its configuration but has NOT proven a completed start: the case
is reported NOT PROVEN HERE (sign-in required), never as complete (Astra r2 M). Any other
outcome (an error frame, a config refusal in the log, no answer) fails the case.

Two claims, reported separately, never substituted for each other (Astra r1 M):
- init: the binary accepts its rendered configuration and finishes starting.
- isolation: the launcher's real bwrap plan (turn_mount_args over a staged turn home,
  the argv launch() runs) is executed by bwrap. Before the plan is built, files a
  previous turn could have left (rc files, caches, OpenCode's models.json catalog,
  hooks, plugins, Grok's managed_config.toml and requirements.toml, Fuigo's
  trusted_folders.toml, a foreign session) are planted in the disk home, and allowlisted
  state (PERSISTED_STATE) is planted next to them; after the plan is built and before
  bwrap runs, a project settings file is planted under cwd (the r2 H race). A probe
  inside the same plan must see none of the planted paths, must see every allowlisted
  one, must fail to write a rendered file, and afterwards the workspace may differ from
  before only by empty directories the plan masks (bwrap's mount points). Where bwrap
  cannot create its namespaces (an unprivileged container) the check does not fall back
  to chmod: it starts the engine on the rendered files directly for the init claim and
  reports isolation as NOT PROVEN HERE.

Exit 0 only when every case has completed init AND proven isolation; 1 when a case
failed; 2 when nothing failed but a claim was not proven here.

Binaries are fetched from the URLs and SHA-256 pins of build-image.sh (x86_64) into a
cache directory; Fuigo comes from scripts/prepare-fuigo.mjs (dist-native/fuigo/linux-x64/fuigo).
Claude's C-mode sign-in (r8 R3.1) adds claude_token_checks: setup-token exists and prints the
token shape; a turn with only CLAUDE_CODE_OAUTH_TOKEN answers; `auth status --json` reports
signed in (MURAGE_CHECK_CLAUDE_TOKEN_FILE: a real setup-token output for a test account).
Codex's key mode (r9) adds codex_key_checks: the rendered auth.json is exactly {OPENAI_API_KEY}
and `codex login status` accepts it with no key variable set.
Usage: engine-start-check.py <repo> <cache-dir> [engine ...]   (BWRAP=/path overrides bwrap)"""
import hashlib
import importlib.util
import json
import platform
import os
import select
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

PINS = {
    "claudeAgent": ("https://downloads.claude.ai/claude-code-releases/2.1.292/linux-x64/claude", "a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3", None),
    "codex": ("https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-x86_64-unknown-linux-musl.tar.gz", "86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057", "codex-x86_64-unknown-linux-musl"),
    "grokAgent": ("https://x.ai/cli/grok-1.0.52-linux-x86_64", "1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11", None),
    "kimiAgent": ("https://code.kimi.com/kimi-code/binaries/2.2.0/kimi-code-linux-x64", "8ee7405d82958f0a50a3aab0773aba9e01057978bad93ba379eaf89e5b6111af", None),
    "opencodeGo": ("https://registry.npmjs.org/opencode-linux-x64-baseline/-/opencode-linux-x64-baseline-1.19.0.tgz", "6bdf946045ebfa5773811d0037c1ca8c8a3831880434289b9e4a40c2f1fe8432", "package/bin/opencode"),
}
UNIT = "murage-turn-0123456789abcdef.scope"
RESUME_ID = "0f1e2d3c-4b5a-4968-8776-655443322110"   # the one Codex rollout the launcher copies in (render.resume)
FOREIGN_ID = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb"  # a session no turn named: never copied
REFUSAL_WORDS = ("toml", "parse", "unknown field", "invalid config", "configuration error", "failed to load config", "schema", "expected", "deserializ")

def fetch(engine, cache):
    url, digest, member = PINS[engine]
    target = os.path.join(cache, engine)
    if os.path.exists(target):
        return target
    blob = os.path.join(cache, engine + ".download")
    with urllib.request.urlopen(url, timeout=300) as response, open(blob, "wb") as out:
        shutil.copyfileobj(response, out)
    with open(blob, "rb") as stream:
        if hashlib.sha256(stream.read()).hexdigest() != digest:
            raise SystemExit(engine + ": pinned digest mismatch")
    if member:
        with tarfile.open(blob) as archive:
            source = archive.extractfile(member)
            with open(target, "wb") as out:
                shutil.copyfileobj(source, out)
        os.unlink(blob)
    else:
        os.rename(blob, target)
    os.chmod(target, 0o755)
    return target

def load_launcher(repo):
    spec = importlib.util.spec_from_file_location("launcher", os.path.join(repo, "deploy/cloud-home/murage-turn-launch.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def cases(m, root):
    workspace = os.path.join(root, "workspaces/ws/proj")
    scratch = "native/provider-turns/fuigoAgent-0123456789ab"
    route = {"provider": "murage_0123456789abcdef", "baseUrl": "http://127.0.0.1:9/v1", "model": "fixture-model", "apiKey": "fixture-key"}
    socket = "/data/broker/perm-abcd1234.sock"
    return [
        ("claudeAgent", "unrouted", ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
         "--permission-mode", "acceptEdits", "--mcp-config", "@render:mcp", "--allowedTools", "mcp__muragebox", "--permission-prompt-tool", "mcp__muragebox__approve",
         "--append-system-prompt-file", "@render:system-prompt", "--strict-mcp-config", "--session-id", "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"],
         {"mcp": {"muragebox": {"proxy": "permission", "socket": socket}}, "systemPrompt": "${HOME}\n{env:X}\n\"quoted\"\n"}, None, workspace),
        ("codex", "routed+mcp", ["app-server", "-c", "features.browser_use=false", "-c", "features.computer_use=false"],
         {"route": route, "mcp": {"agents": {"proxy": "agents", "env": {"MURAGE_HARNESS_URL": "http://127.0.0.1:9"}}}, "resume": RESUME_ID,
          "codexPolicy": {"approval": "on-request", "sandbox": "workspace-write"}}, None, workspace),
        ("grokAgent", "unrouted", ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio"], None, None, workspace),
        ("kimiAgent", "unrouted", ["acp"], None, None, workspace),
        ("opencodeGo", "routed", ["acp"], {"route": {**route, "provider": "flux", "models": ["flux-auto"], "label": "Flux Router"}}, None, workspace),
        ("fuigoAgent", "unrouted", ["--permission-mode", "default", "--trust", "--no-memory", "agent", "--no-leader", "stdio"], None, None, None),
        ("fuigoAgent", "routed", ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "-m", "murage_selected", "stdio"],
         {"route": {**route, "protocol": "openai"}, "memoryTools": True}, [scratch], workspace),
    ]

def materialise(m, engine, home, cwd, render, scratch, args):
    """Fallback for the init claim only (no bwrap here): the rendered files at their paths.
    chmod is not isolation and is never reported as such."""
    files, shadows = m.render_plan(engine, home, cwd, render, scratch, m.add_dirs(args))
    for path in scratch:
        os.makedirs(path, exist_ok=True)
    for path in shadows:
        if os.path.isdir(path) and os.listdir(path):
            shutil.rmtree(path)
        os.makedirs(path, exist_ok=True)
    for path, text, _ in files:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.lexists(path):
            os.chmod(path, 0o644); os.unlink(path)
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(path, 0o444)
    for path in shadows:
        os.chmod(path, 0o555)
    return files, shadows

def bwrap_status():
    """(path, None) when bwrap can build an unprivileged sandbox here, else (None, reason)."""
    path = os.environ.get("BWRAP") or shutil.which("bwrap")
    if not path:
        return None, "bwrap is not installed"
    probe = subprocess.run([path, "--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    if probe.returncode != 0:
        return None, "bwrap cannot create its namespaces here: " + probe.stderr.decode("utf-8", "replace").strip()[:200]
    return path, None

# What a previous turn could have left in its home that the engine reads at start: nothing
# of it is in PERSISTED_STATE, so none of it may be in the turn's home.
HIDDEN = {
    "claudeAgent": [".claude/CLAUDE.md", ".claude/hooks/stop.sh", ".claude/plugins/installed_plugins.json", ".claude/skills/x/SKILL.md",
                    ".claude/projects/p/" + FOREIGN_ID + ".jsonl", ".claude/shell-snapshots/snap.sh", ".claude.json"],
    "codex": [".codex/hooks/x.sh", ".codex/skills/x/SKILL.md", ".codex/rules/x.toml", ".codex/sessions/2026/10/16/rollout-2026-10-16T00-00-00-" + FOREIGN_ID + ".jsonl",
              ".codex/history.jsonl", ".agents/skills/x/SKILL.md"],
    "grokAgent": [".grok/managed_config.toml", ".grok/requirements.toml", ".grok/hooks/x.sh", ".grok/plugins/x/plugin.toml", ".claude/skills/x/SKILL.md", ".cursor/hooks.json"],
    "kimiAgent": [".kimi-code/hooks/x.sh", ".kimi-code/credentials/planted.toml", ".kimi-code/sessions/s.json", ".claude/skills/x/SKILL.md"],
    "opencodeGo": [".local/share/opencode/snapshot/git/config", ".local/share/opencode/storage/session/s.json", ".cache/opencode/models.json", ".cache/opencode/bin/rg", ".local/state/opencode/model.json"],
    "fuigoAgent": [".fuigo/trusted_folders.toml", ".fuigo/hooks/x.sh", ".fuigo/plugins/x/plugin.toml", ".claude/settings.json"],
}
# Allowlisted state a previous turn of BOT left in its store (bots/<bot>/, r5 R5.2): copied
# in, so visible, within its shape. Only entries that do not change how the engine starts
# without a sign-in (a credential file with content would).
BOT = "start-check"
KEPT = {
    "claudeAgent": {".claude/.claude.json": '{"hasCompletedOnboarding": true, "mcpServers": {"evil": {"command": "/bin/true"}}, "projects": {"/x": {"allowedTools": ["Bash"]}}}'},
    "codex": {".codex/sessions/2026/10/16/rollout-2026-10-16T00-00-00-" + RESUME_ID + ".jsonl":
              '{"timestamp": "2026-10-16T00:00:00Z", "type": "session_meta", "payload": {"id": "' + RESUME_ID + '", "timestamp": "2026-10-16T00:00:00Z", "cwd": "/x", "originator": "codex", "cli_version": "0.162.1"}}\n'},
}
# The r2 H race: planted after the plan is built and before bwrap runs, inside cwd. The names must be ones the
# launcher itself never renders (it renders .kimi-code/local.toml, .opencode/opencode.json and .fuigo/config.toml
# into the masked directories), or the probe would report its own rendered file as a leak.
RACE = {"claudeAgent": ".claude/settings.json", "codex": ".codex/config.toml", "grokAgent": ".claude/settings.json", "kimiAgent": ".kimi-code/planted.toml",
        "opencodeGo": ".opencode/planted.json", "fuigoAgent": ".fuigo/planted.toml"}

def planted_paths(m, engine, home):
    relative = [".bashrc", ".profile", ".gitconfig", ".npmrc", ".cache/planted", ".local/state/planted", "tmp/planted"] + HIDDEN[engine]
    return [os.path.join(home, r) for r in relative]

def plant(m, engine, home):
    paths = planted_paths(m, engine, home)
    for path in paths:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stream:
            if path.endswith("opencode/models.json"):
                # Astra's vector: a cached catalog naming a local module as a provider SDK.
                json.dump({"opencode": {"id": "opencode", "npm": "file://" + home + "/persisted-sdk.mjs", "models": {}}}, stream)
            else:
                stream.write("planted by a previous turn\n")
    for relative, text in KEPT.get(engine, {}).items():
        stored = os.path.join(home, "bots", BOT, relative)
        os.makedirs(os.path.dirname(stored), exist_ok=True)
        with open(stored, "w", encoding="utf-8") as stream:
            stream.write(text)
    return paths

def sandbox_argv(m, engine, home, cwd, render, scratch_rel, args, binary, bwrap, inner):
    """The launcher's own plan (a staged turn home, then turn_mount_args with the mounts
    launch() passes), run by bwrap directly: rendered files travel as real descriptors,
    the engine binary is bound at /opt/murage-check, and `inner` replaces the launcher's
    --child re-exec. Returns (argv, fds, turn_home)."""
    turn_home = tempfile.mkdtemp(prefix="turn-home-", dir=os.path.dirname(os.path.dirname(home)))
    fd, tfd = os.open(home, os.O_RDONLY | os.O_DIRECTORY), os.open(turn_home, os.O_RDONLY | os.O_DIRECTORY)
    try:
        m.stage_turn_home(fd, engine, tfd, None, (os.getuid(),), m.turn_state_ids(engine, args, render), bot=BOT, cwd=cwd, render=render)
    finally:
        os.close(fd); os.close(tfd)
    mounts = [(cwd, cwd)] if cwd != home else []
    argv, blobs = m.turn_mount_args(engine, mounts, home, cwd, "/opt/murage-check/" + os.path.basename(binary), args, render, scratch_rel, turn_home=turn_home)
    split = argv.index("--")
    options, fds = argv[:split], []
    for index, arg in enumerate(options):
        if arg.startswith(m.FD_TOKEN):
            data = blobs[arg[len(m.FD_TOKEN):]]
            with tempfile.TemporaryFile() as stream:
                stream.write(data.encode() if isinstance(data, str) else data)
                stream.flush()
                read = os.open("/proc/self/fd/" + str(stream.fileno()), os.O_RDONLY)
            fds.append(read)
            options[index] = str(read)
    options[0] = bwrap
    if "--disable-userns" in options:
        options.remove("--disable-userns")  # needs bwrap 0.8; not what this check proves
    return options + ["--ro-bind", os.path.dirname(binary), "/opt/murage-check", "--"] + inner, fds, turn_home

def probe_isolation(m, argv_fds, planted, kept, rendered):
    """Inside the plan: every planted path absent, every kept path present (and a kept
    .claude.json without its dropped keys), the first rendered file unwritable."""
    argv, fds, _turn_home = argv_fds
    script = 'for p in "$@"; do if [ "$p" = "--" ]; then shift; break; fi; [ -e "$p" ] && echo "VISIBLE $p"; shift; done; ' \
             'for p in "$@"; do if [ "$p" = "--" ]; then shift; break; fi; [ -e "$p" ] || echo "MISSING $p"; ' \
             'case "$p" in *.claude.json) grep -q mcpServers "$p" && echo "UNFILTERED $p";; esac; shift; done; ' \
             'for f in "$@"; do (echo x >> "$f") 2>/dev/null && echo "WRITABLE $f"; done; echo PROBE-DONE'
    run = subprocess.run(argv + ["/bin/sh", "-c", script, "probe"] + planted + ["--"] + kept + ["--"] + rendered[:1], pass_fds=fds,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    for fd in fds:
        os.close(fd)
    out = run.stdout.decode("utf-8", "replace")
    if "PROBE-DONE" not in out:
        return "FAILED: probe did not run inside the plan: " + run.stderr.decode("utf-8", "replace")[-300:]
    leaks = [line for line in out.splitlines() if line.startswith(("VISIBLE", "MISSING", "UNFILTERED", "WRITABLE"))]
    return "FAILED: " + "; ".join(leaks) if leaks else "proven"

def plan_shadows(argv):
    return [argv[i + 1] for i, a in enumerate(argv) if a == "--tmpfs"]

def workspace_diff_allowed(before, after, shadows):
    """Only empty directories the plan masks may appear (bwrap's mount points)."""
    added = sorted(set(after) - set(before))
    if set(before) - set(after):
        return False
    return all(path in shadows and os.path.isdir(path) and not os.listdir(path) for path in added)

def tree(root):
    out = []
    for directory, dirs, files in os.walk(root):
        out += [os.path.join(directory, name) for name in dirs + files]
    return sorted(out)

def sign_in_gate(engine, frame):
    """The engine's answer to session/new (ACP: exactly code -32000 "Authentication
    required") or thread/start (Codex: an error naming its sign-in) on a home with no
    sign-in: the configuration loaded, the start did not complete. Reported as NOT
    PROVEN, never as complete (Astra r2 M)."""
    error = frame.get("error") if frame.get("id") == 2 else None
    if not isinstance(error, dict):
        return False
    if engine == "codex":
        return any(word in str(error.get("message", "")).lower() for word in ("auth", "login", "sign"))
    return error.get("code") == -32000 and error.get("message") == "Authentication required"

def init_state(engine, frames):
    """"complete", "sign-in gate", or None: the engine finished starting (a real
    sessionId or thread id), not merely answered (Astra r1 M, r2 M)."""
    if any("error" in f for f in frames if f.get("id") == 1):
        return None
    if engine == "claudeAgent":
        return "complete" if any(f.get("type") == "system" and f.get("subtype") == "init" for f in frames) else None
    if not any(f.get("id") == 1 and isinstance(f.get("result"), dict) for f in frames):
        return None
    for f in frames:
        if f.get("id") == 2 and isinstance(f.get("result"), dict):
            result = f["result"]
            if engine == "codex" and isinstance(result.get("thread"), dict) and result["thread"].get("id"):
                return "complete"
            if engine != "codex" and result.get("sessionId"):
                return "complete"
    return "sign-in gate" if any(sign_in_gate(engine, f) for f in frames) else None

def init_complete(engine, frames):
    return init_state(engine, frames) == "complete"

def converse(argv, env, cwd, engine, timeout=90, pass_fds=(), sandboxed=False):
    # Sandboxed, bwrap --chdir sets the directory inside; the session still names cwd.
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=None if sandboxed else cwd, pass_fds=pass_fds)
    for fd in pass_fds:
        os.close(fd)
    frames, stderr = [], b""
    def send(obj):
        process.stdin.write((json.dumps(obj) + "\n").encode()); process.stdin.flush()
    if engine == "claudeAgent":
        send({"type": "user", "message": {"role": "user", "content": "hi"}})
    elif engine == "codex":
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "murage-check", "version": "1"}}})
    else:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}}})
    deadline, buffer, sent_new = time.monotonic() + timeout, b"", False
    while time.monotonic() < deadline and process.poll() is None:
        ready, _, _ = select.select([process.stdout, process.stderr], [], [], 0.5)
        for stream in ready:
            chunk = os.read(stream.fileno(), 65536)
            if stream is process.stderr:
                stderr += chunk
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                frames.append(frame)
                if engine == "codex" and frame.get("id") == 1 and not sent_new:
                    sent_new = True
                    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
                    send({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {"cwd": cwd, "sandbox": "read-only", "approvalPolicy": "never"}})
                elif engine != "claudeAgent" and frame.get("id") == 1 and not sent_new:
                    sent_new = True
                    send({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": cwd, "mcpServers": []}})
        if init_complete(engine, frames) or any("error" in f for f in frames if f.get("id") in (1, 2)):
            break
    process.kill()
    out, err = process.communicate()
    return frames, (stderr + err).decode("utf-8", "replace"), process.returncode

def claude_token_checks(m, binary, root):
    """r8 R3.1's three verifications on the pinned Claude binary (C mode `oauth-token`):
    (a) `setup-token` exists and the token it printed has the shape TokenFilter captures,
    (b) a turn with only CLAUDE_CODE_OAUTH_TOKEN (no .credentials.json anywhere) reaches its
    first answering stream-json frame, (c) `auth status --json` reports signed in. (b) and
    (c) need a real token: MURAGE_CHECK_CLAUDE_TOKEN_FILE names a file holding the output of
    a real `claude setup-token` for a test account; without it they are NOT PROVEN HERE.
    Returns [(id, "ok" | "FAILED: ..." | "NOT PROVEN HERE: ...")]; never prints the token."""
    out = []
    probe = subprocess.run([binary, "setup-token", "--help"], capture_output=True, text=True, timeout=60)
    out.append(("claude.setup-token.exists", "ok" if probe.returncode == 0 and "token" in (probe.stdout + probe.stderr).lower() else "FAILED: setup-token --help exited " + str(probe.returncode)))
    path = os.environ.get("MURAGE_CHECK_CLAUDE_TOKEN_FILE")
    if not path:
        return out + [(name, "NOT PROVEN HERE: MURAGE_CHECK_CLAUDE_TOKEN_FILE is not set") for name in ("claude.setup-token.shape", "claude.token.stream-json", "claude.token.auth-status")]
    with open(path, "rb") as stream:
        printed = stream.read(1 << 20)
    filt = m.TokenFilter()
    shown = filt.feed(printed) + filt.flush()
    token = filt.token.decode("ascii") if filt.token is not None else None
    leaked = token is not None and token.encode("ascii") in shown
    out.append(("claude.setup-token.shape", "ok" if token and not leaked else "FAILED: " + ("the token reached the filtered stream" if leaked else "no sk-ant-oat01- token in the setup-token output")))
    if not token:
        return out + [(name, "FAILED: no token") for name in ("claude.token.stream-json", "claude.token.auth-status")]
    home = os.path.join(root, "claude-token-home")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, ".claude"))
    env, _ = m.engine_environment("claudeAgent", home, {"LANG": "C.UTF-8"})
    m.signin_environment("claudeAgent", env, {"credentials": {"token": token}})
    env["PATH"] = os.path.dirname(binary) + ":" + env["PATH"]
    os.makedirs(env["TMPDIR"], exist_ok=True)
    argv = [binary, "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--strict-mcp-config", "--permission-mode", "default"]
    frames, _stderr, _code = converse(argv, env, home, "claudeAgent", timeout=120)
    answered = [f for f in frames if f.get("type") == "assistant" or (f.get("type") == "result" and f.get("is_error") is False)]
    planted = os.path.exists(os.path.join(home, ".claude", ".credentials.json"))
    out.append(("claude.token.stream-json", "ok" if answered and not planted else "FAILED: " + ("a .credentials.json was written" if planted else "no answering frame: " + ",".join(str(f.get("type")) + "/" + str(f.get("subtype")) for f in frames[:6]))))
    status = subprocess.run([binary, "auth", "status", "--json"], capture_output=True, text=True, env=env, timeout=60)
    try:
        signed = json.loads(status.stdout).get("loggedIn") is True
    except (ValueError, AttributeError):
        signed = False
    out.append(("claude.token.auth-status", "ok" if signed else "FAILED: auth status --json does not report loggedIn"))
    shutil.rmtree(home, ignore_errors=True)
    return out

CODEX_CHECK_KEY = "sk-murage-start-check-000000000000000000"  # not a key: only its shape is read; secret-scan: fixture

def codex_key_checks(m, binary, root):
    """r9 "H Codex C" on the pinned Codex binary: the launcher's rendered key-mode auth.json
    (exactly {"OPENAI_API_KEY"}) is a sign-in Codex accepts, with CODEX_API_KEY unset. The
    file is read through `codex login status`, which reads auth.json and calls no network.
    Returns [(id, "ok" | "FAILED: ...")]."""
    home = os.path.join(root, "codex-key-home")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, ".codex"))
    render = dict(m.validate_render("codex", None, UNIT[len("murage-turn-"):-len(".scope")]), credentials={"key": CODEX_CHECK_KEY})
    files, _shadows = m.render_plan("codex", home, home, render, [], [])
    rendered = [(path, text) for path, text, name in files if name == "codex.auth"]
    out = []
    if len(rendered) != 1 or rendered[0][0] != os.path.join(home, ".codex/auth.json") or sorted(json.loads(rendered[0][1])) != ["OPENAI_API_KEY"]:
        shutil.rmtree(home, ignore_errors=True)
        return [("codex.key.rendered", "FAILED: the key-mode plan does not render exactly .codex/auth.json {OPENAI_API_KEY}")]
    out.append(("codex.key.rendered", "ok"))
    with open(rendered[0][0], "w", encoding="utf-8") as stream:
        stream.write(rendered[0][1])
    os.chmod(rendered[0][0], 0o444)
    env, _ = m.engine_environment("codex", home, {"LANG": "C.UTF-8"})
    m.signin_environment("codex", env, render)
    env.pop("CODEX_API_KEY", None)
    env.pop("OPENAI_API_KEY", None)
    status = subprocess.run([binary, "login", "status"], capture_output=True, text=True, env=env, timeout=60)
    said = (status.stdout + status.stderr).lower()
    out.append(("codex.key.accepted", "ok" if status.returncode == 0 and "api key" in said else "FAILED: codex login status exited " + str(status.returncode) + ": " + said.replace(CODEX_CHECK_KEY.lower(), "<key>")[:300]))
    os.chmod(rendered[0][0], 0o644)
    shutil.rmtree(home, ignore_errors=True)
    return out

FUIGO_BINARY = "dist-native/fuigo/linux-x64/fuigo"

def ensure_fuigo(repo):
    """Fuigo is not fetched like the other engines: it is built by scripts/prepare-fuigo.mjs. The
    image recipe (build-image.sh) runs it with --target; a checkout that did not (a gate run from a
    plain clone) gets `--current` here. Anything still missing fails with a message that says why,
    instead of the case dying on a missing path."""
    binary = os.path.join(repo, FUIGO_BINARY)
    if os.path.isfile(binary) and os.access(binary, os.X_OK):
        return binary
    script = os.path.join(repo, "scripts/prepare-fuigo.mjs")
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise SystemExit("FUIGO PREREQUISITE: " + binary + " is missing and this host is not linux-x64, so `node scripts/prepare-fuigo.mjs --current` cannot produce it. Run the gate on the home image (linux-x64).")
    print("# fuigo: " + binary + " missing, running `node scripts/prepare-fuigo.mjs --current` in " + repo, flush=True)
    run = subprocess.run(["node", script, "--current"], cwd=repo, capture_output=True, text=True, timeout=1800)
    if run.returncode != 0 or not os.path.isfile(binary):
        raise SystemExit("FUIGO PREREQUISITE: `node scripts/prepare-fuigo.mjs --current` did not produce " + binary + " (exit " + str(run.returncode) + "): " + (run.stdout + run.stderr).strip()[-600:])
    os.chmod(binary, os.stat(binary).st_mode | 0o111)
    return binary

def main():
    repo, cache = sys.argv[1], sys.argv[2]
    wanted = set(sys.argv[3:])
    os.makedirs(cache, exist_ok=True)
    if not wanted or "fuigoAgent" in wanted:
        ensure_fuigo(repo)
    m = load_launcher(repo)
    # The proxies are never started by a first protocol message: the stanzas only need a path.
    m.proxy_script = lambda kind, *rest: m.MCP_PROXY_ROOT + "/" + m.MCP_PROXIES[kind]["script"] + ".js"
    bwrap, why = bwrap_status()
    root = tempfile.mkdtemp(prefix="engine-start-")
    m.WORKSPACE_ROOT = os.path.join(root, "workspaces")
    os.makedirs(os.path.join(root, "workspaces/ws/proj"))
    with open(os.path.join(root, "workspaces/ws/proj/README.md"), "w") as stream:
        stream.write("owner file\n")
    failures, unproven = [], []
    for engine, label, args, render_in, scratch_rel, cwd in cases(m, root):
        if wanted and engine not in wanted:
            continue
        binary = os.path.join(repo, FUIGO_BINARY) if engine == "fuigoAgent" else fetch(engine, cache)
        home = os.path.join(root, "engine-homes", engine)
        shutil.rmtree(home, ignore_errors=True)
        os.makedirs(home)
        for relative in m.credential_dirs(engine):
            os.makedirs(os.path.join(home, relative), mode=0o770, exist_ok=True)
        cwd = cwd or home
        scratch = [os.path.join(home, s) for s in (scratch_rel or [])]
        render = m.validate_render(engine, render_in, UNIT[len("murage-turn-"):-len(".scope")])
        argv = m.check_argv(engine, args, render)
        env, _ = m.engine_environment(engine, home, {"LANG": "C.UTF-8"}, scratch)
        env.update(m.render_environment(engine, home, render))
        if bwrap:
            planted = plant(m, engine, home)
            kept = [os.path.join(home, relative) for relative in KEPT.get(engine, {})]
            files, shadows = m.render_plan(engine, home, cwd, render, scratch, m.add_dirs(argv))
            plan = sandbox_argv(m, engine, home, cwd, render, scratch_rel or [], argv, binary, bwrap, [])
            # The race (Astra r2 H): the plan is built; now another turn plants project config under cwd.
            race = os.path.join(cwd, RACE[engine])
            os.makedirs(os.path.dirname(race), exist_ok=True)
            with open(race, "w", encoding="utf-8") as stream:
                stream.write('{"hooks": {"Stop": [{"command": "/bin/true"}]}}\n')
            before = tree(m.WORKSPACE_ROOT)
            isolation = probe_isolation(m, plan, planted + [race], kept, [p for p, _, _ in files])
            env["PATH"] = "/opt/murage-check:" + env["PATH"]
            command, fds, _turn_home = sandbox_argv(m, engine, home, cwd, render, scratch_rel or [], argv, binary, bwrap, ["/opt/murage-check/" + os.path.basename(binary)] + argv)
            frames, stderr, code = converse(command, env, cwd, engine, pass_fds=fds, sandboxed=True)
            if not workspace_diff_allowed(before, tree(m.WORKSPACE_ROOT), plan_shadows(command)):
                isolation = "FAILED: the turn changed the workspace tree: " + " ".join(sorted(set(tree(m.WORKSPACE_ROOT)) ^ set(before)))[:400]
        else:
            isolation = "NOT PROVEN HERE: " + why
            env["PATH"] = os.path.dirname(binary) + ":" + env["PATH"]
            os.makedirs(env["TMPDIR"], exist_ok=True)
            files, shadows = materialise(m, engine, home, cwd, render, scratch, argv)
            frames, stderr, code = converse([binary] + argv, env, cwd, engine)
        # A refusal of the rendered config is an error frame or an error log line that names
        # config, TOML or parsing. Codex's notice that an (empty, launcher-shadowed) project
        # .codex is untrusted, and an authentication error, are not refusals.
        errors = [json.dumps(f.get("error")).lower() for f in frames if "error" in f] + \
            [line.lower() for line in stderr.split("\n") if any(w in line.lower() for w in ("error", "failed", "invalid")) and "project-local config" not in line.lower() and "trusted project in" not in line.lower()]
        refused = sorted({word for line in errors for word in REFUSAL_WORDS if word in line and any(k in line for k in ("config", "toml", "parse"))})
        init = (init_state(engine, frames) if not refused else None) or "INCOMPLETE"
        if init == "sign-in gate":
            init = "NOT PROVEN HERE: sign-in required (the engine stopped at its sign-in gate; no sessionId or thread id)"
        brief = [json.dumps(frame)[:700] for frame in frames if frame.get("id") in (1, 2) or frame.get("type") in ("system", "result") or "method" in frame][:5]
        print(json.dumps({"engine": engine, "case": label, "init": init, "isolation": isolation, "argv": argv, "files": len(files), "shadows": len(shadows),
                          "frames": brief, "setupPhases": [f["params"].get("phase") for f in frames if str(f.get("method", "")).endswith("session/setup") and isinstance(f.get("params"), dict)], "lastFrames": [json.dumps(f)[:300] for f in frames[-3:]], "stderr": stderr[-800:], "refusalWords": refused, "exit": code}, default=str))
        if init == "INCOMPLETE" or isolation.startswith("FAILED"):
            failures.append(engine + ":" + label)
        elif isolation != "proven" or init != "complete":
            unproven.append(engine + ":" + label + ("" if init == "complete" else " (sign-in required)"))
    extra = []
    if not wanted or "claudeAgent" in wanted:
        extra += [("claudeAgent", check, verdict) for check, verdict in claude_token_checks(m, fetch("claudeAgent", cache), root)]
    if not wanted or "codex" in wanted:
        extra += [("codex", check, verdict) for check, verdict in codex_key_checks(m, fetch("codex", cache), root)]
    if extra:
        for engine, check, verdict in extra:
            print(json.dumps({"engine": engine, "case": check, "result": verdict}))
            if verdict.startswith("FAILED"):
                failures.append(check)
            elif verdict != "ok":
                unproven.append(check)
    if failures:
        print("RESULT FAILED " + " ".join(failures))
        sys.exit(1)
    if unproven:
        print("RESULT NOT PROVEN HERE (" + ("isolation not proven: " + why + "; " if why else "") + "sign-in gate counts as not proven) " + " ".join(unproven))
        sys.exit(2)
    print("RESULT ok (init complete and isolation proven for every case)")
    sys.exit(0)

if __name__ == "__main__":
    main()
