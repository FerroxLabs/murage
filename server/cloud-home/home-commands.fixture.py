# SPDX-License-Identifier: AGPL-3.0-or-later
"""Disposable fixture for deploy/cloud-home/murage-commands: the real module, with the control plane, systemctl and
(where named) the upload and journal boundaries injected. restic, openssl, age, zstd and tar run for real.
Usage: python3 -I home-commands.fixture.py <murage-commands> <murage-backup> <excludes> <scenario>
Prints one JSON line; any failed check exits non-zero with the reason on stderr."""
import base64
import errno
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
        if operation == "update-state":
            return {"recorded": True}
        raise AssertionError(operation)
    def of(self, operation):
        return [r["body"] for r in self.requests if r["operation"] == operation]

launch = load("murage_home_launch_fixture", os.path.join(os.path.dirname(program), "murage-home-launch.py"))
installer = load("murage_install_launchers_fixture", os.path.join(os.path.dirname(program), "install-launchers.py"))
IMAGE_REVISION, IMAGE_SEQUENCE, ABI = "0" * 40, 1, "murage-launchers-1"
LAUNCHERS = ("murage-turn-launch", "murage-browser-namespace", "murage-browser-network")
LAUNCHER_SOURCES = {"murage-turn-launch": "murage-turn-launch.py", "murage-browser-namespace": "murage-browser-namespace.py",
                    "murage-browser-network": "murage-browser-network.py"}
IMMUTABLE_FL, GETFLAGS, SETFLAGS = 0x10, 0x80086601, 0x40086602


class Immutability:
    """FS_IMMUTABLE_FL on files and directories, as the image seals the release slots, the trust root and the update journal and as
    the launcher freezes workspace placeholders. Real when this process may set it (root with CAP_LINUX_IMMUTABLE, on a filesystem with
    inode flags); otherwise emulated at the syscall boundary with the kernel's rules: an immutable directory cannot be renamed or removed,
    and nothing in it can be renamed, removed or added, by anyone; only FS_IOC_SETFLAGS changes the flag."""
    def __init__(self, root):
        import fcntl
        self.fcntl, self.real_ioctl, self.frozen, self.patched = fcntl, fcntl.ioctl, set(), {}
        probe = os.path.join(root, "probe")
        os.mkdir(probe)
        try:
            self._set(probe, True)
            self._set(probe, False)
            self.mode = "real"
        except OSError:
            self.mode = "emulated"
        os.rmdir(probe)
        if self.mode == "emulated":
            self._emulate()
    def _flags(self, fd):
        buf = bytearray(8)
        self.fcntl.ioctl(fd, GETFLAGS, buf)
        return int.from_bytes(buf[:4], sys.byteorder)
    def _open(self, path):
        return os.open(path, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if os.path.isdir(path) else 0))
    def _set(self, path, frozen):
        fd = self._open(path)
        try:
            value = self._flags(fd)
            self.fcntl.ioctl(fd, SETFLAGS, ((value | IMMUTABLE_FL) if frozen else (value & ~IMMUTABLE_FL)).to_bytes(4, sys.byteorder) + bytes(4))
        finally:
            os.close(fd)
    def freeze(self, path):
        self._set(path, True)
    def is_frozen(self, path):
        fd = self._open(path)
        try:
            return bool(self._flags(fd) & IMMUTABLE_FL)
        finally:
            os.close(fd)
    def thaw_all(self, root):
        """Every flag under root (files and directories) cleared, so the fixture's temporary tree can be removed."""
        for current, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                full = os.path.join(current, name)
                if not os.path.islink(full):
                    try:
                        if self.is_frozen(full):
                            self._set(full, False)
                    except OSError:
                        pass
        try:
            if self.is_frozen(root):
                self._set(root, False)
        except OSError:
            pass
    def _emulate(self):
        frozen, real = self.frozen, {n: getattr(os, n) for n in ("rename", "rmdir", "unlink", "remove")}
        key = lambda st: (st.st_dev, st.st_ino)
        def denied(path):
            raise PermissionError(errno.EPERM, "Operation not permitted", path)
        def inode(path, dir_fd=None):
            try:
                return key(os.stat(path, dir_fd=dir_fd, follow_symlinks=False))
            except OSError:
                return None
        def parent(path, dir_fd=None):
            if dir_fd is not None and os.sep not in str(path):
                return key(os.fstat(dir_fd))
            return inode(os.path.dirname(os.path.abspath(path)) if dir_fd is None else os.path.dirname(path), dir_fd)
        def ioctl(fd, request, arg=0, mutate_flag=True):
            if request == GETFLAGS:
                arg[:4] = (IMMUTABLE_FL if key(os.fstat(fd)) in frozen else 0).to_bytes(4, sys.byteorder)
                return 0
            if request == SETFLAGS:
                (frozen.add if int.from_bytes(bytes(arg[:4]), sys.byteorder) & IMMUTABLE_FL else frozen.discard)(key(os.fstat(fd)))
                return 0
            return self.real_ioctl(fd, request, arg, mutate_flag)
        def rename(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
            if {inode(src, src_dir_fd), parent(src, src_dir_fd), parent(dst, dst_dir_fd)} & frozen:
                denied(src)
            return real["rename"](src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        def rmdir(path, *, dir_fd=None):
            if {inode(path, dir_fd), parent(path, dir_fd)} & frozen:
                denied(path)
            return real["rmdir"](path, dir_fd=dir_fd)
        def unlink(path, *, dir_fd=None):
            if {inode(path, dir_fd), parent(path, dir_fd)} & frozen:
                denied(path)
            return real["unlink"](path, dir_fd=dir_fd)
        self.patched = dict(real, ioctl=self.real_ioctl)
        os.rename, os.rmdir, os.unlink, os.remove, self.fcntl.ioctl = rename, rmdir, unlink, unlink, ioctl
    def close(self, root):
        self.thaw_all(root)
        if self.patched:
            os.rename, os.rmdir, os.unlink, os.remove = (self.patched[n] for n in ("rename", "rmdir", "unlink", "remove"))
            self.fcntl.ioctl = self.patched["ioctl"]


_probe_root = tempfile.mkdtemp(prefix="murage-immutable-")
IMMUTABLE = Immutability(_probe_root)
os.rmdir(_probe_root)
results["immutable"] = IMMUTABLE.mode
if os.geteuid() != 0:
    # The seal (every slot inode uid 0) is modeled at the ownership boundary for an unprivileged run, as supervisor.test.ts models root
    # ownership: the files are the test user's. As root (the box, a privileged container) the real rule applies.
    m.SEAL_OWNER = launch.SEAL_OWNER = os.geteuid()


def openssl3(binary):
    try:
        out = subprocess.run([binary, "version"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(re.match(r"OpenSSL [3-9]\.", out or ""))


class Signer:
    """Ed25519 release signatures: real (openssl 3, the image's) when both the PATH's and /usr/bin's openssl have it; otherwise a fixture
    keyed-digest model behind the same verify seam (ctx["verify"]), so scenarios that never sign a release still boot a home."""
    def __init__(self, root):
        self.real = sys.platform == "linux" and openssl3("openssl") and openssl3("/usr/bin/openssl")
        self.key = os.path.join(root, "release.key")
        self.public = os.path.join(root, "release.pub")
        if self.real:
            subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", self.key], check=True, capture_output=True)
            subprocess.run(["openssl", "pkey", "-in", self.key, "-pubout", "-out", self.public], check=True, capture_output=True)
        else:
            self.secret = os.urandom(32)
            with open(self.public, "wb") as handle:
                handle.write(b"FIXTURE-PUBLIC-KEY " + hashlib.sha256(self.secret).hexdigest().encode() + b"\n")
    def sign(self, raw, key=None):
        if self.real:
            with tempfile.NamedTemporaryFile(delete=False) as handle:
                handle.write(raw)
            try:
                return subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", key or self.key, "-rawin", "-in", handle.name], check=True, capture_output=True).stdout
            finally:
                os.unlink(handle.name)
        secret = self.secret if key is None else hashlib.sha256(key.encode()).digest()
        return hashlib.sha256(secret + raw).digest() + hashlib.sha256(raw + secret).digest()
    def verify(self, raw, signature, key_path):
        if self.real:
            return m.verify_signature(raw, signature, key_path)
        with open(key_path, "rb") as handle:
            published = handle.read()
        return published == b"FIXTURE-PUBLIC-KEY " + hashlib.sha256(self.secret).hexdigest().encode() + b"\n" and signature == self.sign(raw)
    def other_key(self, root):
        """A second key the home does not trust."""
        if self.real:
            other = os.path.join(root, "other.key")
            subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", other], check=True, capture_output=True)
            return other
        return "other"


def launcher_members(revision, omit=(), manifest=True, abi=ABI):
    """What build-image.sh's tree carries for Lane G: deploy/cloud-home/launchers.txt and the launcher sources it names."""
    members = {"deploy/cloud-home/" + LAUNCHER_SOURCES[n]: ("LAUNCHER %s %s\n" % (n, revision)).encode() for n in LAUNCHERS if n not in omit}
    if manifest:
        members["deploy/cloud-home/launchers.txt"] = ("abi %s\n" % abi).encode() + "".join("%s %s 0755\n" % (LAUNCHER_SOURCES[n], n) for n in LAUNCHERS).encode()
    return members


def tree_members(revision, extra=None, launchers=None):
    members = {"dist-server/cloud-home-supervisor.js": b"// supervisor " + revision.encode(), "dist-server/index.js": b"// server " + revision.encode(),
               "bin/fuigo": b"#!/bin/true\n"}
    members.update(launcher_members(revision) if launchers is None else launchers)
    members.update(extra or {})
    return members


def write_tree(target, members):
    for name, body in members.items():
        full = os.path.join(target, name)
        os.makedirs(os.path.dirname(full), mode=0o755, exist_ok=True)
        with open(full, "wb") as handle:
            handle.write(body)
        os.chmod(full, 0o755 if name.startswith("bin/") else 0o644)
    for current, dirs, files in os.walk(target):
        os.chmod(current, 0o755)


def tree_digest(target):
    fd = os.open(target, m.SLOT_OPEN)
    try:
        return m.seal_walk_digest(fd, False)
    finally:
        os.close(fd)


def manifest_for(revision, sequence, tree_sha256, archive_name, archive_bytes, archive_sha256, abi=ABI, fmt="murage-cloud-home-release-v3"):
    return json.dumps({"format": fmt, "sequence": sequence, "revision": revision, "arch": os.uname().machine, "archive": archive_name,
                       "bytes": archive_bytes, "sha256": archive_sha256, "treeSha256": tree_sha256, "launcherAbi": abi}).encode()


# The sequence of the release most recently published to the fixture channel: an update command names it, as the control plane does.
LAST_RELEASE = {"sequence": 1}

def make_release(root, revision, sequence, signer, extra=None, bad_member=False, launchers=None, key=None, abi=ABI, fmt="murage-cloud-home-release-v3",
                 tree_sha256=None):
    """What scripts/cloud-home-release.sh publishes: the archive, the v3 manifest (archive digest, tree digest, launcher ABI), the signature."""
    LAST_RELEASE["sequence"] = sequence
    members = tree_members(revision, extra, launchers)
    stage = io.BytesIO()
    with tarfile.open(fileobj=stage, mode="w:gz") as tar:
        for name, body in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(body), 0o4777 if name == "bin/fuigo" else 0o777 if name.startswith("deploy/cloud-home/murage-") else 0o666
            tar.addfile(info, io.BytesIO(body))
        if bad_member:
            info = tarfile.TarInfo("../escape")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
    archive = stage.getvalue()
    if tree_sha256 is None:
        scratch = tempfile.mkdtemp(dir=root)
        shutil.rmtree(scratch)
        with tempfile.NamedTemporaryFile(dir=root, delete=False, suffix=".tar.gz") as handle:
            handle.write(archive)
        try:
            m.safe_extract(handle.name, scratch)
            try:
                installer.apply_modes(scratch, installer.plan(os.path.join(scratch, "deploy", "cloud-home")))  # as the updater does before digesting
            except installer.LauncherError:
                pass  # refused by the updater before any digest
            tree_sha256 = tree_digest(scratch)
        except ValueError:
            tree_sha256 = "0" * 64  # an archive the home refuses before any digest
        finally:
            os.unlink(handle.name)
            shutil.rmtree(scratch, ignore_errors=True)
    name = "murage-cloud-home-%d.tar.gz" % sequence
    manifest = manifest_for(revision, sequence, tree_sha256, name, len(archive), hashlib.sha256(archive).hexdigest(), abi=abi, fmt=fmt)
    return {"manifest.json": manifest, "manifest.json.sig": signer.sign(manifest, key), name: archive}


def install_slot(paths, slot, members, signer, sequence, revision, seal=True):
    """A release tree in a slot as the image build (A) or the updater (B) leaves it: written, digested, its signed manifest stored under
    the journal directory, every inode sealed."""
    target = os.path.join(paths["releases"], slot)
    write_tree(target, members)
    digest = tree_digest(target)
    manifest = manifest_for(revision, sequence, digest, "murage-cloud-home-%d.tar.gz" % sequence, 1, "0" * 64)
    signature = signer.sign(manifest)
    directory = os.path.join(paths["update_state"], "manifests")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    for name, data in ((slot + ".json", manifest), (slot + ".sig", signature)):
        with open(os.path.join(directory, name), "wb") as handle:
            handle.write(data)
        os.chmod(os.path.join(directory, name), 0o600)
    if seal:
        fd = os.open(target, m.SLOT_OPEN)
        try:
            m.seal_tree(fd, True)
        finally:
            os.close(fd)
    return manifest, signature


def write_trust(paths, signer, manifest, signature, sequence=IMAGE_SEQUENCE, abi=ABI, revision=IMAGE_REVISION, freeze=True):
    trust = paths["trust"]
    os.makedirs(os.path.join(trust, "manifests"), mode=0o700, exist_ok=True)
    os.chmod(trust, 0o700)
    shutil.copy(signer.public, os.path.join(trust, "release-public-key.pem"))
    with open(os.path.join(trust, "release.json"), "w") as handle:
        json.dump({"channelUrl": "https://releases.murage.test/cloud-home", "minimumSequence": sequence, "imageRevision": revision, "launcherAbi": abi}, handle)
    with open(os.path.join(trust, "launcher-abi"), "w") as handle:
        handle.write(abi + "\n")
    for name, data in (("manifests/A.json", manifest), ("manifests/A.sig", signature)):
        with open(os.path.join(trust, name), "wb") as handle:
            handle.write(data)
    for current, dirs, files in os.walk(trust):
        for name in files:
            os.chmod(os.path.join(current, name), 0o600)
    if freeze:
        for current, dirs, files in os.walk(trust, topdown=False):
            for name in files + dirs:
                IMMUTABLE.freeze(os.path.join(current, name))
        IMMUTABLE.freeze(trust)


def write_state(ctx, installed=None, inflight=None, last=None, sequence=IMAGE_SEQUENCE, revision=IMAGE_REVISION, slot="A"):
    state = {"format": m.UPDATE_STATE_FORMAT, "installed": installed or {"slot": slot, "sequence": sequence, "revision": revision},
             "inflight": inflight, "lastResult": last}
    m.write_update_state(ctx, state)
    return state


def inflight_record(slot="B", phase="verify", sequence=2, revision="b" * 40, cid=None, verify_attempts=0, rollback_attempts=0, restored=False, reason=None):
    return {"commandId": cid or str(uuid.uuid4()), "slot": slot, "sequence": sequence, "revision": revision, "phase": phase,
            "verifyAttempts": verify_attempts, "rollbackAttempts": rollback_attempts, "restored": restored, "startedAt": NOW, "deadline": DEADLINE,
            "driveId": "0" * 32, "reason": reason}


def image(ctx, paths, signer):
    """What build-image.sh leaves behind (LANE-G r3 sec. 2): slot A sealed, current -> A, the trust root, slot A's signed manifest in
    both places, state.json v3 naming A."""
    os.makedirs(paths["releases"], mode=0o755, exist_ok=True)
    manifest, signature = install_slot(paths, "A", tree_members(IMAGE_REVISION), signer, IMAGE_SEQUENCE, IMAGE_REVISION)
    os.symlink("A", os.path.join(paths["releases"], "current"))
    write_trust(paths, signer, manifest, signature)
    write_state(ctx)
    IMMUTABLE.freeze(paths["releases"])
    for name in ("manifests/A.json", "manifests/A.sig", "manifests"):
        IMMUTABLE.freeze(os.path.join(paths["update_state"], name))


def launcher_paths(paths):
    return {"releases": paths["releases"], "trust": paths["trust"], "update_state": paths["update_state"],
            "inhibit": os.path.join(paths["state"], "recovery-inhibit"), "gate": os.path.join(paths["gate"], "gate.sock")}


def setup(root, data=None):
    binding = {"homeId": "home-test", "generation": 3, "adminUrl": "https://admin.murage.test", "publicOrigin": "https://home.murage.test",
               "credential": CREDENTIAL}
    paths = {"data": data or os.path.join(root, "data"), "state": os.path.join(root, "state"), "config": os.path.join(root, "config"),
             "run": os.path.join(root, "run"), "libexec": os.path.join(root, "libexec"), "releases": os.path.join(root, "opt", "murage-releases"),
             "update_state": os.path.join(root, "var", "murage-update"), "trust": os.path.join(root, "trust"), "gate": os.path.join(root, "run", "murage-update")}
    for p in paths.values():
        os.makedirs(p, exist_ok=True)
    # The image's own launcher list step (build-image.sh puts it in libexec); the update imports it from there.
    shutil.copy(os.path.join(os.path.dirname(program), "install-launchers.py"), os.path.join(paths["libexec"], "murage-install-launchers"))
    os.chmod(os.path.join(paths["libexec"], "murage-install-launchers"), 0o755)
    for name in LAUNCHERS:
        with open(os.path.join(paths["libexec"], name), "w") as handle:
            handle.write("IMAGE %s\n" % name)
        os.chmod(os.path.join(paths["libexec"], name), 0o755)
    shutil.copy(excludes_file, os.path.join(paths["config"], "backup-excludes.txt"))
    with open(os.path.join(root, "backup.pass"), "w") as handle:
        handle.write(BACKUP_PASSWORD + "\n")
    with open(os.path.join(paths["config"], "backup.json"), "w") as handle:
        json.dump({"repository": os.path.join(root, "repo"), "passwordFile": os.path.join(root, "backup.pass")}, handle)
    ctx = m.default_context(binding, backup)
    cp = CP(binding)
    calls = []
    signer = Signer(root)
    # active: the home comes up (and its app answers) when started; app: the app answers (None: same as active); stuck: units that
    # never stop; running: what systemd has active now; launches: every ExecStart of the home unit, as murage-home-launch answered it
    # (exit code, refusal reason, the slot it started); peers: what the gate and its client see of each other (SO_PEERCRED + cgroup).
    # bad_slot: a release whose process dies at once when started; unhealthy_slot: one whose unit stays up but whose app never answers;
    # slot: the slot the last successful start ran.
    active = {"value": True, "app": None, "stuck": set(), "running": {m.HOME_UNIT}, "launches": [], "probes": 0, "signer": signer,
              "bad_slot": None, "unhealthy_slot": None, "slot": "A",
              "server_peer": {"uid": 0, "cgroup": m.HOME_CGROUP, "exe": "/usr/bin/python3"}, "client_peer": {"uid": 0, "cgroup": launch.COMMANDS_CGROUP}}
    lpaths = launcher_paths(paths)
    def launcher():
        """murage-home.service's ExecStart under systemd: the real murage-home-launch start gate against this fixture's paths."""
        try:
            slot, dirfd, _state = launch.start_gate(lpaths, verify=signer.verify, peer=lambda pid, uid: dict(active["client_peer"]), ancestors=False)
            os.close(dirfd)
            return 0, None, slot
        except launch.Refused as refused:
            return 79, refused.reason, None
    def systemctl(*args):
        calls.append(list(args))
        units = [a for a in args[1:] if not a.startswith("-")]
        if args[0] == "is-active":
            return 0 if units[0] in active["running"] else 3
        if args[0] == "stop":
            active["running"] -= set(units) - active["stuck"]
            return 0 if not set(units) & active["stuck"] else 1
        if args[0] in ("start", "restart"):
            if m.HOME_UNIT in units and args[0] == "start" and m.HOME_UNIT in active["running"]:
                units = [u for u in units if u != m.HOME_UNIT]  # already active: systemd runs no ExecStart
            if m.HOME_UNIT in units:
                if args[0] == "restart":
                    active["running"].discard(m.HOME_UNIT)
                code, reason, slot = launcher()
                active["launches"].append((code, reason, slot))
                if code != 0:
                    units = [u for u in units if u != m.HOME_UNIT]  # exit 79: RestartPreventExitStatus, the unit stays stopped
                else:
                    active["slot"] = slot
            if active["value"]:
                active["running"] |= set(units)
            else:
                active["running"] -= set(units)  # it starts and dies at once
            if m.HOME_UNIT in units and active["bad_slot"] == active["slot"]:
                active["running"].discard(m.HOME_UNIT)  # this release's process dies at once
            return 0
        return 0
    def unit_state(unit):
        return "active" if unit in active["running"] else "inactive"
    def app_healthy():
        active["probes"] += 1
        up = m.HOME_UNIT in active["running"]
        return up and active["unhealthy_slot"] != active["slot"] and (active["value"] if active["app"] is None else active["app"])
    ctx.update(request=cp, systemctl=systemctl, sleep=lambda _s: None, now=lambda: NOW, paths=paths, unit_state=unit_state,
               app_healthy=app_healthy, disk_free=lambda _p: 1 << 50, verify=signer.verify, peer=lambda pid, uid: dict(active["server_peer"]),
               environs=lambda _ctx: [dict(os.environ), {"PATH": "/usr/bin", "ANTHROPIC_API_KEY": SERVER_ENV_SECRET}])
    image(ctx, paths, signer)
    m.gate_server(ctx)
    return ctx, cp, calls, active

STOP = ["stop", "murage-home.service", "murage-turns.slice", "murage-browsers.slice"]
START = ["start", "murage-home.service"]

def launches(active, code=None):
    return [l for l in active["launches"] if code is None or l[0] == code]

def served(ctx, root, releases):
    """The release channel: one dict of served files behind ctx["fetch"]."""
    files = {}
    def fetch(url, destination=None, limit=65536):
        prefix = "https://releases.murage.test/cloud-home/" + os.uname().machine + "/"
        assert url.startswith(prefix), url
        name = url[len(prefix):]
        if name not in files:
            raise OSError(errno.ENOENT, "not served", name)
        body = files[name]
        if destination is None:
            return body
        with open(destination, "wb") as out:
            out.write(body)
        return hashlib.sha256(body).hexdigest(), len(body)
    ctx["fetch"] = fetch
    return files

def update_command(cp, **extra):
    return cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer", "sequence": LAST_RELEASE["sequence"], **extra})

def slot_file(ctx, slot, rel="dist-server/cloud-home-supervisor.js"):
    with open(os.path.join(ctx["paths"]["releases"], slot, rel)) as handle:
        return handle.read()

def slot_sealed(ctx, slot):
    """Every regular file and directory of the slot carries FS_IMMUTABLE_FL."""
    target = os.path.join(ctx["paths"]["releases"], slot)
    for current, dirs, files in os.walk(target):
        for name in [""] + dirs + files:
            if not IMMUTABLE.is_frozen(os.path.join(current, name) if name else current):
                return False
    return True
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
        # The launcher's versioned sign-in stores (murage-turn-launch.py ENGINE_ROOT/<engine>/signin and .../bots/<bot>/signin).
        "engine-homes/claudeAgent/signin/current": "4",
        "engine-homes/claudeAgent/signin/4/token": CLAUDE_TOKEN + "-signin",
        "engine-homes/claudeAgent/signin/4/record.json": '{"mode":"oauth-token"}',
        "engine-homes/codex/signin/2/key": CODEX_TOKEN + "-key",
        "engine-homes/codex/bots/bot_1/signin/1/.codex/auth.json": json.dumps({"tokens": {"refresh_token": CODEX_TOKEN + "-bot"}}),
        "engine-homes/codex/bots/bot_1/state/notes.json": '{"kept":"' + version + '"}',
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
    check(m.poll_once(ctx) == [("restart_service", "done")], "restart ran: %r" % calls)
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

class Trace:
    """The order of what the design pins: journal writes (with the inhibit's presence at that instant), health verdicts, every rename
    of the `current` link, the launcher's answers and systemctl calls, in one log. Restored by close()."""
    def __init__(self, ctx, calls):
        self.ctx, self.calls, self.log = ctx, calls, []
        self.real = {"write": m.write_update_state, "wait": m.wait_healthy, "rename": os.rename, "start_home": m.start_home}
        trace = self
        def write(ctx_, state):
            trace.real["write"](ctx_, state)
            inflight = state["inflight"]
            trace.log.append(("write", state["installed"]["slot"], inflight["phase"] if inflight else None, inflight["restored"] if inflight else None,
                              os.path.exists(m.inhibit_path(ctx_))))
        def wait(ctx_, *a, **kw):
            verdict = trace.real["wait"](ctx_, *a, **kw)
            trace.log.append(("healthy", verdict))
            return verdict
        def rename(src, dst, *a, **kw):
            if os.path.basename(dst) == "current":
                trace.log.append(("rename", os.readlink(src)))
            return trace.real["rename"](src, dst, *a, **kw)
        def start_home(ctx_):
            trace.log.append(("lift", os.path.exists(m.inhibit_path(ctx_))))
            return trace.real["start_home"](ctx_)
        self.real["systemctl"] = ctx["systemctl"]
        def systemctl(*args):
            trace.log.append(("systemctl",) + tuple(args[:2]))
            return trace.real["systemctl"](*args)
        m.write_update_state, m.wait_healthy, os.rename, m.start_home = write, wait, rename, start_home
        ctx["systemctl"] = systemctl
    def close(self):
        m.write_update_state, m.wait_healthy, os.rename, m.start_home = self.real["write"], self.real["wait"], self.real["rename"], self.real["start_home"]
        self.ctx["systemctl"] = self.real["systemctl"]
    def events(self, *kinds):
        return [e for e in self.log if e[0] in kinds]


def thaw(path):
    if IMMUTABLE.is_frozen(path):
        IMMUTABLE._set(path, False)


def raw_state(ctx, data):
    """state.json replaced by hand (an operator or a forged write), flags lifted and set again around it."""
    target = m.update_state_file(ctx)
    directory = os.path.dirname(target)
    thaw(directory)
    if os.path.exists(target):
        thaw(target)
    if data is None:
        os.unlink(target)
    else:
        with open(target, "wb") as handle:
            handle.write(data)
        IMMUTABLE.freeze(target)
    IMMUTABLE.freeze(directory)


def set_current(ctx, target):
    releases = ctx["paths"]["releases"]
    thaw(releases)
    current = os.path.join(releases, "current")
    if os.path.lexists(current):
        os.unlink(current)
    if target is not None:
        os.symlink(target, current)
    IMMUTABLE.freeze(releases)


def stage_candidate(ctx, active, revision="b" * 40, sequence=2, slot="B"):
    """A candidate the updater has installed and sealed in the idle slot with its signed manifest (the end of `installing`)."""
    paths = ctx["paths"]
    thaw(paths["releases"])
    thaw(os.path.join(paths["update_state"], "manifests"))
    thaw(paths["update_state"])
    manifest, signature = install_slot(paths, slot, tree_members(revision), active["signer"], sequence, revision)
    IMMUTABLE.freeze(os.path.join(paths["update_state"], "manifests"))
    IMMUTABLE.freeze(paths["update_state"])
    IMMUTABLE.freeze(paths["releases"])
    return manifest, signature


def stderr_of(work):
    held, sys.stderr = sys.stderr, io.StringIO()
    try:
        return work(), sys.stderr.getvalue()
    finally:
        sys.stderr = held


def update(root):
    """r2/r3/A1 happy path and the idle refusals: two slots, one flip, the previous slot kept, the journal the only truth, the inhibit
    held to the commit (T-G3), every inode sealed (T-D2), the libexec launchers untouched (image-pinned), a failed candidate rolled back
    to signed bytes, a release with another launcher ABI refused before any download (T-L2')."""
    ctx, cp, calls, active = setup(root)
    signer, paths = active["signer"], ctx["paths"]
    releases, libexec, data = paths["releases"], paths["libexec"], paths["data"]
    channel = served(ctx, root, releases)
    inodes = {n: os.lstat(os.path.join(libexec, n)).st_ino for n in LAUNCHERS}
    with open(os.path.join(data, "keep.txt"), "w") as handle:
        handle.write("customer file")
    digest_a = tree_digest(os.path.join(releases, "A"))
    channel.update(make_release(root, "b" * 40, 2, signer))
    cid = update_command(cp)
    trace = Trace(ctx, calls)
    try:
        check(m.poll_once(ctx) == [("update_software", "done")], "signed release installed into the idle slot and committed")
    finally:
        trace.close()
    state = m.read_update_state(ctx)
    check(state["installed"] == {"slot": "B", "sequence": 2, "revision": "b" * 40} and state["inflight"] is None
          and state["lastResult"] == {"commandId": cid, "outcome": "done", "reason": None}, "journal: installed B, nothing in flight, done recorded: %r" % state)
    check(m.current_target(ctx) == "B" and slot_file(ctx, "B").endswith("b" * 40), "current -> B, the new code in place")
    check(tree_digest(os.path.join(releases, "A")) == digest_a and IMMUTABLE.is_frozen(os.path.join(releases, "A")), "the previous slot is kept byte for byte and sealed (no cleanup after commit)")
    check(slot_sealed(ctx, "B") and IMMUTABLE.is_frozen(releases), "every inode of the new slot and the releases directory carry +i (T-D2)")
    check(oct(os.stat(os.path.join(releases, "B", "bin", "fuigo")).st_mode & 0o7777) == "0o755", "no set-id or world-writable bits from the archive")
    check(open(os.path.join(data, "keep.txt")).read() == "customer file", "files untouched")
    check(STOP in calls and START in calls and calls.index(STOP) < calls.index(START), "stopped (home and slices, confirmed) then started")
    check(launches(active, 0)[-1][2] == "B" and m.HOME_UNIT in active["running"] and active["slot"] == "B", "the verify start ran slot B through a grant; the home is up on it")
    check(not os.path.exists(m.inhibit_path(ctx)) and ctx["gate"]["grant"] is None, "inhibit lifted after the commit; the grant was consumed")
    check({n: os.lstat(os.path.join(libexec, n)).st_ino for n in LAUNCHERS} == inodes and all(open(os.path.join(libexec, n)).read() == "IMAGE %s\n" % n for n in LAUNCHERS)
          and not [f for f in os.listdir(libexec) if f.startswith(".")], "libexec untouched: the launchers are image-pinned (same inodes and bytes, no strays)")
    # T-G3: the inhibit exists at every journal write from `installed` on, through the healthy verdict, up to the commit write; it is lifted only after.
    writes = trace.events("write")
    phases = [w[2] for w in writes]
    check(phases == ["installing", "installed", "flip", "verify", "verify", None], "one write per phase (verify: the flip's verify/0, then the counter 1), then the commit: %r" % phases)
    check(not writes[1][4] and all(w[4] for w in writes[2:]), "the inhibit is set by stop_writers after the `installed` write and present at every write from `flip` to the commit: %r" % writes)
    order = [e[0] for e in trace.log if e[0] in ("healthy", "lift")] + [e[0] + ":" + str(e[2]) for e in trace.log if e[0] == "write" and e[2] is None]
    check(trace.log.index(("healthy", True)) < [i for i, e in enumerate(trace.log) if e[0] == "write" and e[2] is None][0] < trace.log.index(("lift", True)),
          "healthy observed, then the commit written (installed := new), then the inhibit lifted: %r" % trace.log)
    check(writes[-1][1] == "B", "the commit names the new slot")
    # Same release again: done, nothing stopped.
    calls.clear()
    update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "done")] and STOP not in calls, "already current: done without a stop")
    # A second update (T-H2c, T-D2): the idle slot (A, the previous release) is wiped only now, its flags lifted, then replaced.
    channel.clear(); channel.update(make_release(root, "c" * 40, 3, signer))
    update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "done")], "second update done")
    check(m.read_update_state(ctx)["installed"]["slot"] == "A" and slot_file(ctx, "A").endswith("c" * 40) and slot_sealed(ctx, "A"), "the previous slot was wiped and now holds release c, sealed")
    check(m.current_target(ctx) == "A" and slot_file(ctx, "B").endswith("b" * 40), "current -> A; the release before it stays in B")
    def refused(why, journal_unchanged=True, sequence=20, **release):
        before = m.read_update_state(ctx)
        channel.clear(); channel.update(make_release(root, "9" * 40, sequence, signer, **release))
        calls.clear(); active["launches"].clear()
        update_command(cp)
        check(m.poll_once(ctx) == [("update_software", "failed")], why + ": refused")
        check(not any(c[0] == "stop" for c in calls) and active["launches"] == [], why + ": the home was never stopped or restarted")
        check(m.current_target(ctx) == "A" and slot_file(ctx, "A").endswith("c" * 40), why + ": the live slot untouched")
        after = m.read_update_state(ctx)
        check(after["installed"] == before["installed"] and after["inflight"] is None, why + ": nothing installed, nothing in flight")
        check(not os.path.exists(os.path.join(releases, "B")) or journal_unchanged is False or slot_file(ctx, "B").endswith("b" * 40), why + ": the idle slot is as it was or wiped, never half-installed")
        check(not os.path.exists(os.path.join(paths["update_state"], "download.tar.gz")), why + ": no download left")
        return after
    # Signed but at or below the floor (installed sequence 3): refused.
    refused("downgrade (sequence 2 <= floor 3)", sequence=2)
    channel.clear(); channel.update(make_release(root, "8" * 40, 3, signer))
    calls.clear(); update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "done")] and STOP not in calls and m.read_update_state(ctx)["installed"]["sequence"] == 3,
          "same sequence as installed: nothing to install, nothing restarted")
    # A manifest signed by another key: refused.
    channel.clear(); channel.update(make_release(root, "d" * 40, 9, signer, key=signer.other_key(root)))
    calls.clear(); update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "failed")] and STOP not in calls, "bad signature refused")
    # A manifest of the previous format (v1/v2): refused with the fixed reason, before any download.
    fetched = []
    real_fetch = ctx["fetch"]
    ctx["fetch"] = lambda url, *a, **kw: (fetched.append(url.rsplit("/", 1)[1]), real_fetch(url, *a, **kw))[1]
    channel.clear(); channel.update(make_release(root, "e" * 40, 9, signer, fmt="murage-cloud-home-release-v2"))
    calls.clear(); update_command(cp)
    _, err = stderr_of(lambda: m.poll_once(ctx))
    check("Self-service update refused: release_format" in err and STOP not in calls and fetched == ["manifest.json", "manifest.json.sig"], "a v2 manifest is refused with its fixed reason, nothing downloaded: %r %r" % (err, fetched))
    # Another launcher ABI: refused at idle with launcher_abi_mismatch, no download (T-L2').
    fetched.clear()
    channel.clear(); channel.update(make_release(root, "e" * 40, 9, signer, abi="murage-launchers-2"))
    update_command(cp)
    _, err = stderr_of(lambda: m.poll_once(ctx))
    check("Self-service update refused: launcher_abi_mismatch" in err and fetched == ["manifest.json", "manifest.json.sig"], "launcher ABI mismatch: refused before the archive is fetched: %r" % err)
    ctx["fetch"] = real_fetch
    # A path-escaping archive: refused, nothing written outside, the idle slot wiped.
    after = refused("escaping archive", bad_member=True)
    check(not os.path.exists(os.path.join(os.path.dirname(releases), "escape")) and not os.path.exists(os.path.join(releases, "B")), "nothing written outside the slot; the half-extracted slot wiped")
    check(after["lastResult"]["outcome"] == "failed" and after["lastResult"]["reason"] in ("install_failed", "release_incomplete"), "the journal records the failed install: %r" % after["lastResult"])
    # A tree whose digest is not the signed treeSha256: refused after extraction, wiped.
    after = refused("tree digest mismatch", tree_sha256="f" * 64)
    check(after["lastResult"]["reason"] == "tree_digest", "fixed reason tree_digest: %r" % after["lastResult"])
    # Lane G: a release that cannot carry its launcher list is refused; the idle slot is wiped, the live slot untouched.
    refused("missing launcher", launchers=launcher_members("9" * 40, omit=("murage-browser-network",)))
    refused("missing launcher manifest", launchers=launcher_members("9" * 40, manifest=False))
    bad = launcher_members("9" * 40); bad["deploy/cloud-home/launchers.txt"] = b"abi murage-launchers-1\n../../etc/passwd murage-turn-launch 4755\n"
    refused("invalid launcher manifest", launchers=bad)
    short = launcher_members("9" * 40); short["deploy/cloud-home/launchers.txt"] = b"abi murage-launchers-1\nmurage-turn-launch.py murage-turn-launch 0755\n"
    refused("manifest below the required floor", launchers=short)
    extra = launcher_members("9" * 40); extra["deploy/cloud-home/launchers.txt"] += b"murage-turn-launch.py murage-install-launchers 0755\n"
    refused("a launcher name outside the allowlist", launchers=extra)
    installer = os.path.join(libexec, "murage-install-launchers")
    os.rename(installer, installer + ".hold")
    try:
        refused("no launcher installer on the image")
    finally:
        os.rename(installer + ".hold", installer)
    check({n: os.lstat(os.path.join(libexec, n)).st_ino for n in LAUNCHERS} == inodes, "libexec still untouched after every refusal")
    # A release that does not start: counted verify start, rollback to the signed previous slot, counted start of it, failed/unhealthy.
    channel.clear(); channel.update(make_release(root, "f" * 40, 11, signer))
    active["bad_slot"] = "B"
    calls.clear(); active["launches"].clear()
    trace = Trace(ctx, calls)
    try:
        cid = update_command(cp)
        check(m.poll_once(ctx) == [("update_software", "failed")], "failed start reported")
    finally:
        trace.close()
    state = m.read_update_state(ctx)
    check(state["installed"]["slot"] == "A" and state["installed"]["sequence"] == 3 and state["inflight"] is None
          and state["lastResult"] == {"commandId": cid, "outcome": "failed", "reason": "unhealthy"}, "rolled back: installed unchanged, failed/unhealthy recorded: %r" % state)
    check(m.current_target(ctx) == "A" and active["slot"] == "A" and m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)), "current back on A, the home up on A, inhibit lifted")
    check([l[2] for l in launches(active, 0)] == ["B", "A"], "exactly one counted start of the candidate and one of the restored slot: %r" % active["launches"])
    renames = [e for e in trace.log if e[0] == "rename"]
    stops = [i for i, e in enumerate(trace.log) if e[0] == "write" and e[2] == "rollback"]
    check([r[1] for r in renames] == ["B", "A"], "the link moved to B and back to A: %r" % renames)
    check(trace.log.index(("rename", "A")) > stops[0], "the flip back happens only after phase := rollback was written")
    check(slot_file(ctx, "B").endswith("f" * 40) and slot_sealed(ctx, "B"), "the failed candidate stays in its slot (wiped by the next install), sealed")
    active["bad_slot"] = None
    # The unit is active but the app never answers: not committed, rolled back.
    channel.clear(); channel.update(make_release(root, "1" * 40, 12, signer))
    active["unhealthy_slot"] = "B"
    update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "failed")], "premature liveness is not health: failed")
    check(m.read_update_state(ctx)["installed"]["slot"] == "A" and m.current_target(ctx) == "A" and active["slot"] == "A", "rolled back after the bounded app-health check")
    active["unhealthy_slot"] = None
    results["update"] = {"launches": active["launches"][-4:]}


def update_cuts(root):
    """T-I5 / T-H2b / T-S2: power lost at each step of the machine. The installed slot's bytes never change until a later install; the boot
    after the cut runs no unverified slot code without a grant; start-up re-drives the same state machine to done or failed."""
    expected = {"installing": ("failed", "A", "install_interrupted", 0), "installed": ("done", "B", None, 79), "flip": ("done", "B", None, 79),
                "verify": ("done", "B", None, 79), "granted": ("done", "B", None, 79)}
    for cut, (outcome, slot, reason, boot_code) in expected.items():
        ctx, cp, calls, active = setup(os.path.join(root, cut))
        paths = ctx["paths"]
        channel = served(ctx, root, paths["releases"])
        channel.update(make_release(root, "b" * 40, 2, active["signer"]))
        digest_a = tree_digest(os.path.join(paths["releases"], "A"))
        real_write, real_wait = m.write_update_state, m.wait_healthy
        def cutting_write(ctx_, state):
            real_write(ctx_, state)
            if state["inflight"] and state["inflight"]["phase"] == cut:
                raise PowerLoss()
        def cutting_wait(ctx_, *a, **kw):
            raise PowerLoss()
        if cut == "granted":
            m.wait_healthy = cutting_wait
        else:
            m.write_update_state = cutting_write
        cid = update_command(cp)
        try:
            m.poll_once(ctx)
            check(False, cut + ": the power loss stopped the runner")
        except PowerLoss:
            pass
        finally:
            m.write_update_state, m.wait_healthy = real_write, real_wait
        check(tree_digest(os.path.join(paths["releases"], "A")) == digest_a, cut + ": the installed slot's bytes are unchanged")
        check(m.journal_read(ctx, cid)["state"] == "running" and cp.of("commands/ack") == [], cut + ": the command stays running, nothing acked")
        # The machine reboots: systemd's start of the home and the recovery timer's.
        active["running"] = set(); active["launches"].clear()
        ctx["systemctl"]("start", m.HOME_UNIT); ctx["systemctl"]("start", m.HOME_UNIT)
        codes = {l[0] for l in active["launches"]}
        check(codes == {boot_code}, cut + ": boot starts answered %r (expected %d)" % (active["launches"], boot_code))
        if boot_code == 0:
            check(all(l[2] == "A" for l in active["launches"]), cut + ": a start during installing runs the untouched live slot")
        else:
            reasons = {l[1] for l in active["launches"]}
            check(reasons <= {"gate_phase", "gate_denied"}, cut + ": refused by the gate, never as a layout mismatch: %r" % reasons)
        # The health wait sleeps 3 s between probes; only the poll loop's sleep ends the run.
        ctx["sleep"] = lambda seconds: (_ for _ in ()).throw(KeyboardInterrupt()) if seconds == m.POLL_SECONDS else None
        try:
            m.run(ctx, monotonic=lambda: 0)
        except KeyboardInterrupt:
            pass
        state = m.read_update_state(ctx)
        check(state["inflight"] is None and state["installed"]["slot"] == slot and state["lastResult"]["commandId"] == cid
              and state["lastResult"]["outcome"] == outcome and state["lastResult"]["reason"] == reason, cut + ": re-driven to %s: %r" % (outcome, state))
        check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid] == [outcome], cut + ": the interrupted command is reported once")
        check(m.current_target(ctx) == slot and active["slot"] == slot and m.HOME_UNIT in active["running"] and not os.path.exists(m.inhibit_path(ctx)),
              cut + ": the home runs the installed slot, inhibit lifted")
        check(tree_digest(os.path.join(paths["releases"], "A")) == digest_a, cut + ": the previously installed slot's bytes are still unchanged")
        results.setdefault("cuts", []).append(cut)


def update_phases(root):
    """T-I1, T-I2a, T-S1, T-I4 (A1): the journal alone decides; every blocked kind is refused in every phase; a layout the phase does not
    allow, or a journal that cannot be read, is Stuck (with the explicit stop) for the updater and 79 for the launcher."""
    ctx, cp, calls, active = setup(root)
    paths = ctx["paths"]
    ctx["run"] = lambda argv, **kw: (0, b"") if argv[0] == "journalctl" else m.run_process(argv, **kw)
    # T-I1: an in-flight record with no per-command journal is owed; a running journal with nothing in flight answers from lastResult.
    cid = str(uuid.uuid4())
    write_state(ctx, inflight=inflight_record(phase="installing", cid=cid))
    check(m.recovery_pending(ctx), "inflight present, no command journal: pending")
    write_state(ctx, last={"commandId": cid, "outcome": "done", "reason": None})
    check(not m.recovery_pending(ctx), "nothing in flight, layout sane: not pending")
    record = {"kind": "update_software", "state": "running"}
    check(m.recover(ctx, record, None, cid) == "done" and m.recover(ctx, record, None, cid) == "done", "the recorded outcome, idempotently")
    check(m.recover(ctx, record, None, str(uuid.uuid4())) == "failed", "another command's interrupted update is not mistaken for this one")
    # T-I2a: in each of the five phases, every blocked kind is refused and acked failed; collect_logs runs.
    stage_candidate(ctx, active)
    layouts = {"installing": "A", "installed": "A", "flip": "B", "verify": "B", "rollback": "A"}
    for phase, current in layouts.items():
        write_state(ctx, inflight=inflight_record(phase=phase, restored=(phase == "rollback")))
        set_current(ctx, current)
        calls.clear()
        ids = {kind: cp.add(kind, CONTRACT["commands"][kind]) for kind in m.BLOCKED_BY_RECOVERY}
        ids["collect_logs"] = cp.add("collect_logs", {"maxLines": 10, "redact": True, "chatContent": False})
        outcomes = dict(m.poll_once(ctx))
        check(all(outcomes[k] == "failed" for k in m.BLOCKED_BY_RECOVERY) and outcomes["collect_logs"] == "done", phase + ": blocked kinds refused, logs run: %r" % outcomes)
        acks = {a["commandId"]: a["outcome"] for a in cp.of("commands/ack")}
        check(all(acks.get(ids[k]) == "failed" for k in m.BLOCKED_BY_RECOVERY), phase + ": each blocked command acked failed")
        check(not any(c[0] in ("start", "restart") for c in calls), phase + ": nothing started by a blocked command")
        cp.requests.clear()
    # T-S1: `current -> B` with `installed.slot == A` and nothing in flight (or a pre-flip phase) is a mismatch: Stuck, the home stopped.
    for phase in (None, "installing", "installed"):
        write_state(ctx, inflight=inflight_record(phase=phase) if phase else None)
        set_current(ctx, "B")
        active["running"] = {m.HOME_UNIT}
        calls.clear(); active["launches"].clear()
        check(m.recovery_pending(ctx), "%s: current -> B while installed is A: pending" % phase)
        for kind in m.BLOCKED_BY_RECOVERY:
            cp.add(kind, CONTRACT["commands"][kind])
        check(all(o == "failed" for _k, o in m.poll_once(ctx)), "%s: every blocked kind refused" % phase)
        try:
            m.drive_update(ctx)
            check(False, "%s: drive_update raised" % phase)
        except m.Stuck as stuck:
            check(stuck.code == "home_layout_mismatch", "%s: Stuck(home_layout_mismatch), got %s" % (phase, stuck.code))
        check(STOP in calls and m.HOME_UNIT not in active["running"], "%s: the updater issued the explicit stop and the unit is inactive: %r" % (phase, calls))
        check(not any(c == START for c in calls), "%s: no start" % phase)
        ctx["systemctl"]("start", m.HOME_UNIT)
        check(active["launches"][-1][:2] == (79, "home_layout_mismatch") and m.HOME_UNIT not in active["running"], "%s: the launcher refuses 79 home_layout_mismatch: %r" % (phase, active["launches"][-1]))
    set_current(ctx, "A")
    write_state(ctx)
    active["running"] = {m.HOME_UNIT}
    check(not m.recovery_pending(ctx), "layout restored: not pending")
    # T-I4: every unreadable or implausible journal is owed: refused, Stuck, the launcher 79; no start, no rename of `current`.
    good = json.dumps({"format": m.UPDATE_STATE_FORMAT, "installed": {"slot": "A", "sequence": 1, "revision": IMAGE_REVISION}, "inflight": None, "lastResult": None}).encode()
    shapes = {"missing": None, "empty": b"", "non-json": b"{", "wrong-format": good.replace(b"-v3", b"-v2"),
              "unknown-phase": json.dumps({"format": m.UPDATE_STATE_FORMAT, "installed": {"slot": "A", "sequence": 1, "revision": IMAGE_REVISION},
                                           "inflight": dict(inflight_record(), phase="committed"), "lastResult": None}).encode(),
              "candidate-is-installed": json.dumps({"format": m.UPDATE_STATE_FORMAT, "installed": {"slot": "A", "sequence": 1, "revision": IMAGE_REVISION},
                                                    "inflight": inflight_record(slot="A", phase="verify"), "lastResult": None}).encode()}
    for name, data in shapes.items():
        raw_state(ctx, data)
        calls.clear(); active["launches"].clear(); active["running"] = {m.HOME_UNIT}
        check(m.recovery_pending(ctx), name + ": pending")
        update_command(cp)
        check(m.poll_once(ctx) == [("update_software", "failed")], name + ": update refused")
        try:
            m.drive_update(ctx)
            check(False, name + ": drive raised")
        except m.Stuck as stuck:
            check(stuck.code in ("update_state_invalid", "home_layout_mismatch"), name + ": Stuck %s" % stuck.code)
        check(STOP in calls and START not in calls and m.current_target(ctx) == "A", name + ": stopped, nothing started, the link untouched")
        ctx["systemctl"]("start", m.HOME_UNIT)
        check(active["launches"][-1][0] == 79 and active["launches"][-1][1] == "home_layout_mismatch", name + ": launcher 79 home_layout_mismatch: %r" % (active["launches"][-1],))
    raw_state(ctx, good)
    for name, link in (("dangling", "C"), ("outside", "/opt/evil")):
        set_current(ctx, link)
        calls.clear(); active["launches"].clear(); active["running"] = {m.HOME_UNIT}
        check(m.recovery_pending(ctx), name + ": pending")
        try:
            m.drive_update(ctx)
            check(False, name + ": drive raised")
        except m.Stuck as stuck:
            check(stuck.code == "home_layout_mismatch", name + ": Stuck home_layout_mismatch")
        check(STOP in calls and START not in calls, name + ": stopped, nothing started")
        ctx["systemctl"]("start", m.HOME_UNIT)
        check(active["launches"][-1][:2] == (79, "home_layout_mismatch"), name + ": launcher 79: %r" % (active["launches"][-1],))
    set_current(ctx, "A")
    swaps = os.path.join(paths["state"], "swaps")
    os.makedirs(swaps, exist_ok=True)
    with open(os.path.join(swaps, "x"), "w") as handle:
        handle.write("not json")
    check(m.recovery_pending(ctx), "an unreadable swap record is pending (the existing branch is kept)")
    os.unlink(os.path.join(swaps, "x"))
    check(not m.recovery_pending(ctx), "clean again")


def update_pending(root):
    """T-H2a, T-H2b, Q3: an update whose candidate dies and whose restored release never answers stays pending (never acked), is re-driven
    every loop and at start, and after three counted rollback starts is Stuck: still blocking, the fixed reason surfaced, the home stopped,
    no auto-clear even when the restored release would answer again."""
    ctx, cp, calls, active = setup(root)
    paths = ctx["paths"]
    channel = served(ctx, root, paths["releases"])
    channel.update(make_release(root, "b" * 40, 2, active["signer"]))
    active["bad_slot"], active["unhealthy_slot"] = "B", "A"
    drives = []
    real_drive = m.drive_update
    m.drive_update = lambda ctx_, release=None: (drives.append(1), real_drive(ctx_, release))[1]
    try:
        cid = update_command(cp)
        check(m.poll_once(ctx) == [("update_software", "pending")], "candidate dead, restored release unhealthy: pending")
        check(cp.of("commands/ack") == [] and m.journal_read(ctx, cid)["state"] == "running", "nothing acked, the command stays running")
        state = m.read_update_state(ctx)
        check(state["inflight"]["phase"] == "rollback" and state["inflight"]["restored"] and state["inflight"]["rollbackAttempts"] == 1
              and state["installed"]["slot"] == "A" and m.current_target(ctx) == "A", "rolled back to A, one counted start: %r" % state["inflight"])
        check(m.HOME_UNIT not in active["running"] and os.path.exists(m.inhibit_path(ctx)), "the unanswering restored release is taken down; the inhibit stays")
        for attempt in (2, 3):
            drives.clear(); calls.clear()
            stderr_of(lambda: (m.drive_pending_update(ctx), m.recover_interrupted(ctx)))  # one poll loop's recovery steps
            check(len(drives) >= 1, "re-driven on the next loop (%d)" % attempt)
            state = m.read_update_state(ctx)
            check(state["inflight"]["rollbackAttempts"] == attempt, "attempt %d counted before its start: %r" % (attempt, state["inflight"]))
            check(STOP in calls, "attempt %d: the unanswering release is stopped again" % attempt)
        calls.clear()
        _, err = stderr_of(lambda: (m.drive_pending_update(ctx), m.recover_interrupted(ctx)))
        check("Self-service update stuck: rollback_unhealthy" in err, "three unhealthy rollback starts: Stuck, the fixed reason surfaced: %r" % err)
        state = m.read_update_state(ctx)
        check(state["inflight"]["rollbackAttempts"] == 3 and state["inflight"]["phase"] == "rollback", "nothing cleared: %r" % state["inflight"])
        check(STOP in calls and START not in calls and m.HOME_UNIT not in active["running"], "Stuck stops the home and starts nothing")
        check(cp.of("commands/ack") == [], "still not acked")
        # Q3: Stuck keeps blocking and keeps surfacing, with no auto-clear, even once the restored release would answer.
        active["unhealthy_slot"] = None
        for _ in range(2):
            calls.clear()
            _, err = stderr_of(lambda: (m.drive_pending_update(ctx), m.recover_interrupted(ctx)))
            check("rollback_unhealthy" in err and STOP in calls and START not in calls, "Stuck repeats on every poll: blocking, stopping, surfacing")
        for kind in m.BLOCKED_BY_RECOVERY:
            cp.add(kind, CONTRACT["commands"][kind])
        outcomes = dict(m.poll_once(ctx))
        check(all(o == "failed" for k, o in outcomes.items() if k != "update_software") and outcomes.get("update_software") in ("failed", "pending"), "every blocked kind refused while Stuck: %r" % outcomes)
        check(m.read_update_state(ctx)["inflight"]["phase"] == "rollback", "still Stuck in rollback")
        # T-H2b: run() start-up drives first, and re-drives every loop.
        drives.clear()
        ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            m.run(ctx, monotonic=lambda: 0)
        except KeyboardInterrupt:
            pass
        check(len(drives) >= 2, "run(): driven at start-up and again in the loop: %d" % len(drives))
    finally:
        m.drive_update = real_drive


def gate(root):
    """T-G1, T-G2, T-G4: the start gate. No journal field produces a start; one counter write, one grant, one start; every ungranted start
    (boot, Restart=) exits 79 gate_denied; the launcher's decision table, cell by cell, under every `current` its phase allows."""
    ctx, cp, calls, active = setup(root)
    paths = ctx["paths"]
    lpaths = launcher_paths(paths)
    gate_sock = lpaths["gate"]
    def ask(slot, peer=None):
        try:
            launch.ask_gate(gate_sock, slot, peer or (lambda pid, uid: dict(active["client_peer"])))
            return "grant"
        except launch.Refused as refused:
            return refused.reason
    # T-G1
    check(ask("B") == "gate_denied", "no drive in verify: deny")
    ctx["gate"]["grant"] = {"driveId": "x", "slot": "B"}
    active["server_peer"] = {"uid": 1000, "cgroup": m.HOME_CGROUP, "exe": "/usr/bin/python3"}
    check(ask("B") == "gate_denied" and ctx["gate"]["grant"] is not None, "a peer that is not uid 0: deny, the grant kept")
    active["server_peer"] = {"uid": 0, "cgroup": "0::/system.slice/evil.service", "exe": "/usr/bin/python3"}
    check(ask("B") == "gate_denied" and ctx["gate"]["grant"] is not None, "a peer outside murage-home.service's cgroup: deny")
    active["server_peer"] = {"uid": 0, "cgroup": m.HOME_CGROUP, "exe": "/usr/bin/node"}
    check(ask("B") == "gate_denied" and ctx["gate"]["grant"] is not None, "a peer that is not the image's python3: deny")
    active["server_peer"] = {"uid": 0, "cgroup": m.HOME_CGROUP, "exe": "/usr/bin/python3"}
    check(ask("A") == "gate_denied" and ctx["gate"]["grant"] is not None, "the wrong slot: deny, the grant kept")
    check(ask("B") == "grant" and ctx["gate"]["grant"] is None, "the correct peer and slot: exactly one grant, consumed")
    check(ask("B") == "gate_denied", "the second request: deny")
    ctx["gate"]["grant"] = {"driveId": "x", "slot": "B"}
    active["client_peer"] = {"uid": 0, "cgroup": "0::/system.slice/evil.service"}
    check(ask("B") == "gate_denied" and ctx["gate"]["grant"] is not None, "the client refuses a gate that is not murage-commands.service (checked both ways)")
    active["client_peer"] = {"uid": 0, "cgroup": launch.COMMANDS_CGROUP}
    ctx["gate"]["grant"] = None
    # Forged inflight.commandId (a pending reset's id): no grant and no start.
    stage_candidate(ctx, active)
    reset_cid = str(uuid.uuid4())
    m.journal_claim(ctx, reset_cid, {"kind": "reset_from_backup", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE, "resetId": str(uuid.uuid4())})
    write_state(ctx, inflight=inflight_record(phase="verify", cid=reset_cid))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    calls.clear(); active["launches"].clear(); active["running"] = set()
    check(m.start_home(ctx) == 0 and START not in calls, "a forged commandId produces no start from start_home (count of systemctl start: 0)")
    ctx["systemctl"]("start", m.HOME_UNIT)
    check(active["launches"][-1][:2] == (79, "gate_denied") and m.HOME_UNIT not in active["running"], "the launcher asks the gate and is denied: %r" % (active["launches"][-1],))
    os.unlink(m.journal_file(ctx, reset_cid))
    # T-G2 (A1): post-flip layout, boot during verify, then systemd restarts: the counter bounds every start of slot code.
    cid = str(uuid.uuid4())
    write_state(ctx, inflight=inflight_record(phase="verify", cid=cid, verify_attempts=0))
    m.journal_claim(ctx, cid, {"kind": "update_software", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE})
    active["bad_slot"] = "B"
    active["running"] = set(); active["launches"].clear(); calls.clear(); active["probes"] = 0
    for _ in range(3):
        ctx["systemctl"]("start", m.HOME_UNIT)
    check([l[:2] for l in active["launches"]] == [(79, "gate_denied")] * 3, "boot and restarts without a grant: 79 gate_denied each, never a layout mismatch: %r" % active["launches"])
    # The updater drives: counter, grant, start; the candidate dies; the updater crashes after granting (power loss during wait_healthy).
    real_wait = m.wait_healthy
    m.wait_healthy = lambda ctx_, *a, **kw: (_ for _ in ()).throw(PowerLoss())
    try:
        m.drive_update(ctx)
        check(False, "power loss")
    except PowerLoss:
        pass
    finally:
        m.wait_healthy = real_wait
    state = m.read_update_state(ctx)
    check(state["inflight"]["verifyAttempts"] == 1 and [l[2] for l in launches(active, 0)] == ["B"] and active["probes"] == 0, "one counted, granted start of B: %r" % state["inflight"])
    active["running"] = set()
    for _ in range(2):
        ctx["systemctl"]("start", m.HOME_UNIT)
    check([l[:2] for l in active["launches"][-2:]] == [(79, "gate_denied")] * 2, "restarts after the crash: denied (the grant was consumed)")
    trace = Trace(ctx, calls)
    try:
        check(m.drive_update(ctx) == "failed", "second counted start, unhealthy, rollback, the restored slot answers: failed")
    finally:
        trace.close()
    state = m.read_update_state(ctx)
    verify_writes = [e for e in trace.log if e[0] == "write" and e[2] == "verify"]
    check(len(verify_writes) == 1 and state["inflight"] is None and state["lastResult"]["reason"] == "unhealthy" and state["installed"]["slot"] == "A",
          "verifyAttempts 1 -> 2 (one counter write), then rollback to A: %r %r" % (state, verify_writes))
    check([l[2] for l in launches(active, 0)] == ["B", "B", "A"], "total starts of slot code == the counters (2 of B, then the rollback's 1 of A): %r" % launches(active, 0))
    check(active["probes"] > 0, "the candidate was probed (app health) under its grant")
    rollback_write = [i for i, e in enumerate(trace.log) if e[0] == "write" and e[2] == "rollback"][0]
    stop_after = [i for i, e in enumerate(trace.log) if e[:3] == ("systemctl", "stop", m.HOME_UNIT) and i > rollback_write]
    rename_index = trace.log.index(("rename", "A"))
    check(stop_after and stop_after[0] < rename_index, "phase := rollback written, the stop issued, then the rename of `current` back: %r" % trace.log)
    check(STOP in calls and calls.index(STOP) < len(calls) - 1 - calls[::-1].index(START), "systemctl stop logged before the restored slot's start")
    active["bad_slot"] = None
    # T-G4: the decision table, every `current` its phase allows, the reason token, and two seal walks in a transition cell.
    write_state(ctx)
    set_current(ctx, "A")
    walks = []
    real_walk = launch.seal_walk_digest
    launch.seal_walk_digest = lambda fd, sealed: (walks.append(sealed), real_walk(fd, sealed))[1]
    asked = []
    real_ask = launch.ask_gate
    launch.ask_gate = lambda sock, slot, peer=None: (asked.append(slot), real_ask(sock, slot, peer))[1]
    try:
        def cell(phase, inhibit, current, grant=None, restored=False):
            if phase is None:
                write_state(ctx)
            else:
                write_state(ctx, inflight=inflight_record(phase=phase, restored=restored))
            set_current(ctx, current)
            if inhibit:
                m.inhibit_starts(ctx)
            else:
                try:
                    os.unlink(m.inhibit_path(ctx))
                except FileNotFoundError:
                    pass
            ctx["gate"]["grant"] = {"driveId": "x", "slot": grant} if grant else None
            walks.clear(); asked.clear(); active["launches"].clear(); active["running"] = set()
            ctx["systemctl"]("start", m.HOME_UNIT)
            code, reason, slot = active["launches"][-1]
            return code, reason, len(walks), len(asked), slot
        table = [
            ((None, False, "A"), (0, None, 1, 0, "A")),
            ((None, True, "A"), (79, "gate_phase", 1, 0, None)),
            (("installing", False, "A"), (0, None, 1, 0, "A")),
            (("installing", True, "A"), (79, "gate_phase", 1, 0, None)),
            (("installed", False, "A"), (79, "gate_phase", 1, 0, None)),
            (("installed", True, "A"), (79, "gate_phase", 1, 0, None)),
            (("flip", True, "A"), (79, "gate_phase", 2, 0, None)),
            (("flip", True, "B"), (79, "gate_phase", 2, 0, None)),
            (("verify", True, "B"), (79, "gate_denied", 2, 1, None)),
            (("verify", False, "B"), (79, "gate_denied", 2, 1, None)),
            (("verify", True, "A"), (79, "home_layout_mismatch", 0, 0, None)),  # outside the phase's set: refused before any walk
            (("rollback", True, "A"), (79, "gate_phase", 2, 0, None)),
            (("rollback", True, "B"), (79, "gate_phase", 2, 0, None)),
        ]
        for (phase, inhibit, current), want in table:
            got = cell(phase, inhibit, current)
            check(got == want, "cell %r: got %r, want %r" % ((phase, inhibit, current), got, want))
        check(cell("verify", True, "B", grant="B") == (0, None, 2, 1, "B"), "verify with a live grant for the candidate: start")
        check(cell("verify", True, "B", grant="A") == (79, "gate_denied", 2, 1, None), "verify with a grant for the other slot: denied")
        check(cell("rollback", True, "A", grant="A", restored=True) == (0, None, 2, 1, "A"), "rollback(restored) with a grant for the restored slot: start")
        check(cell("rollback", True, "A", restored=True) == (79, "gate_denied", 2, 1, None), "rollback(restored) without a grant: denied")
        check(cell("rollback", True, "B", restored=True) == (79, "home_layout_mismatch", 0, 0, None), "rollback(restored) with current still on the candidate: mismatch before any walk")
    finally:
        launch.seal_walk_digest, launch.ask_gate = real_walk, real_ask
    write_state(ctx); set_current(ctx, "A"); ctx["gate"]["grant"] = None
    try:
        os.unlink(m.inhibit_path(ctx))
    except FileNotFoundError:
        pass


def transition(root):
    """T-S2, T-S3, T-W1, T-G5 (A1): a boot inside the flip -> verify -> rollback span reaches the counted verify (never a false Stuck);
    genuine corruption inside the span is still Stuck with the explicit stop and no start, rename or grant; the stop precedes every flip
    back and repeats on resume; an idle home is never touched by an updater restart."""
    # T-S2: boot during verify, post-flip.
    ctx, cp, calls, active = setup(os.path.join(root, "verify"))
    stage_candidate(ctx, active)
    cid = str(uuid.uuid4())
    write_state(ctx, inflight=inflight_record(phase="verify", cid=cid))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    m.journal_claim(ctx, cid, {"kind": "update_software", "state": "running", "startedAt": NOW, "acked": False, "deadline": DEADLINE})
    active["running"] = set(); active["launches"].clear(); calls.clear(); active["probes"] = 0
    walks = []
    real_walk = launch.seal_walk_digest
    launch.seal_walk_digest = lambda fd, sealed: (walks.append(1), real_walk(fd, sealed))[1]
    try:
        ctx["systemctl"]("start", m.HOME_UNIT)
    finally:
        launch.seal_walk_digest = real_walk
    check(active["launches"][-1][:2] == (79, "gate_denied") and len(walks) == 2, "boot in verify: both slots walked, the gate contacted, 79 gate_denied: %r" % active["launches"])
    trace = Trace(ctx, calls)
    try:
        check(m.drive_update(ctx) == "done", "the updater reaches its verify handler: no Stuck")
    finally:
        trace.close()
    state = m.read_update_state(ctx)
    check(state["installed"] == {"slot": "B", "sequence": 2, "revision": "b" * 40} and state["inflight"] is None and state["lastResult"]["commandId"] == cid, "committed: %r" % state)
    check([l[2] for l in launches(active, 0)] == ["B"] and active["probes"] > 0, "verifyAttempts 0 -> 1, a grant for B, the candidate started and probed")
    commit = [i for i, e in enumerate(trace.log) if e[0] == "write" and e[2] is None][0]
    check(trace.log[commit][4] is True and trace.log.index(("lift", True)) > commit, "the inhibit is lifted only after the commit write")
    check(not os.path.exists(m.inhibit_path(ctx)) and m.HOME_UNIT in active["running"], "home up on B, inhibit lifted")
    # Variant flip: the rename has not landed (current -> A) when the updater restarts.
    ctx, cp, calls, active = setup(os.path.join(root, "flip"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="flip"))
    m.inhibit_starts(ctx)
    active["running"] = set(); active["launches"].clear()
    ctx["systemctl"]("start", m.HOME_UNIT)
    check(active["launches"][-1][:2] == (79, "gate_phase"), "boot in flip: 79 gate_phase")
    check(m.drive_update(ctx) == "done" and m.current_target(ctx) == "B" and m.read_update_state(ctx)["installed"]["slot"] == "B", "flip completes the rename, then verify, then commit")
    # Variant unhealthy: the candidate dies; rollback with the stop logged before the flip back; a counted start of A.
    ctx, cp, calls, active = setup(os.path.join(root, "unhealthy"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="verify"))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    active["bad_slot"] = "B"; active["running"] = set(); active["launches"].clear(); calls.clear()
    trace = Trace(ctx, calls)
    try:
        check(m.drive_update(ctx) == "failed", "unhealthy candidate: rolled back, failed")
    finally:
        trace.close()
    state = m.read_update_state(ctx)
    check(state["installed"]["slot"] == "A" and state["inflight"] is None and state["lastResult"]["reason"] == "unhealthy" and m.current_target(ctx) == "A", "back on A: %r" % state)
    check([l[2] for l in launches(active, 0)] == ["B", "A"], "one counted start of B, one of A")
    rollback_write = [i for i, e in enumerate(trace.log) if e[0] == "write" and e[2] == "rollback"][0]
    check(rollback_write < trace.log.index(("rename", "A")) and STOP in calls, "phase := rollback and the stop precede the flip back")
    # T-S3: six corruption shapes inside verify, each Stuck with the stop, no start, no rename, no grant.
    def corrupt(name, prepare, want):
        ctx, cp, calls, active = setup(os.path.join(root, "corrupt-" + name))
        stage_candidate(ctx, active)
        write_state(ctx, inflight=inflight_record(phase="verify"))
        set_current(ctx, "B")
        m.inhibit_starts(ctx)
        prepare(ctx, active)
        link_before = os.readlink(os.path.join(ctx["paths"]["releases"], "current")) if os.path.lexists(os.path.join(ctx["paths"]["releases"], "current")) else None
        active["running"] = set(); active["launches"].clear(); calls.clear()
        ctx["systemctl"]("start", m.HOME_UNIT)
        check(active["launches"][-1][:2] == (79, want), name + ": launcher 79 %s: %r" % (want, active["launches"][-1]))
        active["running"] = {m.HOME_UNIT}; calls.clear()  # the home happens to be up when the updater drives
        try:
            m.drive_update(ctx)
            check(False, name + ": drive raised")
        except m.Stuck as stuck:
            check(stuck.code in (want, "update_state_invalid"), name + ": Stuck %s" % stuck.code)
        check(STOP in calls and START not in calls, name + ": the explicit stop, no start")
        check((os.readlink(os.path.join(ctx["paths"]["releases"], "current")) if link_before else None) == link_before, name + ": no rename of current")
        check(ctx["gate"]["grant"] is None, name + ": no grant issued")
    def a(ctx, active):
        write_state(ctx, inflight=inflight_record(slot="A", phase="verify"))
    def b(ctx, active):
        set_current(ctx, "A")
    def c(ctx, active):
        sig = os.path.join(ctx["paths"]["update_state"], "manifests", "B.sig")
        thaw(os.path.dirname(sig)); thaw(sig)
        with open(sig, "r+b") as handle:
            handle.seek(0); handle.write(bytes([handle.read(1)[0] ^ 0xFF]))
        IMMUTABLE.freeze(sig); IMMUTABLE.freeze(os.path.dirname(sig))
    def d(ctx, active):
        thaw(os.path.join(ctx["paths"]["releases"], "A", "dist-server", "index.js"))
    def e(ctx, active):
        write_state(ctx, installed={"slot": "A", "sequence": 5, "revision": IMAGE_REVISION}, inflight=inflight_record(phase="verify", sequence=6))
    def f(ctx, active):
        set_current(ctx, "C")
    corrupt("candidate-is-installed", a, "home_layout_mismatch")
    corrupt("current-not-candidate", b, "home_layout_mismatch")
    corrupt("candidate-signature", c, "home_layout_mismatch")
    corrupt("committed-not-sealed", d, "slot_seal_failed")
    corrupt("installed-sequence", e, "home_layout_mismatch")
    corrupt("dangling", f, "home_layout_mismatch")
    # T-W1: the explicit stop at rollback entry, on resume, and at rollbackAttempts == 3; T-G5: an idle home is left alone.
    ctx, cp, calls, active = setup(os.path.join(root, "w1"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=False, reason="unhealthy"))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    active["running"] = {m.HOME_UNIT}; calls.clear(); active["launches"].clear()
    trace = Trace(ctx, calls)
    try:
        check(m.drive_update(ctx) == "failed", "resume at rollback(restored=false): completes")
    finally:
        trace.close()
    check(calls[0] == STOP and trace.log.index(("systemctl", "stop", "murage-home.service")) < trace.log.index(("rename", "A")) if ("systemctl", "stop", "murage-home.service") in trace.log else calls[0] == STOP,
          "the stop is the first thing on resume, before the flip back: %r" % calls[:3])
    check(m.current_target(ctx) == "A" and m.read_update_state(ctx)["inflight"] is None and active["slot"] == "A", "flipped back and the restored slot started")
    # rollbackAttempts == 3 and unhealthy: Stuck, the stop logged.
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=True, rollback_attempts=3, reason="unhealthy"))
    m.inhibit_starts(ctx)
    active["running"] = set(); calls.clear()
    try:
        m.drive_update(ctx)
        check(False, "Stuck expected")
    except m.Stuck as stuck:
        check(stuck.code == "rollback_unhealthy" and STOP in calls and START not in calls, "rollbackAttempts == 3: Stuck(rollback_unhealthy) with the stop")
    # T-G5: an updater restart with an idle home: no stop, no restart of the home.
    write_state(ctx)
    os.unlink(m.inhibit_path(ctx))
    active["running"] = {m.HOME_UNIT}; calls.clear()
    ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
    try:
        m.run(ctx, monotonic=lambda: 0)
    except KeyboardInterrupt:
        pass
    check(not any(c[0] in ("stop", "start", "restart") for c in calls) and m.HOME_UNIT in active["running"], "idle home, updater restart: never stopped or restarted: %r" % calls)
    # T-W2 (Grok HIGH, rollback entry): a candidate that will not stop. stop_writers reports a unit still up at rollback entry, so the
    # flip back is Stuck(rollback_stop) before it runs; `current` is never moved under a running candidate and nothing is granted.
    ctx, cp, calls, active = setup(os.path.join(root, "rollback-stop"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=False, reason="unhealthy"))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    active["running"] = {m.HOME_UNIT}; active["stuck"] = {m.HOME_UNIT}; calls.clear(); active["launches"].clear()
    try:
        m.drive_update(ctx)
        check(False, "Stuck(rollback_stop) expected")
    except m.Stuck as stuck:
        check(stuck.code == "rollback_stop", "a candidate that will not stop: Stuck(rollback_stop): %s" % stuck.code)
    check(m.current_target(ctx) == "B" and START not in calls and ctx["gate"]["grant"] is None,
          "no flip back under a running candidate, nothing granted or started")
    check(m.read_update_state(ctx)["inflight"]["restored"] is False, "restored stays false; the flip never ran")
    # T-W3 (Grok HIGH, rollback progress): rollbackAttempts and Stuck(rollback_unhealthy) progress even while the home unit stays active.
    # At rollbackAttempts == ROLLBACK_ATTEMPTS with the home still up and its app not answering, the drive is Stuck(rollback_unhealthy)
    # and never records the candidate. The pre-fix code gated the counter behind "unit not active" and looped pending forever.
    ctx, cp, calls, active = setup(os.path.join(root, "rollback-active"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=True, rollback_attempts=m.ROLLBACK_ATTEMPTS, reason="unhealthy"))
    set_current(ctx, "A")
    m.inhibit_starts(ctx)
    active["running"] = {m.HOME_UNIT}; active["unhealthy_slot"] = "A"; calls.clear(); active["launches"].clear()
    try:
        m.drive_update(ctx)
        check(False, "Stuck(rollback_unhealthy) expected")
    except m.Stuck as stuck:
        check(stuck.code == "rollback_unhealthy", "home active at rollbackAttempts == max: Stuck(rollback_unhealthy), not pending: %s" % stuck.code)
    state = m.read_update_state(ctx)
    check(state["inflight"] is not None and state["inflight"]["phase"] == "rollback" and state["installed"]["slot"] == "A",
          "the candidate is never recorded by finish_update; the record stays in rollback")
    check(STOP in calls and START not in calls, "the home is stopped and nothing is started once Stuck")
    # T-W5 (Grok HIGH, stale health): the home is up and answering from BEFORE this drive (the candidate kept serving). Health is accepted
    # only after THIS drive's own stop and grant_and_start of the previous slot, so the stale answer is never taken as the rollback's.
    ctx, cp, calls, active = setup(os.path.join(root, "rollback-stale-health"))
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=True, rollback_attempts=0, reason="unhealthy"))
    set_current(ctx, "A")
    m.inhibit_starts(ctx)
    active["slot"] = "B"; active["running"] = {m.HOME_UNIT}; calls.clear(); active["launches"].clear()
    outcome = m.drive_update(ctx)
    check(outcome == "failed", "the rollback completes as failed/unhealthy: %r" % (outcome,))
    check(STOP in calls and START in calls and calls.index(STOP) < calls.index(START),
          "the stale-healthy home is stopped first, then the previous slot is started by this drive: %r" % (calls,))
    check(ctx["gate"]["grant"] is not None or any(l[2] == "A" for l in active["launches"]) or START in calls,
          "the previous slot was granted and started by this drive")
    # T-W4 (Grok MEDIUM): abort_install must not swallow an OSError from wipe_slot. A wipe that fails with OSError (a partial or symlink
    # idle slot) keeps inflight and is Stuck(wipe_target), never cleared, so the slot is retried instead of left behind.
    ctx, cp, calls, active = setup(os.path.join(root, "wipe-oserror"))
    stage_candidate(ctx, active)
    state = write_state(ctx, inflight=inflight_record(phase="installing"))
    set_current(ctx, "A")
    real_rmtree = m.shutil.rmtree
    m.shutil.rmtree = lambda *a, **kw: (_ for _ in ()).throw(OSError("idle slot wipe did not complete"))
    try:
        try:
            m.abort_install(ctx, state, "install_failed")
            check(False, "Stuck(wipe_target) expected from abort_install")
        except m.Stuck as stuck:
            check(stuck.code == "wipe_target", "abort_install surfaces the wipe OSError as Stuck(wipe_target): %s" % stuck.code)
    finally:
        m.shutil.rmtree = real_rmtree
    kept = m.read_update_state(ctx)["inflight"]
    check(kept is not None and kept["phase"] == "installing", "the record is kept (inflight not cleared) when the wipe did not complete")


def trust(root):
    """T-T1, T-T2, T-T3, T-D1: the trust root is read only from /usr/lib/murage-home/trust and must be intact; the floor is the signed live
    sequence, never the journal's number; every slot in every gate is signature-gated; the idle-slot wipe re-derives its target."""
    ctx, cp, calls, active = setup(root)
    paths = ctx["paths"]
    fetched = []
    channel = served(ctx, root, paths["releases"])
    real_fetch = ctx["fetch"]
    ctx["fetch"] = lambda url, *a, **kw: (fetched.append(url), real_fetch(url, *a, **kw))[1]
    channel.update(make_release(root, "b" * 40, 2, active["signer"]))
    # T-T1: the old /etc/murage-home files are not a trust root.
    with open(os.path.join(paths["config"], "release.json"), "w") as handle:
        json.dump({"channelUrl": "https://releases.murage.test/cloud-home"}, handle)
    shutil.copy(active["signer"].public, os.path.join(paths["config"], "release-public-key.pem"))
    trust_dir = paths["trust"]
    held = trust_dir + ".held"
    IMMUTABLE.thaw_all(trust_dir); thaw(trust_dir)
    os.rename(trust_dir, held)
    try:
        calls.clear()
        check(m.recovery_pending(ctx), "no trust root: pending")
        update_command(cp)
        check(m.poll_once(ctx) == [("update_software", "failed")] and fetched == [], "no trust root: refused, no fetch")
        try:
            m.drive_update(ctx)
            check(False, "Stuck expected")
        except m.Stuck as stuck:
            check(stuck.code == "trust_root_invalid", "Stuck(trust_root_invalid), got %s" % stuck.code)
    finally:
        os.rename(held, trust_dir)
    for name, prepare, restore in (("0755", lambda: os.chmod(trust_dir, 0o755), lambda: os.chmod(trust_dir, 0o700)),
                                   ("no +i", lambda: None, lambda: None)):
        prepare()
        try:
            check(m.recovery_pending(ctx), "trust dir %s: pending" % name)
            try:
                m.drive_update(ctx)
                check(False, "Stuck expected")
            except m.Stuck as stuck:
                check(stuck.code == "trust_root_invalid", "trust dir %s: Stuck(trust_root_invalid)" % name)
        finally:
            restore()
    for current, dirs, files in os.walk(trust_dir, topdown=False):
        for name in files + dirs:
            IMMUTABLE.freeze(os.path.join(current, name))
    IMMUTABLE.freeze(trust_dir)
    check(not m.recovery_pending(ctx) and fetched == [], "trust root back: not pending; nothing was ever fetched while it was invalid")
    # T-T2: the floor comes from the signed live manifest. Slot A re-signed at sequence 7; the journal forged to 1.
    thaw(paths["releases"]); IMMUTABLE.thaw_all(os.path.join(paths["releases"], "A"))
    thaw(paths["update_state"]); thaw(os.path.join(paths["update_state"], "manifests"))
    for name in ("A.json", "A.sig"):
        thaw(os.path.join(paths["update_state"], "manifests", name))
    manifest, signature = install_slot(paths, "A", tree_members(IMAGE_REVISION), active["signer"], 7, IMAGE_REVISION)
    IMMUTABLE.freeze(os.path.join(paths["update_state"], "manifests")); IMMUTABLE.freeze(paths["update_state"]); IMMUTABLE.freeze(paths["releases"])
    write_state(ctx, installed={"slot": "A", "sequence": 1, "revision": IMAGE_REVISION})
    channel.clear(); channel.update(make_release(root, "b" * 40, 5, active["signer"]))
    calls.clear(); fetched.clear()
    update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "failed")] and fetched == [], "installed.sequence forged below the signed live sequence: refused before any fetch")
    try:
        m.drive_update(ctx)
        check(False, "Stuck expected")
    except m.Stuck as stuck:
        check(stuck.code == "home_layout_mismatch" and STOP in calls, "drive entry Stuck on the cross-check, home stopped")
    write_state(ctx, installed={"slot": "A", "sequence": 7, "revision": IMAGE_REVISION})
    active["running"] = {m.HOME_UNIT}
    update_command(cp)
    _, err = stderr_of(lambda: m.poll_once(ctx))
    check("Self-service update refused: downgrade" in err, "sequence 5 against the signed floor 7: downgrade: %r" % err)
    channel.clear(); channel.update(make_release(root, "b" * 40, 8, active["signer"]))
    update_command(cp)
    check(m.poll_once(ctx) == [("update_software", "done")] and m.read_update_state(ctx)["installed"]["sequence"] == 8, "sequence 8 above the floor: installed")
    # T-T3: a corrupted stored signature of the slot a rollback would restore: Stuck, never a start.
    ctx, cp, calls, active = setup(os.path.join(root, "t3"))
    paths = ctx["paths"]
    stage_candidate(ctx, active)
    write_state(ctx, inflight=inflight_record(phase="rollback", restored=False, reason="unhealthy"))
    set_current(ctx, "B")
    m.inhibit_starts(ctx)
    sig = os.path.join(paths["update_state"], "manifests", "A.sig")
    thaw(os.path.dirname(sig)); thaw(sig)
    with open(sig, "r+b") as handle:
        handle.write(bytes([handle.read(1)[0] ^ 0xFF]))
    active["running"] = set(); calls.clear()
    for _ in range(3):
        try:
            m.drive_update(ctx)
            check(False, "Stuck expected")
        except m.Stuck as stuck:
            check(stuck.code in ("home_layout_mismatch", "rollback_gate"), "rollback to a slot whose signature does not verify: Stuck (%s)" % stuck.code)
    check(START not in calls and m.read_update_state(ctx)["inflight"]["phase"] == "rollback" and os.path.exists(m.inhibit_path(ctx)) and m.current_target(ctx) == "B",
          "never started, never cleared, inhibit kept, link untouched; repeats on every poll")
    # T-D1: a stale drive whose record names B while `current` was moved to B underneath: the wipe is Stuck, rmtree never runs, +i stays.
    ctx, cp, calls, active = setup(os.path.join(root, "d1"))
    paths = ctx["paths"]
    stage_candidate(ctx, active)
    state = write_state(ctx, inflight=inflight_record(phase="installing"))
    set_current(ctx, "B")
    removed = []
    real_rmtree = m.shutil.rmtree
    m.shutil.rmtree = lambda *a, **kw: (removed.append(a), real_rmtree(*a, **kw))[1]
    try:
        try:
            m.wipe_slot(ctx, state, "B")
            check(False, "Stuck expected")
        except m.Stuck as stuck:
            check(stuck.code == "wipe_target", "wipe target re-derived at wipe time: Stuck(wipe_target)")
        try:
            m.drive_update(ctx)
            check(False, "Stuck expected")
        except m.Stuck:
            pass
        set_current(ctx, "A")
        try:
            m.wipe_slot(ctx, dict(state, installed={"slot": "B", "sequence": 1, "revision": IMAGE_REVISION}), "B")
            check(False, "Stuck expected")
        except m.Stuck:
            pass
    finally:
        m.shutil.rmtree = real_rmtree
    check(removed == [] and IMMUTABLE.is_frozen(paths["releases"]) and os.path.isdir(os.path.join(paths["releases"], "B")), "rmtree never called; +i on the releases directory never lifted")
    # Two drivers (the poll and --recover-update): the second holder gets Pending.
    import fcntl
    holder = open(os.path.join(paths["gate"], "lock"), "a")
    fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
    try:
        try:
            m.drive_update(ctx)
            check(False, "Pending expected")
        except m.Pending:
            pass
    finally:
        holder.close()


def forged(root):
    """T-H4a: a forged state.json written during verify changes nothing the updater decides: its own health observation wins, and the
    commit it writes comes from its in-memory record, never from the forged file."""
    for verdict in (False, True):
        ctx, cp, calls, active = setup(os.path.join(root, "healthy" if verdict else "unhealthy"))
        stage_candidate(ctx, active)
        cid = str(uuid.uuid4())
        write_state(ctx, inflight=inflight_record(phase="verify", cid=cid))
        set_current(ctx, "B")
        m.inhibit_starts(ctx)
        active["running"] = set()
        real_wait = m.wait_healthy
        forged_once = []
        def forging_wait(ctx_, *a, **kw):
            if forged_once:
                return real_wait(ctx_, *a, **kw)
            forged_once.append(1)
            raw_state(ctx_, json.dumps({"format": m.UPDATE_STATE_FORMAT, "installed": {"slot": "B", "sequence": 99, "revision": "f" * 40}, "inflight": None,
                                        "lastResult": {"commandId": cid, "outcome": "done", "reason": None}}).encode())
            real_wait(ctx_, *a, **kw)
            return verdict
        m.wait_healthy = forging_wait
        try:
            _, err = stderr_of(lambda: m.drive_update(ctx))
        finally:
            m.wait_healthy = real_wait
        check("update_state_tampered" in err, "the rewritten file is noticed: %r" % err)
        state = m.read_update_state(ctx)
        if verdict:
            check(state["installed"] == {"slot": "B", "sequence": 2, "revision": "b" * 40} and state["inflight"] is None, "the commit is the in-flight record's, not the forged installed: %r" % state)
        else:
            check(state["installed"]["slot"] == "A" and state["inflight"] is None and state["lastResult"]["outcome"] == "failed" and m.current_target(ctx) == "A",
                  "the updater's own observation wins: rolled back: %r" % state)


def launcher(root):
    """T-P6, T-P2 (unit part): the seal walk refuses one file without +i, one group/world-writable directory, one foreign-owned inode, one
    escaping link; accepts the sealed fixture with the digest murage-commands computes; exec_slot with euid 0 exits 1 without exec'ing; the
    exec'd script path begins with /proc/self/fd/."""
    ctx, cp, calls, active = setup(root)
    paths = ctx["paths"]
    slot = os.path.join(paths["releases"], "A")
    fd = os.open(slot, m.SLOT_OPEN)
    try:
        check(launch.seal_walk_digest(fd, True) == m.seal_walk_digest(fd, True) == tree_digest(slot), "the launcher's seal walk digest equals murage-commands.tree digest")
    finally:
        os.close(fd)
    def refuses(name, prepare, restore):
        prepare()
        fd = os.open(slot, m.SLOT_OPEN)
        try:
            launch.seal_walk_digest(fd, True)
            check(False, name + ": refused")
        except launch.LayoutRefused as refused:
            check(refused.code == "slot_seal_failed", name + ": slot_seal_failed")
        finally:
            os.close(fd)
            restore()
    index = os.path.join(slot, "dist-server", "index.js")
    refuses("a file without +i", lambda: thaw(index), lambda: IMMUTABLE.freeze(index))
    bindir = os.path.join(slot, "bin")
    def writable():
        thaw(bindir); os.chmod(bindir, 0o775)
    def unwritable():
        os.chmod(bindir, 0o755); IMMUTABLE.freeze(bindir)
    refuses("a group-writable directory", writable, unwritable)
    def escaping():
        thaw(slot); os.symlink("../../etc/passwd", os.path.join(slot, "escape")); IMMUTABLE.freeze(slot)
    def unescaped():
        thaw(slot); os.unlink(os.path.join(slot, "escape")); IMMUTABLE.freeze(slot)
    refuses("a link escaping the slot", escaping, unescaped)
    # A symlink is never flagged (chattr cannot flag one; seal_tree skips links): an in-tree link without +i is accepted by both walks,
    # and one that escapes only by climbing through another link (bin/up -> .., top -> bin/up/..) is refused by both.
    def with_links():
        thaw(slot); thaw(bindir)
        os.symlink("../dist-server/index.js", os.path.join(bindir, "inside"))
        IMMUTABLE.freeze(bindir); IMMUTABLE.freeze(slot)
    def without_links():
        thaw(slot); thaw(bindir)
        os.unlink(os.path.join(bindir, "inside"))
        IMMUTABLE.freeze(bindir); IMMUTABLE.freeze(slot)
    with_links()
    fd = os.open(slot, m.SLOT_OPEN)
    try:
        check(launch.seal_walk_digest(fd, True) == m.seal_walk_digest(fd, True) == tree_digest(slot), "an in-tree symlink without +i is accepted by both seal walks")
    finally:
        os.close(fd)
    def chain_escape():
        thaw(slot); thaw(bindir)
        os.symlink("..", os.path.join(bindir, "up"))
        os.symlink("bin/up/..", os.path.join(slot, "top"))
        IMMUTABLE.freeze(bindir); IMMUTABLE.freeze(slot)
    def chain_unescaped():
        thaw(slot); thaw(bindir)
        os.unlink(os.path.join(bindir, "up")); os.unlink(os.path.join(slot, "top"))
        IMMUTABLE.freeze(bindir); IMMUTABLE.freeze(slot)
    refuses("a link escaping through another link", chain_escape, chain_unescaped)
    without_links()
    if os.geteuid() == 0:
        import pwd
        nobody = pwd.getpwnam("nobody")
        def foreign():
            thaw(index); os.chown(index, nobody.pw_uid, nobody.pw_gid); IMMUTABLE.freeze(index)
        def owned():
            thaw(index); os.chown(index, 0, 0); IMMUTABLE.freeze(index)
        refuses("an inode not owned by root", foreign, owned)
    fd = os.open(slot, m.SLOT_OPEN)
    try:
        check(launch.seal_walk_digest(fd, True) == tree_digest(slot), "the sealed fixture is accepted again")
    finally:
        os.close(fd)
    # exec_slot refuses euid 0 (or a uid-0 process) and never execs; as the test user it refuses a slot path that is not a slot.
    code = subprocess.run([sys.executable, "-I", "-c", "import importlib.machinery,importlib.util,os,sys\n"
                           "l=importlib.machinery.SourceFileLoader('L',sys.argv[1]);s=importlib.util.spec_from_loader(l.name,l);L=importlib.util.module_from_spec(s);l.exec_module(L)\n"
                           "os.getuid=lambda:0\nL.exec_slot('/bin/true',['/bin/true'],{})\nprint('EXECUTED')", launch.__file__], capture_output=True, text=True)
    check(code.returncode == 1 and "EXECUTED" not in code.stdout, "exec_slot with uid 0 exits 1 and does not exec")
    if os.geteuid() != 0:
        code = subprocess.run([sys.executable, "-I", "-c", "import importlib.machinery,importlib.util,os,sys\n"
                               "l=importlib.machinery.SourceFileLoader('L',sys.argv[1]);s=importlib.util.spec_from_loader(l.name,l);L=importlib.util.module_from_spec(s);l.exec_module(L)\n"
                               "L.exec_slot('/bin/true',['/bin/true','/opt/murage/dist-server/x.js'],{})\nprint('EXECUTED')", launch.__file__], capture_output=True, text=True)
        check(code.returncode == 1 and "EXECUTED" not in code.stdout, "exec_slot refuses a /opt/murage path that does not resolve under a release slot")
    source = open(launch.__file__).read()
    check('"/proc/self/fd/%d/%s" % (dirfd, SUPERVISOR)' in source and source.index("def drop_privileges") < source.index("def exec_supervisor"), "the supervisor is exec'd through the verified descriptor, after the drop")
    # start_gate hands back the live slot's own descriptor (the inode the seal walk read).
    try:
        launch.assert_root_ancestors(paths["releases"])
        check(False, "a world-writable ancestor (/tmp) is refused")
    except launch.Refused as refused:
        check(refused.reason == "home_layout_mismatch", "ancestor walk refuses a go-writable ancestor")
    slot_name, dirfd, _state = launch.start_gate(launcher_paths(paths), verify=active["signer"].verify, peer=lambda pid, uid: dict(active["client_peer"]), ancestors=False)
    try:
        check(slot_name == "A" and os.fstat(dirfd).st_ino == os.stat(slot).st_ino, "start_gate returns slot A's directory descriptor")
    finally:
        os.close(dirfd)


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
        if any(part in rel for part in (".claude", ".codex", ".grok", ".kimi-code", "secrets/", "Cookies", "/signin/")):
            check("data/" + rel not in names, "credential excluded: " + rel)
    check(not any("/signin" in n for n in names), "no engine sign-in store in the export")
    check("data/engine-homes/codex/bots/bot_1/state/notes.json" in names, "a bot's own engine state is exported")
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
            if field in CONTRACT.get("optionalPayloadFields", {}).get(kind, []):
                continue  # optional on the wire: an older control plane's command (without it) still runs
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
        upd = update_command(cp)
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
    # The recover unit carries the condition on the runner's own path; the home unit no longer does (murage-home-launch, image root code
    # that runs before any release byte, enforces the inhibition itself, which is what lets the updater start the home on its own grant
    # while holding it).
    with open(os.path.join(os.path.dirname(program), "murage-home-recover.service")) as handle:
        check("ConditionPathExists=!" + os.path.join(m.STATE, m.INHIBIT) + "\n" in handle.read(), "murage-home-recover.service honours the inhibition")
    with open(os.path.join(os.path.dirname(program), "murage-home.service")) as handle:
        unit = handle.read()
    check(not re.search(r"^ConditionPathExists=", unit, re.M) and "RestartPreventExitStatus=78 79\n" in unit, "murage-home.service leaves the inhibition to the launcher (exit 79 is not restarted)")
    with open(os.path.join(os.path.dirname(program), "murage-home-launch.py")) as handle:
        check('raise Refused("gate_phase")  # a reset/undo transition' in handle.read(), "the launcher refuses a start under the inhibition with nothing in flight")

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

PLACEHOLDERS = (".claude", ".codex", ".fuigo", ".grok", ".kimi-code", ".opencode")
CARRIED = (".claude", ".codex", ".grok", ".kimi-code")  # the placeholder names that are also engine credential names

def placeholders(root):
    """Astra preaudit cloud-home H1: a reset after a bot has run. The launcher has made every MASK_NAMES directory in the workspaces its
    turns bind immutable; the reset must move the credential-named ones into the new tree, delete the rest with the old tree, finish (never
    stay pending or keep the home stopped), freeze each placeholder again where it now is, and recover idempotently from a crash mid-carry."""
    ctx, cp, calls, active = setup(root)
    data = ctx["paths"]["data"]
    plant(data, "current")
    immutable = IMMUTABLE
    results["immutable"] = immutable.mode
    # A plain workspace, one in a repository, deep ones (once inside an unfrozen .claude folder), and a turn folder inside a .fuigo.
    workspaces = [os.path.join(data, "home/workspaces/bot_1/.fuigo/project"), os.path.join(data, "home/workspaces/bot_1"),
                  os.path.join(data, "home/workspaces/bot_1.extra/repo"), os.path.join(data, "home/workspaces/bot_2/a/b/c/d/e/f"),
                  os.path.join(data, "home/workspaces/bot_3/a/b/c/d/e/f/g/.claude/deep/project")]
    def place():
        rels = []
        for ws in workspaces:
            if not os.path.isdir(ws):
                os.makedirs(ws)
            if not os.path.exists(os.path.join(ws, "notes.md")):
                with open(os.path.join(ws, "notes.md"), "w") as handle:
                    handle.write("workspace file")
        for ws in workspaces:
            for name in PLACEHOLDERS:
                full = os.path.join(ws, name)
                if not os.path.isdir(full):
                    # The launcher makes them root 0555; root moves them regardless. Unprivileged, moving a directory to another
                    # parent needs write permission on it (its ".." entry changes), so the emulated run keeps them writable.
                    os.mkdir(full, 0o555 if name != ".claude" and os.geteuid() == 0 else 0o755)
                    if name == ".claude":  # an owner's repository .claude/ keeps its content, hidden from engines by the mask
                        with open(os.path.join(full, "settings.json"), "w") as handle:
                            handle.write('{"owner":true}')
                if not immutable.is_frozen(full):
                    immutable.freeze(full)
                rels.append(os.path.relpath(full, data))
        return rels
    def restored_placeholders(target):
        # The backup holds the empty placeholders that are not credential names (an earlier backup, made while they existed).
        for name in (".fuigo", ".opencode"):
            os.makedirs(os.path.join(target, data.lstrip("/"), "home/workspaces/bot_1", name), mode=0o555 if os.geteuid() == 0 else 0o755,
                        exist_ok=True)
    def outcome_checks(label, rels):
        check(m.HOME_UNIT in active["running"], label + ": the home started again")
        check(not m.recovery_pending(ctx) and not os.path.exists(os.path.join(ctx["paths"]["state"], "recovery-inhibit")), label + ": nothing pending")
        check(not os.path.exists(os.path.join(data, ".murage-reset")) or os.listdir(os.path.join(data, ".murage-reset")) == [], label + ": staging removed")
        for ws in workspaces:
            with open(os.path.join(ws, ".claude", "settings.json")) as handle:
                check(handle.read() == '{"owner":true}', label + ": the owner's .claude content is kept: " + ws)
        for rel in rels:
            full = os.path.join(data, rel)
            # Carried ones, and those the restored backup has again at the same place (bot_1's .fuigo and .opencode).
            if os.path.basename(rel) in CARRIED or os.path.dirname(rel) == "home/workspaces/bot_1":
                check(os.path.isdir(full) and immutable.is_frozen(full), label + ": placeholder frozen again in place: " + rel)
        after = tree(data)
        check(after["engine-homes/claudeAgent/signin/4/token"] == CLAUDE_TOKEN + "-signin", label + ": the engine sign-in store is kept")
        check(after["engine-homes/codex/bots/bot_1/signin/1/.codex/auth.json"].endswith('-bot"}}'), label + ": a bot's sign-in store is kept")
        check(after["home/work/report.md"] == "report restored", label + ": data from the backup")
    try:
        rels = place()
        ctx["run"] = FakeRestic(data, on_restore=restored_placeholders)
        ctx["paths"]["run"] = root
        rid = str(uuid.uuid4())
        cp.add("reset_from_backup", {"resetId": rid, "from": "last_good_backup", "snapshotFirst": True, "snapshotTag": "murage-pre-reset-" + rid,
                                     "keepSnapshotDays": 9})
        outcomes = m.poll_once(ctx)
        check(outcomes == [("reset_from_backup", "done")], "a reset after a bot has run finishes: %r" % outcomes)
        outcome_checks("reset", rels)
        # A crash mid-carry (twice: in the run and in its own recovery), then a restart of the runner: the recovery finishes it.
        rels = place()
        real_paths, listings = m.credential_paths, [0]
        def cut_short(root_, *a, **kw):
            found = real_paths(root_, *a, **kw)
            if root_.endswith("previous"):
                listings[0] += 1
                if listings[0] in (1, 3):  # each carry lists, moves one workspace placeholder, then finds the rest left and fails
                    return [r for r in found if r.startswith("home/workspaces/")][:1]
            return found
        m.credential_paths = cut_short
        rid2 = str(uuid.uuid4())
        cid2 = cp.add("reset_from_backup", {"resetId": rid2, "from": "last_good_backup", "snapshotFirst": True,
                                            "snapshotTag": "murage-pre-reset-" + rid2, "keepSnapshotDays": 9})
        try:
            check(m.poll_once(ctx) == [("reset_from_backup", "pending")], "a carry cut short is pending")
            record = m.read_swap(ctx, rid2, "reset")  # (those inside a credential folder move with it, frozen as they are)
            recorded = m.read_frozen(os.path.join(m.work_dir(ctx, rid2, "reset"), "frozen.json"))
            check(record["phase"] == "committed" and "frozen" not in record, "the swap record stays small: %r" % record)
            check(recorded == sorted(r for r in rels if "/.claude/" not in r), "every frozen placeholder is recorded: %r" % recorded)
            check(m.HOME_UNIT not in active["running"], "the home stays stopped")
            cp.pending = []
            ctx["sleep"] = lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())
            try:
                m.run(ctx, monotonic=lambda: 0)
            except KeyboardInterrupt:
                pass
        finally:
            m.credential_paths = real_paths
        check([a["outcome"] for a in cp.of("commands/ack") if a["commandId"] == cid2] == ["done"], "recovered: done once")
        outcome_checks("recovered reset", rels)
        check(not os.path.exists(m.work_dir(ctx, rid2, "reset")), "the previous tree is gone")
    finally:
        immutable.thaw_all(root)

def update_target(root):
    """The rollout controller's command names ONE sequence (payload.sequence): the home installs exactly it, is done when already on it, and
    refuses any other release the channel serves (sequence_mismatch) without stopping anything. Its updater reports installed sequence,
    lastResult and a Stuck code on update-state, on change and at the interval; an older control plane's 404 is tolerated; a command
    without a sequence still runs (older control plane)."""
    ctx, cp, calls, active = setup(root)
    signer = active["signer"]
    channel = served(ctx, root, ctx["paths"]["releases"])
    channel.update(make_release(root, "b" * 40, 2, signer))
    update_command(cp, sequence=3)
    _, err = stderr_of(lambda: m.poll_once(ctx))
    check("Self-service update refused: sequence_mismatch" in err and STOP not in calls, "channel serves 2, command wants 3: refused, nothing stopped: %r" % err)
    check(m.read_update_state(ctx)["installed"]["sequence"] == 1 and m.read_update_state(ctx)["inflight"] is None, "nothing installed")
    check([a["outcome"] for a in cp.of("commands/ack")] == ["failed"], "reported failed")
    update_command(cp, sequence=2)
    check(m.poll_once(ctx) == [("update_software", "done")] and m.read_update_state(ctx)["installed"]["sequence"] == 2, "channel serves 2, command wants 2: installed")
    channel.clear(); channel.update(make_release(root, "c" * 40, 3, signer))
    calls.clear()
    update_command(cp, sequence=2)
    check(m.poll_once(ctx) == [("update_software", "done")] and STOP not in calls and m.read_update_state(ctx)["installed"]["sequence"] == 2,
          "already on the target sequence while the channel moved on: done, the newer release is not installed")
    update_command(cp, sequence=3)
    check(m.poll_once(ctx) == [("update_software", "done")] and m.read_update_state(ctx)["installed"]["sequence"] == 3, "command wants 3: installed")
    for bad in (0, -1, "3", True, 1.5):
        try:
            m.SHAPES["update_software"]({"keep": ["files", "settings", "logins"], "reason": "rollout", "sequence": bad})
            check(False, "sequence %r refused" % (bad,))
        except m.Unsupported:
            pass
    m.SHAPES["update_software"]({"keep": ["files", "settings", "logins"], "reason": "rollout", "sequence": 4})
    try:
        m.SHAPES["update_software"]({"keep": ["files", "settings", "logins"], "reason": "customer"})
        check(False, "a command with no sequence refused")
    except m.Unsupported:
        pass
    channel.clear(); channel.update(make_release(root, "d" * 40, 4, signer))
    calls.clear()
    cp.add("update_software", {"keep": ["files", "settings", "logins"], "reason": "customer"})
    check(m.poll_once(ctx) == [("update_software", "unsupported")] and m.read_update_state(ctx)["installed"]["sequence"] == 3,
          "no sequence (an older control plane): refused, the channel's unpromoted release is not installed")
    update_command(cp, sequence=4)
    check(m.poll_once(ctx) == [("update_software", "done")] and m.read_update_state(ctx)["installed"]["sequence"] == 4, "the command that names 4 installs it")
    # Reporting.
    state = m.read_update_state(ctx)
    check(set(CONTRACT["homeBodies"]["update-state"]) == {"generation", "installedSequence", "lastResult", "stuck"}, "the contract names the body")
    m.report_update_state(ctx, None)
    body = cp.of("update-state")[-1]
    check(set(body) == set(CONTRACT["homeBodies"]["update-state"]) and set(body["lastResult"]) == set(CONTRACT["homeBodies"]["updateLastResult"]), "body shape is the contract's")
    check(body["installedSequence"] == 4 and body["generation"] == ctx["binding"]["generation"] and body["stuck"] is None
          and body["lastResult"] == {"commandId": state["lastResult"]["commandId"], "outcome": "done", "reason": None}, "reports the journal: %r" % body)
    sent = len(cp.of("update-state"))
    m.report_update_state(ctx, None)
    check(len(cp.of("update-state")) == sent, "unchanged and inside the interval: not sent again")
    m.report_update_state(ctx, "rollback_stop")
    check(len(cp.of("update-state")) == sent + 1 and cp.of("update-state")[-1]["stuck"] == "rollback_stop", "a Stuck code is a change: sent")
    real_now = ctx["now"]
    ctx["now"] = lambda: real_now() + (m.UPDATE_REPORT_SECONDS + 1) * 1000
    m.report_update_state(ctx, "rollback_stop")
    check(len(cp.of("update-state")) == sent + 2, "unchanged past the interval: sent again")
    ctx["now"] = real_now
    # A control plane without the route (404) is tolerated and not hammered; other failures are retried on the next loop.
    ctx["update_reported"] = None
    def old_control_plane(binding, operation, body=None):
        calls.append(("request", operation))
        raise m.urllib.error.HTTPError("https://admin.murage.test", 404, "not found", {}, None)
    ctx["request"] = old_control_plane
    m.report_update_state(ctx, None); m.report_update_state(ctx, None)
    check([c for c in calls if c == ("request", "update-state")] == [("request", "update-state")], "404: asked once, then left alone until the interval")
    ctx["update_reported"] = None
    def down(binding, operation, body=None):
        calls.append(("down", operation))
        raise OSError("network down")
    ctx["request"] = down
    m.report_update_state(ctx, None); m.report_update_state(ctx, None)
    check([c for c in calls if c == ("down", "update-state")] == [("down", "update-state")] * 2, "network failure: retried on the next loop")
    # The drive reports a Stuck code to the loop.
    ctx["request"] = cp
    check(m.drive_pending_update(ctx) is None, "nothing in flight: no stuck code")

SCENARIOS = {"update-target": update_target, "placeholders": placeholders, "restart": restart, "safe-mode": safe_mode, "refusals": refusals, "interrupted": interrupted, "update": update,
             "update-cuts": update_cuts, "update-phases": update_phases, "update-pending": update_pending, "gate": gate, "transition": transition,
             "trust": trust, "forged": forged, "launcher": launcher, "logs": logs,
             "export": export, "swap-recovery": swap_recovery, "reset": reset_roundtrip, "reset-loop": reset_loop,
             "contract": contract, "deadline": deadline, "startup-recovery": startup_recovery, "unacked-retry": unacked_retry,
             "reset-safety": reset_safety, "carry": carry, "auth-state": auth_state, "upload": upload, "carry-pending": carry_pending,
             "carry-blocked": carry_blocked, "export-deadline": export_deadline, "inhibit": inhibit,
             "durability": durability}

with tempfile.TemporaryDirectory(prefix="murage-commands-") as root:
    try:
        SCENARIOS[scenario](root)
    finally:
        IMMUTABLE.thaw_all(root)
print(json.dumps({"ok": True, "scenario": scenario, **results}))
