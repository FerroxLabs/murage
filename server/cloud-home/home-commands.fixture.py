# SPDX-License-Identifier: AGPL-3.0-or-later
"""Disposable fixture for deploy/cloud-home/murage-commands: the real module, with the control plane, systemctl and
(where named) the upload and journal boundaries injected. restic, openssl, age, zstd and tar run for real.
Usage: python3 -I home-commands.fixture.py <murage-commands> <murage-backup> <excludes> <scenario>
Prints one JSON line; any failed check exits non-zero with the reason on stderr."""
import base64
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import uuid

program, backup_program, excludes_file, scenario = sys.argv[1:5]
CONTRACT = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else None
NOW = 1_900_000_000_000
DEADLINE = NOW + 3_600_000

def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

m = load("murage_commands_fixture", program)
backup = load("murage_backup_fixture", backup_program)
CREDENTIAL = base64.b64encode(bytes(range(7, 39))).decode()
ENV_SECRET = "envSecretValue9Q7w3XkLmP2rT8"
SERVER_ENV_SECRET = "srvEnvSecret4Zq8Vn1Bc6Xs0Hj"
CLAUDE_TOKEN = "sk-ant-oat01-FAKEclaudeToken0123456789abcdefXYZ"  # secret-scan: fixture
CODEX_TOKEN = "codexRefresh7f3k2m9p1q8r4t6v0w5x"
GROK_TOKEN = "grokSecret2a4c6e8g0i1k3m5o7q9s"
BACKUP_PASSWORD = "backupPassword8d7f6g5h4j3k2l1"
os.environ["MURAGE_FAKE_API_KEY"] = ENV_SECRET
results = {}

class PowerLoss(BaseException):
    """A crash: nothing in the runner catches it, so its journal stays as it was at that instant."""

def check(condition, reason):
    if not condition:
        print("CHECK FAILED: " + reason, file=sys.stderr)
        sys.exit(1)

class CP:
    """The machine routes of self-service.ts, modeled: commands listed until acknowledged."""
    def __init__(self, binding):
        self.binding, self.pending, self.requests, self.fail_ack = binding, [], [], 0
    def add(self, kind, payload, cid=None, **extra):
        command = {"id": cid or str(uuid.uuid4()), "kind": kind, "payload": payload, "issuedAt": NOW - 1000, "expiresAt": DEADLINE}
        command.update(extra)
        self.pending.append(command)
        return command["id"]
    def __call__(self, binding, operation, body=None):
        assert binding is self.binding
        self.requests.append({"operation": operation, "body": body})
        if operation == "commands":
            return {"homeId": "home-test", "generation": 3, "pollEveryMs": 60000, "commands": list(self.pending[:10])}  # the route answers LIMIT 10
        if operation == "commands/ack":
            if self.fail_ack:
                self.fail_ack -= 1
                raise OSError("network down")
            self.pending = [c for c in self.pending if c["id"] != body["commandId"]]
            return {"acknowledged": True}
        if operation == "logs":
            if body["final"]:
                self.pending = [c for c in self.pending if c["id"] != body["commandId"]]
            return {"accepted": True, "lines": len(body["lines"])}
        if operation == "export-ready":
            self.pending = [c for c in self.pending if c["id"] != body["commandId"]]
            return {"accepted": True, "availableUntil": 5}
        raise AssertionError(operation)
    def of(self, operation):
        return [r["body"] for r in self.requests if r["operation"] == operation]

def setup(root, data=None):
    binding = {"homeId": "home-test", "generation": 3, "adminUrl": "https://admin.murage.test", "publicOrigin": "https://home.murage.test",
               "credential": CREDENTIAL}
    paths = {"data": data or os.path.join(root, "data"), "state": os.path.join(root, "state"), "config": os.path.join(root, "config"),
             "opt": os.path.join(root, "opt", "murage"), "run": os.path.join(root, "run")}
    for p in paths.values():
        os.makedirs(p, exist_ok=True)
    shutil.copy(excludes_file, os.path.join(paths["config"], "backup-excludes.txt"))
    with open(os.path.join(root, "backup.pass"), "w") as handle:
        handle.write(BACKUP_PASSWORD + "\n")
    with open(os.path.join(paths["config"], "backup.json"), "w") as handle:
        json.dump({"repository": os.path.join(root, "repo"), "passwordFile": os.path.join(root, "backup.pass")}, handle)
    ctx = m.default_context(binding, backup)
    cp = CP(binding)
    calls = []
    # active: the home comes up (and its app answers) when started; app: the app answers (None: same as active); stuck: units that
    # never stop; running: what systemd has active now.
    active = {"value": True, "app": None, "stuck": set(), "running": {m.HOME_UNIT}}
    def systemctl(*args):
        calls.append(list(args))
        units = [a for a in args[1:] if not a.startswith("-")]
        if args[0] == "is-active":
            return 0 if units[0] in active["running"] else 3
        if args[0] == "stop":
            active["running"] -= set(units) - active["stuck"]
            return 0 if not set(units) & active["stuck"] else 1
        if args[0] in ("start", "restart"):
            # murage-home.service: ConditionPathExists=!/var/lib/murage-home/recovery-inhibit (a skipped start still exits 0).
            if os.path.exists(os.path.join(paths["state"], "recovery-inhibit")):
                units = [u for u in units if u != m.HOME_UNIT]
            if active["value"]:
                active["running"] |= set(units)
            else:
                active["running"] -= set(units)  # it starts and dies at once
            return 0
        return 0
    def unit_state(unit):
        return "active" if unit in active["running"] else "inactive"
    def app_healthy():
        up = m.HOME_UNIT in active["running"]
        return up and (active["value"] if active["app"] is None else active["app"])
    ctx.update(request=cp, systemctl=systemctl, sleep=lambda _s: None, now=lambda: NOW, paths=paths, unit_state=unit_state,
               app_healthy=app_healthy, disk_free=lambda _p: 1 << 50,
               environs=lambda _ctx: [dict(os.environ), {"PATH": "/usr/bin", "ANTHROPIC_API_KEY": SERVER_ENV_SECRET}])
    return ctx, cp, calls, active

STOP = ["stop", "murage-home.service", "murage-turns.slice", "murage-browsers.slice"]

class FakeRestic:
    """restic for scenarios that inject a failure: a confirmed complete nightly, the pre-reset backup's exit code and summary, the
    snapshots it then lists, and a restore that plants the given data."""
    def __init__(self, data, backup_code=0, complete=True, restore_plant="restored", on_restore=None):
        self.data, self.backup_code, self.complete, self.restore_plant, self.on_restore = data, backup_code, complete, restore_plant, on_restore
        self.calls, self.pre_reset = [], []
    def __call__(self, argv, **_kwargs):
        if argv[0] != "restic":
            return 0, b""
        self.calls.append(argv[1])
        if argv[1] == "snapshots":
            tags = argv[argv.index("--tag") + 1].split(",")
            pool = [{"id": "a" * 64, "time": "2030-01-01T00:00:00Z", "tags": ["nightly"] + (["complete"] if self.complete else []), "paths": [self.data]}]
            pool += self.pre_reset
            return 0, json.dumps([s for s in pool if all(t in s["tags"] for t in tags)]).encode()
        if argv[1] == "backup":
            if self.backup_code == 0:
                self.pre_reset.append({"id": "b" * 64, "time": "2030-01-02T00:00:00Z", "paths": [self.data],
                                       "tags": [argv[i + 1] for i, a in enumerate(argv) if a == "--tag"]})
            return self.backup_code, (json.dumps({"message_type": "summary", "snapshot_id": "b" * 64}) + "\n").encode()
        if argv[1] == "restore":
            target = argv[argv.index("--target") + 1]
            plant(os.path.join(target, self.data.lstrip("/")), self.restore_plant)
            if self.on_restore:
                self.on_restore(target)
            return 0, b""
        return 0, b""

def plant(data, version="v1"):
    """Customer files plus fake engine sign-ins in every credential location the launcher uses."""
    files = {
        "home/work/report.md": "report " + version,
        "home/memory/notes.txt": "notes " + version,
        "home/owner.json": '{"timeZone":"UTC"}',
        "home/engines/claudeAgent/.claude/.credentials.json": json.dumps({"claudeAiOauth": {"accessToken": CLAUDE_TOKEN, "expiresAt": 1}}),
        "home/engines/claudeAgent/.claude.json": json.dumps({"oauthAccount": {"token": CLAUDE_TOKEN}}),
        "home/engines/codex/.codex/auth.json": json.dumps({"tokens": {"refresh_token": CODEX_TOKEN}}),
        "engines/grokAgent/.grok/auth.json": json.dumps({"key": GROK_TOKEN}),
        "home/engines/kimiAgent/.kimi-code/credentials": GROK_TOKEN + "-kimi1",
        "home/secrets/credentials.enc": "sealed " + CLAUDE_TOKEN,
        "browser/bot1/Default/Cookies": "cookie " + CLAUDE_TOKEN,
    }
    for rel, body in files.items():
        full = os.path.join(data, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as handle:
            handle.write(body)
    return files

CREDENTIAL_MARKERS = ("/.claude", "/.codex", "/.grok", "/.kimi-code", "/.gemini", "/.qwen", "/.cursor", "/.factory", "/.droid",
                      "/.antigravity", "/home/secrets", "auth.json", ".credentials.json")
_watching = []
_opened = []

def _audit(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        _opened.append(args[0].decode(errors="replace") if isinstance(args[0], bytes) else args[0])
    if _watching and event in ("open", "os.listdir", "os.scandir") and args and isinstance(args[0], (str, bytes)):
        target = args[0].decode(errors="replace") if isinstance(args[0], bytes) else args[0]
        if any(marker in target for marker in CREDENTIAL_MARKERS):
            _watching[-1].append(target)

sys.addaudithook(_audit)

def watch_credential_reads():
    """From now on, every open/listing of an engine sign-in path is recorded in the returned list (it must stay empty)."""
    seen = []
    _watching.append(seen)
    return seen

ALL_SECRETS = (CREDENTIAL, ENV_SECRET, SERVER_ENV_SECRET, CLAUDE_TOKEN, CODEX_TOKEN, GROK_TOKEN, BACKUP_PASSWORD)

def tree(data):
    found = {}
    for current, dirs, names in os.walk(data):
        dirs[:] = [d for d in dirs if not (current == data and d in m.WORK_DIRS)]
        for name in names:
            full = os.path.join(current, name)
            with open(full) as handle:
                found[os.path.relpath(full, data)] = handle.read()
    return found


# ---- scenarios ------------------------------------------------------------------------------------------------------

def restart(root):
    ctx, cp, calls, _ = setup(root)
    cid = cp.add("restart_service", {"reason": "fix_it:watchdog"})
    check(m.poll_once(ctx) == [("restart_service", "done")], "restart ran")
    check(calls[0] == ["restart", "murage-home.service"], "systemctl restart of the home unit")
    check(cp.of("commands/ack") == [{"generation": 3, "commandId": cid, "outcome": "done"}], "acknowledged done")
    # The same id again (a lost ack, a replay): never runs twice, never re-acked once acknowledged.
    cp.add("restart_service", {"reason": "fix_it:watchdog"}, cid=cid)
    before = len(calls)
    m.poll_once(ctx)
    check(len(calls) == before, "a known command id never runs again")
    check(len(cp.of("commands/ack")) == 1, "no second ack once acknowledged")
    check(not os.path.exists(os.path.join(ctx["paths"]["run"], "murage-safe-mode")), "restart is normal mode")
    results["restart"] = calls

def safe_mode(root):
    ctx, cp, calls, active = setup(root)
    cp.add("safe_mode", {"reason": "customer"})
    check(m.poll_once(ctx) == [("safe_mode", "done")], "safe mode ran")
    flag = os.path.join(ctx["paths"]["run"], "murage-safe-mode")
    check(os.path.isfile(flag) and oct(os.stat(flag).st_mode & 0o777) == "0o600", "flag written for the next start")
    check(["restart", "murage-home.service"] in calls, "home restarted")
    os.unlink(flag)
    active["value"] = False
    cp.add("safe_mode", {"reason": "customer"})
    check(m.poll_once(ctx) == [("safe_mode", "failed")], "a home that does not come back is reported failed")
    check(not os.path.exists(flag), "a failed safe mode leaves no flag behind")
    cp.add("restart_service", {"reason": "customer"})
    open(flag, "w").close()
    active["value"] = True
    m.poll_once(ctx)
    check(not os.path.exists(flag), "a normal restart clears safe mode")

def refusals(root):
    ctx, cp, calls, _ = setup(root)
    ids = [cp.add("reboot", {}), cp.add("restart_service", {"reason": "customer", "extra": 1}),
           cp.add("restart_service", {"reason": "customer; rm -rf /"}), cp.add("restart_service", {"reason": "$(id)"}),
           cp.add("collect_logs", {"maxLines": 481, "redact": True, "chatContent": False}),
           cp.add("collect_logs", {"maxLines": 10, "redact": False, "chatContent": False}),
           cp.add("update_software", {"keep": ["files"], "reason": "customer"}),
           cp.add("reset_from_backup", {"resetId": "11111111-1111-1111-1111-111111111111", "from": "last_good_backup", "snapshotFirst": True,
                                        "snapshotTag": "murage-pre-reset-../../etc", "keepSnapshotUntil": 5}),
           cp.add("undo_reset", {"resetId": "11111111-1111-1111-1111-111111111111", "snapshotTag": "x"}),
           cp.add("export_archive", {"requestId": "r1", "deliverBy": 1, "format": "tar.zst.age", "path": "exports/../../etc/archive.tar.zst.age"}),
           cp.add("export_archive", {"requestId": "../r1", "deliverBy": 1, "format": "tar.zst.age", "path": "exports/../r1/archive.tar.zst.age"})]
    cp.pending.insert(0, {"id": "not-a-uuid", "kind": "restart_service", "payload": {"reason": "customer"}, "issuedAt": 1, "expiresAt": DEADLINE})
    cp.pending.insert(0, {"id": str(uuid.uuid4()), "kind": "restart_service", "payload": {"reason": "customer"}, "issuedAt": 1, "expiresAt": DEADLINE, "x": 1})
    outcomes = m.poll_once(ctx) + m.poll_once(ctx)
    check(len(cp.pending) == 2, "malformed envelopes are never acknowledged (no usable id)")
    check([o for _, o in outcomes] == ["unsupported"] * len(ids), "every unknown kind or field is unsupported: %r" % outcomes)
    check(sorted(a["commandId"] for a in cp.of("commands/ack")) == sorted(ids), "each refusal acknowledged; malformed envelopes skipped")
    check(calls == [], "nothing ran")
    for response in ({"homeId": "other", "generation": 3, "pollEveryMs": 1, "commands": []},
                     {"homeId": "home-test", "generation": 2, "pollEveryMs": 1, "commands": []},
                     {"homeId": "home-test", "generation": 3, "pollEveryMs": 1, "commands": [], "more": 1}):
        ctx["request"] = lambda *_a, r=response: r
        try:
            m.poll_once(ctx)
            check(False, "a foreign, stale or widened command list is refused")
        except ValueError:
            pass

def interrupted(root):
    ctx, cp, calls, _ = setup(root)
    cid = cp.add("restart_service", {"reason": "customer"})
    m.journal_claim(ctx, cid, {"kind": "restart_service", "state": "running", "startedAt": 1, "acked": False})
    check(m.poll_once(ctx) == [("restart_service", "failed")], "an interrupted command is reported failed")
    check(calls == [], "and is not run again")
    # A lost ack: the outcome is kept and re-sent on the next poll, without running again.
    ctx2, cp2, calls2, _ = setup(os.path.join(root, "second"))
    cp2.fail_ack = 1
    cid2 = cp2.add("restart_service", {"reason": "customer"})
    m.poll_once(ctx2)
    m.poll_once(ctx2)
    check(len([c for c in calls2 if c[0] == "restart"]) == 1, "ran once across a failed ack")
    check([a["outcome"] for a in cp2.of("commands/ack")] == ["done", "done"] and cp2.pending == [], "re-acknowledged done")

def make_release(root, revision, sequence, key, extra=None, bad_member=False):
    stage = io.BytesIO()
    with tarfile.open(fileobj=stage, mode="w:gz") as tar:
        members = {"dist-server/cloud-home-supervisor.js": b"// supervisor " + revision.encode(), "dist-server/index.js": b"// server",
                   "bin/fuigo": b"#!/bin/true\n"}
        members.update(extra or {})
        for name, body in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(body), 0o4777 if name == "bin/fuigo" else 0o666
            tar.addfile(info, io.BytesIO(body))
        if bad_member:
            info = tarfile.TarInfo("../escape")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
    archive = stage.getvalue()
    name = "murage-cloud-home-%d.tar.gz" % sequence
    manifest = json.dumps({"format": "murage-cloud-home-release-v1", "sequence": sequence, "revision": revision, "arch": os.uname().machine,
                           "archive": name, "bytes": len(archive), "sha256": hashlib.sha256(archive).hexdigest()}).encode()
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as handle:
        handle.write(manifest)
    signature = subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", handle.name], check=True, capture_output=True).stdout
    return {"manifest.json": manifest, "manifest.json.sig": signature, name: archive}

def update(root):
    ctx, cp, calls, active = setup(root)
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "unsupported")], "no release channel in this image: unsupported")
    key = os.path.join(root, "release.key")
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", key], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-out", os.path.join(ctx["paths"]["config"], "release-public-key.pem")], check=True)
    with open(os.path.join(ctx["paths"]["config"], "release.json"), "w") as handle:
        json.dump({"channelUrl": "https://releases.murage.test/cloud-home"}, handle)
    opt = ctx["paths"]["opt"]
    os.makedirs(opt + "/dist-server")
    with open(opt + "/dist-server/index.js", "w") as handle:
        handle.write("// old")
    served = {}
    def fetch(url, destination=None, limit=65536):
        prefix = "https://releases.murage.test/cloud-home/" + os.uname().machine + "/"
        assert url.startswith(prefix), url
        body = served[url[len(prefix):]]
        if destination is None:
            return body
        with open(destination, "wb") as out:
            out.write(body)
        return hashlib.sha256(body).hexdigest(), len(body)
    ctx["fetch"] = fetch
    with open(os.path.join(ctx["paths"]["data"], "keep.txt"), "w") as handle:
        handle.write("customer file")
    served.update(make_release(root, "a" * 40, 5, key))
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "done")], "signed release installed")
    with open(opt + "/dist-server/cloud-home-supervisor.js") as handle:
        check(handle.read().endswith("a" * 40), "new code in place")
    check(os.path.isfile(opt + ".prev/dist-server/index.js"), "previous release kept for rollback")
    check(oct(os.stat(opt + "/bin/fuigo").st_mode & 0o7777) == "0o755", "no set-id or world-writable bits from the archive")
    check(open(os.path.join(ctx["paths"]["data"], "keep.txt")).read() == "customer file", "files untouched")
    check(STOP in calls and ["start", "murage-home.service"] in calls, "stopped (home and its slices, confirmed) and started")
    # Same release again: done, nothing swapped.
    calls.clear()
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "done")] and STOP not in calls, "already current")
    # A signed but older sequence: refused.
    served.clear(); served.update(make_release(root, "b" * 40, 4, key))
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "failed")], "downgrade refused")
    # A tampered manifest (signature from another key): refused, code untouched.
    other = os.path.join(root, "other.key")
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", other], check=True, capture_output=True)
    served.clear(); served.update(make_release(root, "c" * 40, 9, other))
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "failed")], "bad signature refused")
    # A path-escaping archive: refused.
    served.clear(); served.update(make_release(root, "d" * 40, 10, key, bad_member=True))
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "failed")], "escaping archive refused")
    check(not os.path.exists(os.path.join(os.path.dirname(opt), "escape")) and not os.path.exists(opt + ".next"), "nothing written outside")
    # A release that does not start: rolled back.
    served.clear(); served.update(make_release(root, "e" * 40, 11, key))
    active["value"] = False
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "failed")], "failed start reported")
    with open(opt + "/dist-server/cloud-home-supervisor.js") as handle:
        check(handle.read().endswith("a" * 40), "rolled back to the running release")
    with open(os.path.join(ctx["paths"]["state"], "release.json")) as handle:
        check(json.load(handle)["sequence"] == 5, "installed sequence unchanged")
    active["value"] = True
    # Astra SELFSERVICE2 #5: the unit is active (Type=simple) but the app never answers its health check: not committed, rolled back.
    served.clear(); served.update(make_release(root, "f" * 40, 12, key))
    active["app"] = False
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "failed")], "premature liveness is not health: failed")
    with open(opt + "/dist-server/cloud-home-supervisor.js") as handle:
        check(handle.read().endswith("a" * 40), "rolled back after the bounded app-health check")
    check(not os.path.exists(m.update_journal_file(ctx)), "journal cleared after the rollback")
    active["app"] = None
    # Astra SELFSERVICE2 #5: interrupted between the two renames (/opt/murage absent, .prev intact): recovered before any command runs.
    served.clear(); served.update(make_release(root, "1" * 40, 13, key))
    real_rename = os.rename
    def failing(a, b):
        if a == opt + ".next":
            raise PowerLoss()
        return real_rename(a, b)
    m.os.rename = failing
    cid = cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    try:
        m.poll_once(ctx)
        check(False, "the power loss stopped the runner")
    except PowerLoss:
        pass
    finally:
        m.os.rename = real_rename
    check(not os.path.exists(opt) and os.path.isdir(opt + ".prev"), "interrupted mid-swap: /opt/murage absent")
    # The machine reboots here: systemd starts the home at boot, but the start inhibition holds it until the runner has recovered.
    active["running"] = set()
    ctx["systemctl"]("start", m.HOME_UNIT)
    check(m.HOME_UNIT not in active["running"], "a boot does not start the home over an interrupted code swap")
    check(m.journal_read(ctx, cid)["state"] == "running", "the command was interrupted while running")
    cp.pending = []
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    ctx["sleep"] = lambda _s: None
    with open(opt + "/dist-server/cloud-home-supervisor.js") as handle:
        check(handle.read().endswith("a" * 40), "previous release back in place at start")
    check(not os.path.exists(opt + ".next") and not os.path.exists(m.update_journal_file(ctx)), "staging and journal cleared")
    check(m.journal_read(ctx, cid)["outcome"] == "failed", "the interrupted update is reported failed")
    # Interrupted after commit, before release.json: finished at start.
    m.update_journal(ctx, {"phase": "committed", "sequence": 14, "revision": "2" * 40})
    check(m.recover_update(ctx) == "done", "a committed update is finished")
    with open(os.path.join(ctx["paths"]["state"], "release.json")) as handle:
        check(json.load(handle) == {"sequence": 14, "revision": "2" * 40}, "release recorded")

def logs(root):
    ctx, cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data)
    messages = [
        "server started on port 8799",
        "machine credential " + CREDENTIAL,
        "env MURAGE_FAKE_API_KEY=" + ENV_SECRET,
        "engine started with key " + SERVER_ENV_SECRET + " ok",
        "claude refreshed " + CLAUDE_TOKEN,
        'codex token {"refresh_token": "' + CODEX_TOKEN + '"}',
        "grok " + GROK_TOKEN + " loaded",
        "read /data/home/engines/codex/.codex/auth.json done",
        "backup password " + BACKUP_PASSWORD,
        "Authorization: Bearer abc.def.ghi",
        "user sean@example.com from 203.0.113.9",
        'prompt="diary pin 4321"',  # Astra SELFSERVICE2 #6: short private text under the approved murage source
    ] + [v["input"] for v in CONTRACT["redactionVectors"]] + ["line %d" % i for i in range(119)]
    foreign = len(messages)
    messages.append("from a unit that is not allow-listed: chat text " + ENV_SECRET)
    journal = "\n".join(json.dumps({"MESSAGE": text, "__REALTIME_TIMESTAMP": str(1_900_000_000_000_000 + i * 1000), "PRIORITY": "3" if i == 1 else "6",
                                    "_SYSTEMD_UNIT": "evil.service" if i == foreign else "murage-home.service" if i % 2 else "murage-backup.service"})
                         for i, text in enumerate(messages)).encode()
    real_run = ctx["run"]
    seen = []
    def run(argv, **kwargs):
        if argv[0] == "journalctl":
            seen.append(argv)
            return 0, journal
        return real_run(argv, **kwargs)
    ctx["run"] = run
    cid = cp.add("collect_logs", {"maxLines": 480, "redact": True, "chatContent": False})
    opened = watch_credential_reads()
    check(m.poll_once(ctx) == [("collect_logs", "done")], "logs collected")
    check(opened == [], "engine sign-in directories are never read to collect logs: %r" % opened[:3])
    check(seen[0][:6] == ["journalctl", "--no-pager", "-o", "json", "-n", "480"] and "-u" in seen[0], "journal of the Murage units, capped")
    posted = cp.of("logs")
    check([p["chunk"] for p in posted] == [0, 1, 2] and [p["final"] for p in posted] == [False, False, True], "chunked, last final")
    check(all(len(p["lines"]) <= 60 and p["commandId"] == cid and p["generation"] == 3 for p in posted), "chunk shape")
    check(cp.of("commands/ack") == [] and cp.pending == [], "the final chunk acknowledges")
    lines = [l for p in posted for l in p["lines"]]
    check(all(set(l) == set(CONTRACT["homeBodies"]["logLine"]) and len(l["message"]) <= 200 for l in lines), "strict line shape (the contract's)")
    check(all(set(p) == set(CONTRACT["homeBodies"]["logs"]) for p in posted), "logs body shape (the contract's)")
    check({l["source"] for l in lines} <= set(CONTRACT["homeBodies"]["logSources"]), "only allow-listed sources")
    check(not any("not allow-listed" in l["message"] for l in lines), "a line from a unit outside the allow-list is dropped")
    check(lines[0]["at"] == 1_900_000_000_000 and lines[1]["at"] == 1_900_000_000_001, "at is epoch milliseconds")
    check(lines[1]["level"] == "error" and lines[1]["source"] == "murage" and lines[0]["source"] == "backup", "level and source mapped")
    blob = json.dumps(posted)
    for secret in ALL_SECRETS + (".codex/auth.json", "sean@example.com", "203.0.113.9", "abc.def.ghi"):
        check(secret not in blob, "redacted from the log bundle: " + secret[:12])
    for vector in CONTRACT["redactionVectors"]:
        for leak in vector["leaks"]:
            check(leak not in blob, "planted fake secret redacted: " + leak[:12])
    for keep in CONTRACT["redactionKeeps"]:
        check(m.redact(keep, []) == keep, "diagnostics kept: " + keep)
    # Only allowed diagnostic events leave the home; everything else is a count. The private line never does, in any form.
    check(list(m.LOG_EVENTS) == CONTRACT["logEvents"], "the runner's allowed events are the contract's")
    for private in ("diary", "4321", "pin", "line 7", "merger", "summarise"):
        check(private not in blob, "free text never uploaded: " + private)
    check(all(any(re.fullmatch(p, l["message"]) for p in CONTRACT["logEvents"]) for l in lines), "every uploaded message is an allowed event")
    check(sum(1 for l in lines if l["message"] == "server started on port 8799") == 1, "an allowed event is kept as is")
    for kept in CONTRACT["logEventsKept"]:
        check(m.allowed_event(kept) == kept.strip(), "allowed event kept: " + kept)
    for private in CONTRACT["logEventsPrivate"]:
        check(m.allowed_event(private) is None, "free text refused: " + private)
    # Consecutive lines of one source and level are counted together.
    j2 = "\n".join(json.dumps({"MESSAGE": "chat %d" % i, "__REALTIME_TIMESTAMP": str(1_900_000_000_000_000 + i), "PRIORITY": "6",
                                "_SYSTEMD_UNIT": "murage-home.service"}) for i in range(5)).encode()
    ctx["run"] = lambda argv, **kw: (0, j2) if argv[0] == "journalctl" else real_run(argv, **kw)
    cp.add("collect_logs", {"maxLines": 480, "redact": True, "chatContent": False})
    m.poll_once(ctx)
    check([l["message"] for l in cp.of("logs")[-1]["lines"]] == ["[5 lines omitted]"], "omitted lines counted")
    results["sampleLines"] = [l["message"] for l in lines[:11]]

def export(root):
    ctx, cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    files = plant(data)
    with open(os.path.join(data, "home/work/leak.txt"), "w") as handle:
        handle.write("pasted " + ENV_SECRET)
    os.symlink("report.md", os.path.join(data, "home/work/link.md"))
    uploaded = {}
    def upload(_ctx, local, remote):
        with open(local, "rb") as handle:
            uploaded[remote] = handle.read()
    ctx["upload"] = upload
    rid = "exp_" + uuid.uuid4().hex
    # Over the home's archive storage budget: failed, nothing uploaded.
    over = cp.add("export_archive", {"requestId": rid, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid,
                                     "maxBytes": 10})
    check(m.poll_once(ctx) == [("export_archive", "failed")] and uploaded == {} and cp.of("export-ready") == [], "over budget: failed, no upload")
    check(cp.of("commands/ack") == [{"generation": 3, "commandId": over, "outcome": "failed"}], "over budget acknowledged failed")
    opened = watch_credential_reads()
    del _opened[:]
    cid = cp.add("export_archive", {"requestId": rid, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid,
                                    "maxBytes": 1 << 30})
    check(m.poll_once(ctx) == [("export_archive", "done")], "export produced")
    check(opened == [], "no engine sign-in file or directory was opened for the export: %r" % opened[:3])
    # Astra SELFSERVICE2 P2: the age identity reaches age-keygen on stdin, never through a file.
    check(not any(os.path.basename(f) == "identity" for f in _opened), "no identity file was written")
    ready = cp.of("export-ready")
    check(len(ready) == 1 and len(cp.of("commands/ack")) == 1 and cp.pending == [], "export-ready acknowledges it")
    body = ready[0]
    check(set(body) == set(CONTRACT["homeBodies"]["export-ready"]), "export-ready shape is the contract's")
    check(body["file"] == "exports/%s/archive.tar.zst.age" % rid and body["commandId"] == cid and body["format"] == "tar.zst.age", "contract path")
    archive = uploaded[body["file"]]
    check(body["bytes"] == len(archive) and body["sha256"] == hashlib.sha256(archive).hexdigest(), "size and digest")
    key = base64.urlsafe_b64decode(body["key"] + "=")
    check(len(body["key"]) == 43 and len(key) == 32, "32-byte key, base64url")
    check(not os.path.exists(os.path.join(data, ".murage-export")), "no local copy or key left behind")
    journal = json.dumps([m.journal_read(ctx, n[:-5]) for n in os.listdir(os.path.join(ctx["paths"]["state"], "commands"))])
    check(body["key"] not in journal, "the key is never stored")
    identity = os.path.join(root, "identity")
    with open(identity, "w") as handle:
        handle.write(m.age_identity(key) + "\n")
    plain = subprocess.run(["age", "-d", "-i", identity], input=archive, check=True, capture_output=True).stdout
    tar_bytes = subprocess.run(["zstd", "-d", "-c"], input=plain, check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
        names = tar.getnames()
        report = tar.extractfile("data/home/work/report.md").read().decode()
        check(tar.getmember("data/home/work/link.md").issym(), "links kept as links")
    check(report == "report v1" and "data/home/memory/notes.txt" in names, "customer files exported")
    for rel in files:
        if any(part in rel for part in (".claude", ".codex", ".grok", ".kimi-code", "secrets/", "Cookies")):
            check("data/" + rel not in names, "credential excluded: " + rel)
    check("data/home/work/leak.txt" not in names, "a file holding a home secret is left out")
    for secret in ALL_SECRETS:
        check(secret.encode() not in tar_bytes, "secret absent from the export: " + secret[:12])
    results["exported"] = sorted(names)
    # Astra SELFSERVICE2 #7: the limit holds while the archive is produced. 24 MiB that does not compress against a 64 KiB limit: production
    # stops early (the tar writer is cut off long before it has fed the whole file), nothing past the limit is written, nothing uploaded.
    with open(os.path.join(data, "home/work/big.bin"), "wb") as handle:
        for _ in range(24):
            handle.write(os.urandom(1 << 20))
    fed = [0]
    real_write_tar = m.write_tar
    def counting(ctx_, stream, *a, **kw):
        class Counter:
            def write(self, b):
                fed[0] += len(b)
                return stream.write(b)
            def __getattr__(self, name):
                return getattr(stream, name)
        return real_write_tar(ctx_, Counter(), *a, **kw)
    m.write_tar = counting
    largest = [0]
    real_open = m.os.open
    try:
        before_uploads = dict(uploaded)
        rid2 = "exp_" + uuid.uuid4().hex
        cp.add("export_archive", {"requestId": rid2, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid2,
                                  "maxBytes": 64 << 10})
        check(m.poll_once(ctx) == [("export_archive", "failed")], "over the limit during production: failed")
        check(fed[0] < 20 << 20, "production stopped early, not after the whole archive: fed %d bytes" % fed[0])
        check(uploaded == before_uploads, "nothing uploaded")
        check(not os.path.exists(os.path.join(data, ".murage-export")), "staging removed")
        # Disk headroom: with only the headroom plus 1000 bytes free, the export is refused before it fills the data disk.
        ctx["disk_free"] = lambda _p: m.EXPORT_HEADROOM_BYTES + 1000
        rid3 = "exp_" + uuid.uuid4().hex
        cp.add("export_archive", {"requestId": rid3, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid3,
                                  "maxBytes": 1 << 30})
        check(m.poll_once(ctx) == [("export_archive", "failed")] and uploaded == before_uploads, "below the disk headroom: failed, no upload")
        ctx["disk_free"] = lambda _p: m.EXPORT_HEADROOM_BYTES - 1
        cp.add("export_archive", {"requestId": rid3, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid3,
                                  "maxBytes": 1 << 30})
        check(m.poll_once(ctx) == [("export_archive", "failed")], "no room at all: refused before production")
    finally:
        m.write_tar = real_write_tar
        ctx["disk_free"] = lambda _p: 1 << 50
    # Abandoned staging (an export interrupted by a crash) is removed at start and when the interrupted command is reported.
    os.makedirs(os.path.join(data, ".murage-export", "old"))
    with open(os.path.join(data, ".murage-export", "old", "archive.tar.zst.age.part"), "w") as handle:
        handle.write("partial")
    cp.pending = []
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    check(not os.path.exists(os.path.join(data, ".murage-export")), "abandoned export staging removed at start")

def reset_roundtrip(root, data=None):
    ctx, cp, calls, _ = setup(root, data)
    data = ctx["paths"]["data"]
    env = backup.restic_env({"repository": os.path.join(root, "repo"), "passwordFile": os.path.join(root, "backup.pass")})
    env["RESTIC_CACHE_DIR"] = os.path.join(root, "cache")
    def real_restic_env(cfg):
        return env
    backup.restic_env = real_restic_env
    subprocess.run(["restic", "init"], env=env, check=True, capture_output=True)
    plant(data, "v1")
    nightly = backup.main(config_path=os.path.join(ctx["paths"]["config"], "backup.json"), excludes=os.path.join(ctx["paths"]["config"], "backup-excludes.txt"),
                          last=os.path.join(root, "backup-last"), source=data, lock=lambda: open(os.path.join(root, "lock"), "a"))
    check(nightly == 0, "nightly backup made")
    snaps = json.loads(subprocess.run(["restic", "snapshots", "--json"], env=env, check=True, capture_output=True).stdout)
    check(len(snaps) == 1, "one nightly")
    # Work since the backup: v2 files, a new file, and a fresh engine sign-in (never in any backup).
    with open(os.path.join(data, "home/work/report.md"), "w") as handle:
        handle.write("report v2")
    with open(os.path.join(data, "home/work/new.md"), "w") as handle:
        handle.write("new since backup")
    with open(os.path.join(data, "home/engines/codex/.codex/auth.json"), "w") as handle:
        handle.write(json.dumps({"tokens": {"refresh_token": CODEX_TOKEN + "v2"}}))
    v2 = tree(data)
    rid = str(uuid.uuid4())
    tag = "murage-pre-reset-" + rid
    ctx["paths"]["run"] = root
    cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": tag, "keepSnapshotDays": 9})
    check(m.poll_once(ctx) == [("reset_from_backup", "done")], "reset done")
    after = tree(data)
    check(after["home/work/report.md"] == "report v1" and "home/work/new.md" not in after, "data rebuilt from the last good backup")
    check(after["home/engines/codex/.codex/auth.json"] == v2["home/engines/codex/.codex/auth.json"], "engine sign-ins kept locally")
    check(calls.index(STOP) < calls.index(["start", "murage-home.service"]), "home and its slices stopped, then started")
    tagged = json.loads(subprocess.run(["restic", "snapshots", "--json", "--tag", tag], env=env, check=True, capture_output=True).stdout)
    check(len(tagged) == 1 and "murage-pre-reset" in tagged[0]["tags"], "pre-reset snapshot kept, tagged")
    with open(m.keep_record(ctx, rid)) as handle:
        check(json.load(handle)["snapshotId"] == tagged[0]["id"], "the exact pre-reset snapshot id is recorded for Undo")
    complete = json.loads(subprocess.run(["restic", "snapshots", "--json", "--tag", "nightly,complete"], env=env, check=True, capture_output=True).stdout)
    check(len(complete) == 1, "the clean nightly is marked complete (the reset source)")
    listing = subprocess.run(["restic", "ls", tagged[0]["id"]], env=env, check=True, capture_output=True).stdout.decode()
    check(".codex" not in listing and ".claude" not in listing and "home/work/new.md" in listing, "pre-reset snapshot holds no sign-ins")
    check(not os.path.exists(os.path.join(data, ".murage-reset", "reset-" + rid)), "staging cleaned")
    # The nightly retention never touches it.
    backup.main(config_path=os.path.join(ctx["paths"]["config"], "backup.json"), excludes=os.path.join(ctx["paths"]["config"], "backup-excludes.txt"),
                last=os.path.join(root, "backup-last"), source=data, lock=lambda: open(os.path.join(root, "lock"), "a"))
    check(len(json.loads(subprocess.run(["restic", "snapshots", "--json", "--tag", tag], env=env, check=True, capture_output=True).stdout)) == 1,
          "nightly forget leaves the pre-reset snapshot")
    # Undo: back to exactly the state before the reset.
    cp.add("undo_reset", {"resetId": rid, "snapshotTag": tag})
    check(m.poll_once(ctx) == [("undo_reset", "done")], "undo done")
    check(tree(data) == v2, "undo restores the pre-reset state, sign-ins included")
    # An undo for a reset this home never ran: failed, nothing touched.
    cp.add("undo_reset", {"resetId": str(uuid.uuid4()), "snapshotTag": "murage-pre-reset-" + "0" * 8 + "-0000-0000-0000-" + "0" * 12})
    payload = cp.pending[-1]["payload"]
    payload["snapshotTag"] = "murage-pre-reset-" + payload["resetId"]
    check(m.poll_once(ctx) == [("undo_reset", "failed")] and tree(data) == v2, "unknown reset refused")
    # Kept 9 days from completion (the 7-day undo window plus room for a late undo); then forgotten.
    with open(os.path.join(ctx["paths"]["state"], "resets", rid + ".json")) as handle:
        check(json.load(handle)["keepUntil"] == NOW + 9 * 86400000, "kept 9 days from the reset's completion")
    ctx["now"] = lambda: NOW + 8 * 86400000
    m.prune_reset_snapshots(ctx)
    check(len(json.loads(subprocess.run(["restic", "snapshots", "--json", "--tag", tag], env=env, check=True, capture_output=True).stdout)) == 1,
          "pre-reset snapshot still kept 8 days after completion (7 full days of undo, never pruned under it)")
    ctx["now"] = lambda: NOW + 9 * 86400000 + 1
    m.prune_reset_snapshots(ctx)
    check(json.loads(subprocess.run(["restic", "snapshots", "--json", "--tag", tag], env=env, check=True, capture_output=True).stdout) == [],
          "pre-reset snapshot forgotten after 9 days")
    results["resetAcks"] = [a["outcome"] for a in cp.of("commands/ack")]

def reset_loop(root):
    image = os.path.join(root, "volume.img")
    mount = os.path.join(root, "mnt")
    os.makedirs(mount)
    with open(image, "wb") as handle:
        handle.truncate(256 << 20)
    subprocess.run(["mkfs.ext4", "-q", "-F", image], check=True)
    device = subprocess.run(["losetup", "--find", "--show", image], check=True, capture_output=True, text=True).stdout.strip()
    try:
        subprocess.run(["mount", "-o", "nodev,nosuid", device, mount], check=True)
        try:
            check(os.path.ismount(mount), "loopback ext4 volume mounted")
            reset_roundtrip(root, mount)
            results["loopDevice"] = device
        finally:
            subprocess.run(["umount", mount], check=False)
    finally:
        subprocess.run(["losetup", "-d", device], check=False)


def contract(root):
    """Every command the control plane sends (shared/self-service-contract.json) is accepted as is; the runner knows exactly those kinds;
    the export key's age identity matches the control plane's encoding and age itself accepts it."""
    check(set(m.SHAPES) == set(CONTRACT["commands"]) == set(m.RUNNERS), "the runner knows exactly the contract's command kinds")
    for kind, payload in CONTRACT["commands"].items():
        envelope = {"id": str(uuid.uuid4()), "kind": kind, "payload": payload, "issuedAt": NOW, "expiresAt": DEADLINE}
        check(set(envelope) == set(CONTRACT["commandEnvelope"]) and m.command_envelope(envelope) is envelope, "envelope accepted: " + kind)
        try:
            m.SHAPES[kind](json.loads(json.dumps(payload)))
        except m.Unsupported:
            check(False, "contract payload refused by the runner: " + kind)
        for field in payload:
            trimmed = {k: v for k, v in payload.items() if k != field}
            try:
                m.SHAPES[kind](trimmed)
                check(False, "a payload missing %s is refused: %s" % (field, kind))
            except m.Unsupported:
                pass
    vector = CONTRACT["ageIdentityVector"]
    key = base64.urlsafe_b64decode(vector["keyB64url"] + "=")
    check(m.age_identity(key) == vector["identity"], "age identity encoding matches the contract vector")
    if shutil.which("age-keygen"):
        identity = os.path.join(root, "id.txt")
        with open(identity, "w") as handle:
            handle.write(vector["identity"] + "\n")
        out = subprocess.run(["age-keygen", "-y", identity], capture_output=True, text=True)
        check(out.returncode == 0 and out.stdout.startswith("age1"), "age-keygen accepts the identity the member is shown")
        results["ageChecked"] = True

def interrupted_swap(ctx, rid, operation, restored_version, fail_at):
    """Starts a swap into /data and cuts power at the fail_at-th rename. Returns the staging dir."""
    data = ctx["paths"]["data"]
    work = m.work_dir(ctx, rid, operation)
    restored = os.path.join(work, "restore", data.lstrip("/"))
    plant(restored, restored_version)
    with open(os.path.join(restored, "backup-only.txt"), "w") as handle:
        handle.write("only in the backup")
    os.makedirs(os.path.join(restored, "zz-backup-only-dir"))
    real_rename, count = os.rename, [0]
    def failing(a, b):
        count[0] += 1
        if count[0] == fail_at:
            raise PowerLoss()
        return real_rename(a, b)
    m.os.rename = failing
    try:
        m.swap_in(ctx, work, restored, rid, operation)
        check(False, "the interrupted swap raised")
    except PowerLoss:
        pass
    finally:
        m.os.rename = real_rename
    return work

def swap_recovery(root):
    """Astra SELFSERVICE2 #3: an interrupted swap is undone exactly (names that exist only in the backup included) or finished; the
    durable swap record outside the staging tree decides, also after the staging tree is gone."""
    ctx, _cp, calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    with open(os.path.join(data, "current-only.txt"), "w") as handle:
        handle.write("made since the backup")
    before = tree(data)
    aside = len([n for n in os.listdir(data) if n not in m.WORK_DIRS])
    # Every restored name is installed except the last one, then power is lost: all of the backup's names are in /data but one.
    rid = str(uuid.uuid4())
    work = interrupted_swap(ctx, rid, "reset", "restored", aside + 3)
    check(m.read_swap(ctx, rid, "reset")["phase"] == "swap", "interrupted mid-swap, the record says so")
    check(os.path.exists(os.path.join(data, "backup-only.txt")), "a backup-only name was already installed")
    check(m.recover_swap(ctx, rid, "reset") == "failed", "rolled back")
    check(tree(data) == before and not os.path.exists(os.path.join(data, "zz-backup-only-dir")), "exactly the previous data, no backup-only names left")
    check(not os.path.exists(work), "staging removed")
    check(["start", "murage-home.service"] in calls, "home started again")
    # At every rename: never a mixed /data after recovery.
    for cut in range(1, aside + 6):
        rid_n = str(uuid.uuid4())
        interrupted_swap(ctx, rid_n, "reset", "restored", cut)
        outcome = m.recover_swap(ctx, rid_n, "reset")
        after = tree(data)
        check((outcome == "failed" and after == before) or (outcome == "done" and after["home/work/report.md"] == "report restored"
              and "current-only.txt" not in after), "cut at rename %d: all old or all new (%s)" % (cut, outcome))
        if outcome == "done":
            break
    # Interrupted after the staging tree was deleted but before the outcome was journaled: the record says committed, so it is done.
    ctx2, cp2, _calls2, _ = setup(os.path.join(root, "second"))
    data2 = ctx2["paths"]["data"]
    plant(data2, "current")
    rid2, cid2 = str(uuid.uuid4()), str(uuid.uuid4())
    work2 = m.work_dir(ctx2, rid2, "undo")
    restored2 = os.path.join(work2, "restore", data2.lstrip("/"))
    plant(restored2, "restored")
    real_rmtree = m.shutil.rmtree
    def crash_after_rmtree(target, *a, **kw):
        real_rmtree(target, *a, **kw)
        if target == work2:
            raise PowerLoss()
    m.shutil.rmtree = crash_after_rmtree
    try:
        m.swap_in(ctx2, work2, restored2, rid2, "undo")
    except PowerLoss:
        pass
    finally:
        m.shutil.rmtree = real_rmtree
    check(not os.path.exists(work2) and m.read_swap(ctx2, rid2, "undo")["phase"] in ("committed", "carried"), "staging gone, record kept")
    m.journal_claim(ctx2, cid2, {"kind": "undo_reset", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE, "resetId": rid2})
    m.recover_interrupted(ctx2)
    check(cp2.of("commands/ack") == [{"generation": 3, "commandId": cid2, "outcome": "done"}], "a completed swap is reported done, not failed")
    check(not os.path.exists(m.swap_record(ctx2, rid2, "undo")), "the record is dropped only once the outcome is journaled")
    check(tree(data2)["home/work/report.md"] == "report restored", "restored data in place")

def unacked_retry(root):
    """Astra SELFSERVICE2 #3: a finished, unacknowledged result is re-sent on its own even though the command is no longer listed."""
    ctx, cp, _calls, _ = setup(root)
    cid = str(uuid.uuid4())
    m.journal_claim(ctx, cid, {"kind": "reset_from_backup", "state": "finished", "outcome": "done", "startedAt": NOW, "acked": False,
                               "deadline": DEADLINE, "resetId": str(uuid.uuid4())})
    cp.fail_ack = 1
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    for _ in range(2):  # the first ack is lost in the network; the next loop sends it again, with nothing listed
        try:
            m.run(ctx, monotonic=lambda: 0)
        except KeyboardInterrupt:
            pass
    check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid] == ["done", "done"], "re-sent until acknowledged")
    check(m.journal_read(ctx, cid)["acked"] is True, "then marked acknowledged")

def reset_safety(root):
    """Astra SELFSERVICE2 #1: a reset never touches data unless every writer is confirmed stopped, the pre-reset backup exits 0 and its exact
    snapshot is verified; the source is a nightly confirmed complete. Undo restores exactly that snapshot id."""
    def attempt(name, **options):
        ctx, cp, calls, active = setup(os.path.join(root, name))
        data = ctx["paths"]["data"]
        plant(data, "current")
        before = tree(data)
        restic_fake = FakeRestic(data, **{k: v for k, v in options.items() if k in ("backup_code", "complete")})
        ctx["run"] = restic_fake
        ctx["paths"]["run"] = os.path.join(root, name)
        active["stuck"] = set(options.get("stuck", ()))
        rid = str(uuid.uuid4())
        cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": "murage-pre-reset-" + rid,
                                     "keepSnapshotDays": 9})
        outcome = m.poll_once(ctx)[0][1]
        return outcome, before == tree(data), restic_fake, ctx, rid, calls
    for name, options in (("stop-fails", {"stuck": ["murage-home.service"]}), ("slice-stuck", {"stuck": ["murage-turns.slice"]}),
                          ("restic-3", {"backup_code": 3}), ("restic-1", {"backup_code": 1}), ("nightly-incomplete", {"complete": False})):
        outcome, unchanged, restic_fake, _ctx, _rid, calls = attempt(name, **options)
        check(outcome == "failed" and unchanged and "restore" not in restic_fake.calls, "%s: failed, nothing restored or changed" % name)
        check(["start", "murage-home.service"] in calls or name == "nightly-incomplete", "%s: home started again" % name)
    outcome, unchanged, restic_fake, ctx, rid, _calls = attempt("ok")
    check(outcome == "done" and not unchanged and "restore" in restic_fake.calls, "a safe reset goes ahead")
    with open(m.keep_record(ctx, rid)) as handle:
        check(json.load(handle)["snapshotId"] == "b" * 64, "the exact verified pre-reset snapshot is recorded")
    # Undo uses exactly that id; a record naming a snapshot the repository does not hold is refused.
    restic_fake.pre_reset[0]["id"] = "c" * 64
    ctx["request"].add("undo_reset", {"resetId": rid, "snapshotTag": "murage-pre-reset-" + rid})
    check(m.poll_once(ctx) == [("undo_reset", "failed")], "undo refuses a snapshot other than the verified one")

def carry(root):
    """Astra SELFSERVICE2 P2: a sign-in under a folder the backup does not have (a project made since) is kept, its parents recreated
    like the originals; nothing is deleted before every sign-in is verified moved."""
    ctx, _cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    os.makedirs(os.path.join(data, "home/projects/new-app/.codex"))
    with open(os.path.join(data, "home/projects/new-app/.codex/auth.json"), "w") as handle:
        handle.write(json.dumps({"tokens": {"refresh_token": CODEX_TOKEN + "new"}}))
    os.chmod(os.path.join(data, "home/projects/new-app"), 0o750)
    rid = str(uuid.uuid4())
    work = m.work_dir(ctx, rid, "reset")
    restored = os.path.join(work, "restore", data.lstrip("/"))
    plant(restored, "restored")
    shutil.rmtree(os.path.join(restored, "home/engines"))  # the restored tree has no engine folders at all
    m.swap_in(ctx, work, restored, rid, "reset")
    after = tree(data)
    check(after["home/projects/new-app/.codex/auth.json"].endswith('new"}}'), "sign-in in a folder the backup lacks is kept")
    check(after["home/engines/codex/.codex/auth.json"] == json.dumps({"tokens": {"refresh_token": CODEX_TOKEN}}), "sign-in under a missing parent kept")
    check(oct(os.stat(os.path.join(data, "home/projects/new-app")).st_mode & 0o777) == "0o750", "parent recreated like the original")
    check(not os.path.exists(work), "previous tree removed only after every sign-in moved")
    # A parent that is a link in the restored data is never followed: the swap is not finished and nothing is deleted.
    rid2 = str(uuid.uuid4())
    work2 = m.work_dir(ctx, rid2, "reset")
    restored2 = os.path.join(work2, "restore", data.lstrip("/"))
    plant(restored2, "restored")
    shutil.rmtree(os.path.join(restored2, "home/engines/codex"))
    os.symlink("/tmp", os.path.join(restored2, "home/engines/codex"))
    try:
        m.swap_in(ctx, work2, restored2, rid2, "reset")
        check(False, "a linked parent is refused")
    except ValueError:
        pass
    check(os.path.exists(os.path.join(work2, "previous")), "the previous tree (with its sign-ins) is kept")

def auth_state(root):
    """Astra SELFSERVICE2 #2: the home's sign-in state (devices, revocations, the pair-hold ledger) is never rolled back by a reset."""
    import sqlite3
    ctx, _cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    schema = ("CREATE TABLE cloud_devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL, publicKey TEXT NOT NULL, "
              "assertionKey TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);"
              "CREATE TABLE cloud_recovery (id TEXT PRIMARY KEY, account TEXT NOT NULL, started INTEGER NOT NULL, state TEXT NOT NULL);"
              "CREATE TABLE cloud_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
              "CREATE TABLE cloud_codes (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);"
              "CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT);")
    def database(path, devices, recovery, message):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        db = sqlite3.connect(path)
        db.executescript(schema + "PRAGMA journal_mode=WAL;")
        db.executemany("INSERT INTO cloud_devices VALUES (?,?,?,?,?,?)", devices)
        db.executemany("INSERT INTO cloud_recovery VALUES (?,?,?,?)", recovery)
        db.execute("INSERT INTO cloud_meta VALUES ('environment', ?)", (message + "-env",))
        db.execute("INSERT INTO messages VALUES ('m1', ?)", (message,))
        db.commit()
        db.close()
    # Now: the stolen device A is revoked, B was added with hold h1 (spent).
    database(os.path.join(data, "home/messages.db"), [("A", "o", "owner-desktop", "ka", "fa", 1), ("B", "o", "owner-desktop", "kb", "fb", 0)],
             [("pair-h1", "o", 1, "device_added")], "current")
    # Outstanding codes: a legacy one (no generation), one from superseded generation 1, one at the current generation 2.
    codes_db = sqlite3.connect(os.path.join(data, "home/messages.db"))
    codes_db.executemany("INSERT INTO cloud_codes VALUES (?,?,?)", [("legacy", "{}", 9), ("g1", '{"homeGeneration":1}', 9), ("g2", '{"homeGeneration":2}', 9)])
    codes_db.commit(); codes_db.close()
    rid = str(uuid.uuid4())
    work = m.work_dir(ctx, rid, "reset")
    os.makedirs(work)
    target = os.path.join(work, "restore")
    restored = os.path.join(target, data.lstrip("/"))
    # The backup: A was not yet revoked, B and the spent hold did not exist.
    plant(restored, "restored")
    database(os.path.join(restored, "home/messages.db"), [("A", "o", "owner-desktop", "ka", "fa", 0)], [], "restored")
    m.carry_auth_state(os.path.join(data, "home/messages.db"), os.path.join(restored, "home/messages.db"), 2)
    m.swap_in(ctx, work, restored, rid, "reset")
    db = sqlite3.connect(os.path.join(data, "home/messages.db"))
    check(db.execute("SELECT id,revoked FROM cloud_devices ORDER BY id").fetchall() == [("A", 1), ("B", 0)], "devices and revocations are current")
    check(db.execute("SELECT id FROM cloud_recovery").fetchall() == [("pair-h1",)], "the spent pair hold stays spent")
    check(db.execute("SELECT body FROM messages").fetchall() == [("restored",)], "everything else is the backup's")
    check(db.execute("SELECT value FROM cloud_meta WHERE key='environment'").fetchall() == [("current-env",)], "same environment id")
    check(db.execute("SELECT hash FROM cloud_codes").fetchall() == [("g2",)], "only codes minted at the current generation survive a reset")
    db.close()
    # Tables that do not match: the reset is refused before anything is swapped.
    bad = os.path.join(root, "bad.db")
    con = sqlite3.connect(bad); con.executescript("CREATE TABLE cloud_devices (id TEXT PRIMARY KEY);"); con.close()
    try:
        m.carry_auth_state(os.path.join(data, "home/messages.db"), bad)
        check(False, "mismatched sign-in tables refused")
    except ValueError:
        pass

def upload(root):
    """Astra SELFSERVICE2 #8: the provisioner's sftp://user@host:23/restic reaches sftp with its port; the older form still works."""
    ctx, _cp, _calls, _ = setup(root)
    seen = []
    def run(argv, **_kwargs):
        seen.append(argv)
        with open(argv[argv.index("-b") + 1]) as handle:
            seen.append(handle.read())
        return 0, b""
    ctx["run"] = run
    config = os.path.join(ctx["paths"]["config"], "backup.json")
    def configure(repository):
        with open(config, "w") as handle:
            json.dump({"repository": repository, "passwordFile": "/x", "sshKey": "/etc/murage-home/backup.key",
                       "knownHosts": "/etc/murage-home/backup.known_hosts"}, handle)
    # Exactly what b5-backup.ts prepareBackup writes.
    configure("sftp://u123456-sub1@u123456.your-storagebox.de:23/restic")
    m.upload_export(ctx, "/data/.murage-export/r/archive.tar.zst.age", "exports/r/archive.tar.zst.age")
    argv = seen[0]
    check(argv[argv.index("-P") + 1] == "23" and argv[-1] == "u123456-sub1@u123456.your-storagebox.de", "port 23 kept, user@host target")
    check("put /data/.murage-export/r/archive.tar.zst.age exports/r/archive.tar.zst.age.part" in seen[1], "batch uploads to the contract path")
    configure("sftp:u1@box.example.test:/restic")
    m.upload_export(ctx, "/a", "exports/r/archive.tar.zst.age")
    check(seen[2][seen[2].index("-P") + 1] == "22" and seen[2][-1] == "u1@box.example.test", "older form: port 22")
    for bad in ("sftp://-oProxyCommand=x@host:23/restic", "sftp://u@host:99999/restic", "sftp://u:pw@host:23/restic", "sftp://u@-host/r",
                "/local/repo", "sftp://u@host:23/restic?x=1"):
        configure(bad)
        try:
            m.upload_export(ctx, "/a", "exports/r/archive.tar.zst.age")
            check(False, "refused: " + bad)
        except ValueError:
            pass

def deadline(root):
    """A command past its run deadline never starts; a reset whose deadline passes before the swap changes no data."""
    ctx, cp, calls, _ = setup(root)
    late = cp.add("restart_service", {"reason": "customer"}, expiresAt=NOW - 1)
    check(m.poll_once(ctx) == [("restart_service", "failed")] and calls == [], "expired command not run, reported failed")
    check(cp.of("commands/ack")[-1] == {"generation": 3, "commandId": late, "outcome": "failed"}, "acknowledged failed")
    data = ctx["paths"]["data"]
    plant(data, "current")
    before = tree(data)
    clock = {"now": NOW}
    ctx["now"] = lambda: clock["now"]
    rid = str(uuid.uuid4())
    ctx["run"] = FakeRestic(data, on_restore=lambda _t: clock.update(now=DEADLINE + 1))  # the restore ran past the run deadline
    ctx["paths"]["run"] = root
    cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": "murage-pre-reset-" + rid,
                                 "keepSnapshotDays": 9})
    check(m.poll_once(ctx) == [("reset_from_backup", "failed")], "reset past its deadline reported failed")
    check(tree(data) == before, "no data swapped after the run deadline")
    check(not os.path.exists(m.work_dir(ctx, rid, "reset")), "staging removed")
    check(["start", "murage-home.service"] in calls, "home started again")

def startup_recovery(root):
    """A reset interrupted mid-swap is rolled back at start, even when the control plane no longer lists it, and reported once."""
    ctx, cp, calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    before = tree(data)
    rid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    interrupted_swap(ctx, rid, "reset", "restored", 3)
    m.journal_claim(ctx, cid, {"kind": "reset_from_backup", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE, "resetId": rid})
    check(tree(data) != before, "data half swapped before recovery")
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    check(tree(data) == before, "rolled back at start without the command being listed")
    check(cp.of("commands/ack") == [{"generation": 3, "commandId": cid, "outcome": "failed"}], "reported failed once")
    check(m.journal_read(ctx, cid)["state"] == "finished", "journal finished")
    check(not os.path.exists(m.swap_record(ctx, rid, "reset")), "swap record dropped with the journaled outcome")


def carry_pending(root):
    """Astra SELFSERVICE3 #2 / SELFSERVICE4 #2: a sign-in carry that fails after the data was swapped in is never reported done (or failed).
    The command stays pending with its swap record and the home's writers stay stopped; conflicting work (restart and safe mode
    included) is refused; recovery runs only under the data lock with writers confirmed stopped, and the home starts once it is carried."""
    ctx, cp, calls, active = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    ctx["run"] = FakeRestic(data)
    ctx["paths"]["run"] = root
    real_carry, broken = m.carry_credentials, {"on": True}
    def carry(*a, **kw):
        if broken["on"]:
            raise OSError("disk error while carrying sign-ins")
        return real_carry(*a, **kw)
    m.carry_credentials = carry
    rid = str(uuid.uuid4())
    cid = cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": "murage-pre-reset-" + rid,
                                       "keepSnapshotDays": 9})
    try:
        check(m.poll_once(ctx) == [("reset_from_backup", "pending")], "a failed carry is pending, not done")
        check(cp.of("commands/ack") == [], "nothing reported")
        check(m.journal_read(ctx, cid)["state"] == "running" and m.read_swap(ctx, rid, "reset")["phase"] == "committed", "journal and record kept")
        check(os.path.isdir(os.path.join(m.work_dir(ctx, rid, "reset"), "previous", "home/engines/codex/.codex")), "the sign-in is still kept aside")
        check(m.HOME_UNIT not in active["running"], "the home's writers stay stopped while the carry is unfinished")
        # Restart and safe mode cannot start the writers under a pending recovery.
        before = len(calls)
        for kind in ("restart_service", "safe_mode"):
            cp.add(kind, {"reason": "customer"})
        outcomes = m.poll_once(ctx)
        check(("restart_service", "failed") in outcomes and ("safe_mode", "failed") in outcomes, "restart/safe mode refused: %r" % outcomes)
        check(not any(c[0] in ("restart", "start") for c in calls[before:]) and m.HOME_UNIT not in active["running"], "nothing started")
        cp.pending = [c for c in cp.pending if c["kind"] == "reset_from_backup"]
        # Another holder of the data lock (a nightly backup): recovery does not touch anything and stays pending.
        import fcntl
        holder = open(os.path.join(ctx["paths"]["run"], "murage-data-ops.lock"), "a")
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
        broken["on"] = False
        try:
            check(m.poll_once(ctx) == [("reset_from_backup", "pending")], "no recovery without the data lock")
            check(os.path.isdir(os.path.join(m.work_dir(ctx, rid, "reset"), "previous", "home/engines/codex/.codex")), "nothing moved without the lock")
        finally:
            holder.close()
        broken["on"] = True
        # Conflicting work is refused while it is unfinished (update would have been "unsupported" here had it run).
        upd = cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
        outcomes = dict(m.poll_once(ctx))
        check(outcomes.get("update_software") == "failed" and outcomes.get("reset_from_backup") == "pending", "data work blocked: %r" % outcomes)
        check([a for a in cp.of("commands/ack") if a["commandId"] == upd][0]["outcome"] == "failed", "the blocked command is answered failed")
        cp.pending = []  # the control plane stops listing the reset (it timed out): the runner still finishes it on its own
        broken["on"] = False
        ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            m.run(ctx, monotonic=lambda: 0)
        except KeyboardInterrupt:
            pass
    finally:
        m.carry_credentials = real_carry
    check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid] == ["done"], "done once the carry completed")
    stops = [i for i, c in enumerate(calls) if c == STOP]
    starts = [i for i, c in enumerate(calls) if c == ["start", "murage-home.service"]]
    check(stops and starts and stops[-1] < starts[-1] and m.HOME_UNIT in active["running"], "writers confirmed stopped, then the home started")
    check(tree(data)["home/engines/codex/.codex/auth.json"] == json.dumps({"tokens": {"refresh_token": CODEX_TOKEN}}), "sign-in in place")
    check(not os.path.exists(m.swap_record(ctx, rid, "reset")) and not m.recovery_pending(ctx), "record dropped, nothing pending")

def carry_blocked(root):
    """Astra SELFSERVICE3 #2 reproduction: the restored backup has a file where a current sign-in's parent folder belongs. Checked before
    anything is swapped: the reset fails with nothing changed (never a swapped home with its sign-in left behind)."""
    ctx, cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    before = tree(data)
    def obstruct(target):
        restored = os.path.join(target, data.lstrip("/"))
        shutil.rmtree(os.path.join(restored, "home/engines/codex"))
        with open(os.path.join(restored, "home/engines/codex"), "w") as handle:
            handle.write("a file in the backup")
    ctx["run"] = FakeRestic(data, on_restore=obstruct)
    ctx["paths"]["run"] = root
    rid = str(uuid.uuid4())
    cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": "murage-pre-reset-" + rid,
                                 "keepSnapshotDays": 9})
    check(m.poll_once(ctx) == [("reset_from_backup", "failed")], "refused")
    check(tree(data) == before and not os.path.exists(m.work_dir(ctx, rid, "reset")), "nothing changed, staging removed")
    check(not os.path.exists(m.swap_record(ctx, rid, "reset")), "no swap began")

def update_once(root):
    """Astra SELFSERVICE3 #3: start-up finishes a committed update, and the interrupted command is then reported done (the same outcome),
    however many times recovery runs."""
    ctx, cp, _calls, _ = setup(root)
    cid = str(uuid.uuid4())
    m.update_journal(ctx, {"phase": "committed", "sequence": 7, "revision": "3" * 40, "commandId": cid})
    m.journal_claim(ctx, cid, {"kind": "update_software", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE})
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    check(cp.of("commands/ack") == [{"generation": 3, "commandId": cid, "outcome": "done"}], "reported done: %r" % cp.of("commands/ack"))
    check(not os.path.exists(m.update_result_file(ctx)), "the result is dropped once the command's journal holds it")
    # Recovering twice gives the same answer; another command's interrupted update is not mistaken for this one.
    m.update_journal(ctx, {"phase": "committed", "sequence": 8, "revision": "4" * 40, "commandId": cid})
    first = m.recover_update(ctx)
    record = {"kind": "update_software", "state": "running"}
    check(first == "done" and m.recover(ctx, record, None, cid) == "done" and m.recover(ctx, record, None, cid) == "done", "idempotent")
    check(m.recover(ctx, record, None, str(uuid.uuid4())) == "failed", "keyed to its own command")

def export_deadline(root):
    """Astra SELFSERVICE3 #5: the run deadline stops production whatever the output (a compressible archive writes almost nothing)."""
    ctx, cp, _calls, _ = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "v1")
    for i in range(64):
        with open(os.path.join(data, "home/work/zeros-%02d.txt" % i), "w") as handle:
            handle.write("0" * (64 << 10))
    uploaded, files = [], [0]
    ctx["upload"] = lambda *_a: uploaded.append(1)
    clock = {"now": NOW}
    ctx["now"] = lambda: clock["now"]
    real_excluded = m.excluded
    def excluded(rel, rules):
        files[0] += 1
        if files[0] == 5:
            clock["now"] = DEADLINE + 1  # the deadline passes while the archive is being produced
        return real_excluded(rel, rules)
    m.excluded = excluded
    try:
        rid = "exp_" + uuid.uuid4().hex
        cp.add("export_archive", {"requestId": rid, "deliverBy": 1, "format": "tar.zst.age", "path": "exports/%s/archive.tar.zst.age" % rid,
                                  "maxBytes": 1 << 30})
        check(m.poll_once(ctx) == [("export_archive", "failed")], "past the deadline during production: failed")
    finally:
        m.excluded = real_excluded
    check(files[0] < 20, "production stopped at the deadline (%d entries looked at of ~80)" % files[0])
    check(uploaded == [] and cp.of("export-ready") == [] and not os.path.exists(os.path.join(data, ".murage-export")), "no upload, staging removed")

def inhibit(root):
    """Astra SELFSERVICE5 #1: no start of the home (the recovery timer, a boot or an explicit start) can pass while a reset's swap or
    sign-in carry is unresolved. The inhibition is set before the writers stop and lifted only after a durable carried/rolled_back."""
    def reset_ctx(name):
        ctx, cp, calls, active = setup(os.path.join(root, name))
        plant(ctx["paths"]["data"], "current")
        ctx["run"] = FakeRestic(ctx["paths"]["data"])
        ctx["paths"]["run"] = os.path.join(root, name)
        rid = str(uuid.uuid4())
        cid = cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True,
                                           "snapshotTag": "murage-pre-reset-" + rid, "keepSnapshotDays": 9})
        return ctx, cp, calls, active, rid, cid
    timer = lambda ctx: ctx["systemctl"]("start", m.HOME_UNIT)  # murage-home-recover.service's ExecStart, every 60 s
    real_carry = m.carry_credentials
    # (a) A start between stop_writers() and the carry (the timer, or anyone) never brings the writers back under the renames.
    ctx, cp, calls, active, rid, cid = reset_ctx("start-after-stop")
    seen = []
    def racing(*a, **kw):
        timer(ctx)
        ctx["systemctl"]("start", m.HOME_UNIT)
        seen.append(m.HOME_UNIT in active["running"] or m.HOME_UNIT in [u for u in active["running"]])
        return real_carry(*a, **kw)
    m.carry_credentials = racing
    try:
        check(m.poll_once(ctx) == [("reset_from_backup", "done")], "reset done")
    finally:
        m.carry_credentials = real_carry
    check(seen == [False], "the writers stayed stopped while sign-ins were carried")
    check(m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)), "started only after carried, inhibition lifted")
    # (b) The timer during a pending (failed) carry: the home stays stopped across many timer runs; it starts once carried.
    ctx, cp, calls, active, rid, cid = reset_ctx("timer")
    broken = {"on": True}
    def failing(*a, **kw):
        if broken["on"]:
            raise OSError("disk error")
        return real_carry(*a, **kw)
    m.carry_credentials = failing
    try:
        check(m.poll_once(ctx) == [("reset_from_backup", "pending")], "pending")
        for _ in range(5):
            timer(ctx)
        check(m.HOME_UNIT not in active["running"] and os.path.exists(m.inhibit_path(ctx)), "the timer cannot start the home")
        broken["on"] = False
        check(m.poll_once(ctx) == [("reset_from_backup", "done")], "carried")
    finally:
        m.carry_credentials = real_carry
    check(m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)), "started once carried")
    # (c) A late reboot (the provider's power cycle) mid-reset: the machine dies during the carry, boots, systemd's start of the home is
    # held, and the runner's start-up recovery finishes the reset correctly and then starts the home.
    ctx, cp, calls, active, rid, cid = reset_ctx("late-reboot")
    def crash(*_a, **_kw):
        raise PowerLoss()
    m.carry_credentials = crash
    try:
        try:
            m.poll_once(ctx)
            check(False, "the power cycle stopped the runner")
        except PowerLoss:
            pass
    finally:
        m.carry_credentials = real_carry
    active["running"] = set()  # the reboot
    timer(ctx); ctx["systemctl"]("start", m.HOME_UNIT)  # boot-time and timer starts
    check(m.HOME_UNIT not in active["running"], "a boot does not start the home over an unfinished reset")
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid] == ["done"], "the reset completes after the late reboot")
    check(tree(ctx["paths"]["data"])["home/work/report.md"] == "report restored", "restored data in place")
    check(tree(ctx["paths"]["data"])["home/engines/codex/.codex/auth.json"] == json.dumps({"tokens": {"refresh_token": CODEX_TOKEN}}), "sign-in kept")
    check(m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)), "the home starts only then")
    # The units carry the condition, on the runner's own path.
    for unit in ("murage-home.service", "murage-home-recover.service"):
        with open(os.path.join(os.path.dirname(program), unit)) as handle:
            check("ConditionPathExists=!" + os.path.join(m.STATE, m.INHIBIT) + "\n" in handle.read(), unit + " honours the inhibition")

class Durability:
    """A crash-persistence model of the runner's state directory. A rename into place (os.replace) or an unlink is a directory entry
    change that a power cut may lose until that directory is fsynced (fsync_dir); a file's own fsync does not make its new name durable.
    Every such change under the state directory is logged until its directory is flushed. cut() is the power cut: it undoes the unflushed
    changes the caller does not keep, freezes what is on disk at that instant and raises PowerLoss; nothing the dead process does after
    it (its finally blocks, its systemctl calls) reaches the disk or systemd. Completed calls are not durable state: only flushed ones are."""
    def __init__(self, ctx, on_systemctl=None):
        self.ctx, self.state, self.pending, self.dead, self.frozen = ctx, os.path.realpath(ctx["paths"]["state"]), [], False, None
        self.real_os, self.real_fsync_dir, self.real_systemctl = m.os, m.fsync_dir, ctx["systemctl"]
        model = self
        class Os:
            def __getattr__(self, name):
                return getattr(model.real_os, name)
            def replace(self, src, dst, *a, **kw):
                model.log("replace", dst)
                return model.real_os.replace(src, dst, *a, **kw)
            def unlink(self, target, *a, **kw):
                model.log("unlink", target)
                return model.real_os.unlink(target, *a, **kw)
        def fsync_dir(directory):
            model.real_fsync_dir(directory)
            flushed = os.path.realpath(directory)
            model.pending = [op for op in model.pending if op["dir"] != flushed]
        def systemctl(*args):
            if model.dead:
                return 0  # the machine is off
            if on_systemctl:
                on_systemctl(model, args)
            return model.real_systemctl(*args)
        m.os, m.fsync_dir, ctx["systemctl"] = Os(), fsync_dir, systemctl
    def log(self, kind, target):
        target = os.path.realpath(target)
        if self.dead or not target.startswith(self.state + os.sep) or os.path.basename(target).startswith(".tmp-"):
            return
        prior = None
        if os.path.isfile(target):
            with open(target, "rb") as handle:
                prior = handle.read()
        self.pending.append({"kind": kind, "target": target, "dir": os.path.dirname(target), "prior": prior})
    def cut(self, keep=lambda _op: False):
        """The power cut: every unflushed change not kept is undone (newest first), the disk is frozen as it is now."""
        self.lost = [op for op in self.pending if not keep(op)]
        for op in reversed(self.lost):
            if op["prior"] is None:
                if os.path.exists(op["target"]):
                    self.real_os.unlink(op["target"])
            else:
                with open(op["target"], "wb") as handle:
                    handle.write(op["prior"])
        self.pending, self.dead = [], True
        self.frozen = self.state + ".at-cut"
        shutil.copytree(self.state, self.frozen, symlinks=True)
        raise PowerLoss()
    def run_until_cut(self, work):
        try:
            work()
            check(False, "the power cut stopped the runner")
        except PowerLoss:
            pass
        finally:
            m.os, m.fsync_dir, self.ctx["systemctl"] = self.real_os, self.real_fsync_dir, self.real_systemctl
        check(self.frozen is not None, "the cut happened")
        shutil.rmtree(self.state)
        os.rename(self.frozen, self.state)  # what the disk holds at boot

def durability(root):
    """Astra SELFSERVICE6 #1: the start inhibition is durable (its directory entry flushed) before any writer is stopped, and every
    terminal record is durable before the inhibition is lifted. Each case cuts power, loses whatever a power cut may lose (changes not
    yet flushed), reboots and checks that no start passed an unresolved transition and that recovery finishes it correctly."""
    def reset_ctx(name):
        ctx, cp, calls, active = setup(os.path.join(root, name))
        plant(ctx["paths"]["data"], "current")
        ctx["run"] = FakeRestic(ctx["paths"]["data"])
        ctx["paths"]["run"] = os.path.join(root, name)
        rid = str(uuid.uuid4())
        cid = cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True,
                                           "snapshotTag": "murage-pre-reset-" + rid, "keepSnapshotDays": 9})
        return ctx, cp, calls, active, rid, cid
    def reboot_and_recover(ctx, cp, active, cid, label):
        active["running"] = set()
        ctx["systemctl"]("start", m.HOME_UNIT); ctx["systemctl"]("start", m.HOME_UNIT)  # boot-time and recovery-timer starts
        check(m.HOME_UNIT not in active["running"] or not m.recovery_pending(ctx), label + ": no start passed an unresolved transition")
        ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            m.run(ctx, monotonic=lambda: 0)
        except KeyboardInterrupt:
            pass
        check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid][-1:] == ["done"], label + ": the reset completes")
        check(tree(ctx["paths"]["data"])["home/work/report.md"] == "report restored", label + ": restored data in place")
        check(tree(ctx["paths"]["data"])["home/engines/codex/.codex/auth.json"] == json.dumps({"tokens": {"refresh_token": CODEX_TOKEN}}),
              label + ": the sign-in is kept")
        check(m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)), label + ": the home starts only then")
    # (a) Power is cut the instant the writers are being stopped: the inhibition published just before must survive the cut, and the
    # boot cannot start the home over the reset that was beginning (recovery then reports it, nothing was swapped).
    ctx, cp, calls, active, rid, cid = reset_ctx("cut-at-stop")
    model = Durability(ctx, lambda model, args: model.cut() if args[0] == "stop" else None)
    model.run_until_cut(lambda: m.poll_once(ctx))
    check(os.path.exists(m.inhibit_path(ctx)), "the inhibition is on disk (directory entry flushed) before any writer is stopped")
    active["running"] = set()
    ctx["systemctl"]("start", m.HOME_UNIT)
    check(m.HOME_UNIT not in active["running"], "the boot after the cut does not start the home under a reset that was stopping it")
    # (b) Power is cut mid-reset (during the sign-in carry, after the swap): every unflushed change is lost. The inhibition and the
    # swap records were flushed, so the boot cannot start the home and recovery finishes the reset.
    ctx, cp, calls, active, rid, cid = reset_ctx("cut-mid-reset")
    model = Durability(ctx)
    real_carry = m.carry_credentials
    m.carry_credentials = lambda *_a, **_kw: model.cut()
    try:
        model.run_until_cut(lambda: m.poll_once(ctx))
    finally:
        m.carry_credentials = real_carry
    check(os.path.exists(m.inhibit_path(ctx)), "the inhibition survived the cut")
    reboot_and_recover(ctx, cp, active, cid, "cut mid-reset")
    # (c) Power is cut right after the inhibition is lifted, before the home starts. The adversarial loss: the unlink of the
    # inhibition survives, every other unflushed change is lost. The terminal records were flushed before the unlink, so whatever
    # survives is consistent: either the inhibition is still there or nothing is unresolved.
    ctx, cp, calls, active, rid, cid = reset_ctx("cut-after-lift")
    inhibit = os.path.realpath(m.inhibit_path(ctx))
    def at_start(model, args):
        if args[0] == "start" and m.HOME_UNIT in args and not os.path.exists(inhibit):
            model.cut(keep=lambda op: op["kind"] == "unlink" and op["target"] == inhibit)
    model = Durability(ctx, at_start)
    model.run_until_cut(lambda: m.poll_once(ctx))
    check(model.lost == [], "nothing the lift depends on was still unflushed: " + json.dumps([op["target"] for op in model.lost]))
    check(os.path.exists(m.inhibit_path(ctx)) or not m.recovery_pending(ctx), "a lifted inhibition never outlives its terminal record")
    reboot_and_recover(ctx, cp, active, cid, "cut after the lift")
    results["durability"] = ["cut-at-stop", "cut-mid-reset", "cut-after-lift"]

SCENARIOS = {"restart": restart, "safe-mode": safe_mode, "refusals": refusals, "interrupted": interrupted, "update": update, "logs": logs,
             "export": export, "swap-recovery": swap_recovery, "reset": reset_roundtrip, "reset-loop": reset_loop,
             "contract": contract, "deadline": deadline, "startup-recovery": startup_recovery, "unacked-retry": unacked_retry,
             "reset-safety": reset_safety, "carry": carry, "auth-state": auth_state, "upload": upload, "carry-pending": carry_pending,
             "carry-blocked": carry_blocked, "update-once": update_once, "export-deadline": export_deadline, "inhibit": inhibit,
             "durability": durability}

with tempfile.TemporaryDirectory(prefix="murage-commands-") as root:
    SCENARIOS[scenario](root)
print(json.dumps({"ok": True, "scenario": scenario, **results}))
