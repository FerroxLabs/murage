#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""murage-home-launch: the image-owned root launcher of murage-home.service (LANE-G-UPDATE-STATE-MACHINE r3 sec. 1, 3; A1).

Everything that must happen as uid 0 for a home start happens here, in image code installed by build-image.sh into
/usr/local/libexec (root 0755, FS_IMMUTABLE_FL), never in bytes from a release slot: the volume binding, the engine homes and the
approval broker directory (ports of server/cloud-home/home-volume-spec.ts, the executable spec), then the trust root, the update
journal, the live slot's seal and signed manifest through ONE directory descriptor (never a path re-resolved), the phase-aware
layout predicate (A1), the start gate (a one-shot grant from murage-commands while an update is in flight), the privilege drop and
the exec of the slot supervisor through that descriptor (/proc/self/fd/<D>/dist-server/cloud-home-supervisor.js) with an environment
built from scratch. No release-slot byte ever executes with uid 0: exec_slot refuses while euid 0.

Exit codes: 78 keeps its meaning (stale generation, from murage-enroll, never raised here); 79 = refused by the gate, the seal, the
layout or the trust root (one fixed reason token on stderr: gate_phase | gate_denied | home_layout_mismatch | slot_seal_failed |
trust_root_invalid; murage-home.service has RestartPreventExitStatus=78 79, so the updater or an operator acts); 1 = error.
"""
import errno
import fcntl
import hashlib
import json
import os
import re
import shlex
import socket
import stat
import struct
import sys

RELEASES = "/opt/murage-releases"
TRUST = "/usr/lib/murage-home/trust"
UPDATE_STATE = "/var/lib/murage-update"
INHIBIT = "/var/lib/murage-home/recovery-inhibit"
GATE_SOCK = "/run/murage-update/gate.sock"
NODE = "/usr/local/bin/node"
HOME_USER = "murage"
IDENTITY = "/etc/murage-home/identity.json"
HOME_ENV = "/etc/murage-home/home.env"
DATA = "/data"
ENGINE_HOMES = "/data/engine-homes"
BROKER_DIR = "/data/broker"
SUPERVISOR = "dist-server/cloud-home-supervisor.js"
COMMANDS_CGROUP = "0::/system.slice/murage-commands.service"
EXIT_REFUSED = 79
# server/cloud-home/turn-process.ts CLOUD_ENGINES: one distinct group per engine in identity.json.
ENGINES = ("claudeAgent", "codex", "pi", "antigravity", "grokAgent", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "customAcp",
           "fuigoAgent", "hermesAgent", "opencodeGo", "qwenAgent")
# deploy/cloud-home/murage-enroll home_fields: what home.env may carry, and what the supervisor's boot contract needs.
HOME_ENV_REQUIRED = ("MURAGE_CLOUD_ROLE", "MURAGE_CLOUD_MACHINE_ID", "MURAGE_CLOUD_ADMIN_URL", "MURAGE_PUBLIC_ORIGIN")
HOME_ENV_ALLOWED = HOME_ENV_REQUIRED + ("MURAGE_SITE_ORIGIN",)
PATHS = {"releases": RELEASES, "trust": TRUST, "update_state": UPDATE_STATE, "inhibit": INHIBIT, "gate": GATE_SOCK}


class Refused(Exception):
    """A start this launcher refuses: reason is the fixed token printed to stderr (exit 79)."""
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


# ==== shared with deploy/cloud-home/murage-home-launch.py: byte-identical (T-S4) ====
SLOTS = ("A", "B")
FS_IOC_GETFLAGS, FS_IOC_SETFLAGS, FS_IMMUTABLE_FL = 0x80086601, 0x40086602, 0x00000010
SLOT_OPEN = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
SEAL_OWNER = 0  # the owner every sealed inode must have; a test run without root models it as its own uid
FILE_OPEN = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
MANIFEST_FIELDS = ("format", "sequence", "revision", "arch", "archive", "bytes", "sha256", "treeSha256", "launcherAbi")
JOURNAL_FIELDS = ("format", "installed", "inflight", "lastResult")
INSTALLED_FIELDS = ("slot", "sequence", "revision")
INFLIGHT_FIELDS = ("commandId", "slot", "sequence", "revision", "phase", "verifyAttempts", "rollbackAttempts", "restored", "startedAt",
                   "deadline", "driveId", "reason")
RESULT_FIELDS = ("commandId", "outcome", "reason")
MAX_SAFE_INT = 9007199254740991


class LayoutRefused(Exception):
    """code: home_layout_mismatch | slot_seal_failed, the fixed token the launcher prints and the updater's Stuck carries."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def inode_flags(fd):
    """The FS_IOC_GETFLAGS word; 0 on a filesystem without inode flags (nothing there can be immutable)."""
    flags = bytearray(8)
    try:
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, flags)
    except OSError as error:
        if error.errno in (errno.ENOTTY, errno.EOPNOTSUPP, errno.EINVAL):
            return 0
        raise
    return int.from_bytes(flags[:4], sys.byteorder)


def manifest_json(raw):
    """JSON with duplicate fields and non-finite numbers refused."""
    def pairs(items):
        result = {}
        for name, value in items:
            if name in result:
                raise ValueError("Duplicate field")
            result[name] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _v: (_ for _ in ()).throw(ValueError("Invalid number")))


def _bounded(value, minimum, maximum=MAX_SAFE_INT):
    return type(value) is int and minimum <= value <= maximum


def parse_manifest(raw, arch):
    """A release manifest (v3), strictly: exact field set, shapes and bounds. The signature is the caller's business. A manifest of
    another format raises ValueError("release_format"), anything else ValueError("release_manifest")."""
    manifest = manifest_json(raw.decode("utf-8"))
    if not isinstance(manifest, dict) or set(manifest) != set(MANIFEST_FIELDS):
        raise ValueError("release_manifest")
    if manifest["format"] != "murage-cloud-home-release-v3":
        raise ValueError("release_format")
    if (not _bounded(manifest["sequence"], 1) or not isinstance(manifest["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", manifest["revision"])
            or manifest["arch"] != arch or not isinstance(manifest["archive"], str)
            or not re.fullmatch(r"murage-cloud-home-[A-Za-z0-9._-]{1,100}\.tar\.gz", manifest["archive"])
            or not _bounded(manifest["bytes"], 1, 4 << 30) or not isinstance(manifest["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"])
            or not isinstance(manifest["treeSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["treeSha256"])
            or not isinstance(manifest["launcherAbi"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", manifest["launcherAbi"])):
        raise ValueError("release_manifest")
    return manifest


def parse_update_state(raw):
    """The journal (state.json, v3), strictly: anything but the exact shape raises ValueError."""
    state = manifest_json(raw.decode("utf-8"))
    if not isinstance(state, dict) or set(state) != set(JOURNAL_FIELDS) or state["format"] != "murage-cloud-home-update-state-v3":
        raise ValueError("update_state")
    installed = state["installed"]
    if (not isinstance(installed, dict) or set(installed) != set(INSTALLED_FIELDS) or installed["slot"] not in ("A", "B")
            or not _bounded(installed["sequence"], 1) or not isinstance(installed["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", installed["revision"])):
        raise ValueError("update_state")
    inflight = state["inflight"]
    if inflight is not None:
        if (not isinstance(inflight, dict) or set(inflight) != set(INFLIGHT_FIELDS)
                or not isinstance(inflight["commandId"], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", inflight["commandId"])
                or inflight["slot"] not in ("A", "B") or not _bounded(inflight["sequence"], 1)
                or not isinstance(inflight["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", inflight["revision"])
                or inflight["phase"] not in ("installing", "installed", "flip", "verify", "rollback")
                or not _bounded(inflight["verifyAttempts"], 0, 2) or not _bounded(inflight["rollbackAttempts"], 0, 3)
                or type(inflight["restored"]) is not bool or not _bounded(inflight["startedAt"], 0) or not _bounded(inflight["deadline"], 1)
                or not isinstance(inflight["driveId"], str) or not re.fullmatch(r"[0-9a-f]{32}", inflight["driveId"])
                or not (inflight["reason"] is None or (isinstance(inflight["reason"], str) and re.fullmatch(r"[a-z_]{1,64}", inflight["reason"])))):
            raise ValueError("update_state")
    result = state["lastResult"]
    if result is not None:
        if (not isinstance(result, dict) or set(result) != set(RESULT_FIELDS)
                or not isinstance(result["commandId"], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", result["commandId"])
                or result["outcome"] not in ("done", "failed")
                or not (result["reason"] is None or (isinstance(result["reason"], str) and re.fullmatch(r"[a-z_]{1,64}", result["reason"])))):
            raise ValueError("update_state")
    return state


def read_trust(trust):
    """The image-owned trust root: a 0700 root directory carrying FS_IMMUTABLE_FL, the Ed25519 public key, release.json (channel, the
    image's sequence floor, the image revision, the launcher ABI) and launcher-abi (the same token). Anything else raises."""
    info = os.lstat(trust)
    fd = os.open(trust, SLOT_OPEN)
    try:
        flags = inode_flags(fd)
    finally:
        os.close(fd)
    if not stat.S_ISDIR(info.st_mode) or (info.st_uid != 0 and os.geteuid() == 0) or stat.S_IMODE(info.st_mode) != 0o700 or not flags & FS_IMMUTABLE_FL:
        raise ValueError("trust_root")
    key = os.path.join(trust, "release-public-key.pem")
    key_info = os.lstat(key)
    if not stat.S_ISREG(key_info.st_mode) or key_info.st_mode & 0o022 or key_info.st_size == 0 or key_info.st_size > 4096:
        raise ValueError("trust_root")
    fd = os.open(os.path.join(trust, "release.json"), FILE_OPEN)
    with os.fdopen(fd, "rb") as handle:
        raw = handle.read(4097)
    config = manifest_json(raw.decode("utf-8")) if len(raw) <= 4096 else None
    if not isinstance(config, dict) or set(config) != {"channelUrl", "minimumSequence", "imageRevision", "launcherAbi"}:
        raise ValueError("trust_root")
    if (not isinstance(config["channelUrl"], str) or not _bounded(config["minimumSequence"], 1)
            or not isinstance(config["imageRevision"], str) or not re.fullmatch(r"[0-9a-f]{40}", config["imageRevision"])
            or not isinstance(config["launcherAbi"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", config["launcherAbi"])):
        raise ValueError("trust_root")
    fd = os.open(os.path.join(trust, "launcher-abi"), FILE_OPEN)
    with os.fdopen(fd, "rb") as handle:
        abi = handle.read(256)
    if abi.decode("utf-8", errors="replace").strip() != config["launcherAbi"]:
        raise ValueError("trust_root")
    return {"channelUrl": config["channelUrl"], "key": key, "minimumSequence": config["minimumSequence"], "imageRevision": config["imageRevision"],
            "launcherAbi": config["launcherAbi"]}


def links_stay_inside(links):
    """Resolves every symlink component by component through the other links of the tree (rel path -> target text); False when any
    link, followed through the links it crosses, leaves the tree or loops. A lexical check alone misses `a/b/l/../..` where l is
    itself a link that climbs to the top."""
    for rel, target in links.items():
        parent = rel.split("/")[:-1]
        stack, pending, hops = list(parent), target.split("/"), 0
        while pending:
            part = pending.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not stack:
                    return False
                stack.pop()
                continue
            stack.append(part)
            crossed = "/".join(stack)
            if crossed in links:
                hops += 1
                if hops > 40:
                    return False
                stack.pop()
                pending = links[crossed].split("/") + pending
    return True


def seal_walk_digest(dirfd, sealed):
    """The canonical digest of the tree under dirfd, read only through O_NOFOLLOW descriptors (a path is never re-resolved): sorted
    relative paths; per entry type NUL path NUL mode NUL, then size NUL content-sha256 NUL for a file or the link target NUL for a
    symlink (a symlink is never flagged, sealed or not, and is resolved through the other links of the tree); modes normalised to 0755/0644 as safe_extract writes them. With sealed, every directory and regular file (the root
    included) must be uid 0, not group/world writable and carry FS_IMMUTABLE_FL, and no symlink may point outside the tree; a failure
    raises LayoutRefused("slot_seal_failed"). An entry of any other type is refused the same way."""
    entries = []

    def refuse():
        raise LayoutRefused("slot_seal_failed")

    def inspect(fd, info):
        if sealed and (info.st_uid != SEAL_OWNER or info.st_mode & 0o022 or not inode_flags(fd) & FS_IMMUTABLE_FL):
            refuse()

    def walk(fd, prefix):
        inspect(fd, os.fstat(fd))
        for name in sorted(os.listdir(fd)):
            rel = prefix + name
            info = os.lstat(name, dir_fd=fd)
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(name, dir_fd=fd)
                resolved = os.path.normpath(os.path.join(os.path.dirname(rel), target))
                if "\0" in target or target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                    refuse()
                entries.append(("l", rel, target))
            elif stat.S_ISDIR(info.st_mode):
                child = os.open(name, SLOT_OPEN, dir_fd=fd)
                try:
                    walk(child, rel + "/")
                finally:
                    os.close(child)
                entries.append(("d", rel, "0755"))
            elif stat.S_ISREG(info.st_mode):
                child = os.open(name, FILE_OPEN, dir_fd=fd)
                try:
                    detail = os.fstat(child)
                    if not stat.S_ISREG(detail.st_mode):
                        refuse()
                    inspect(child, detail)
                    digest = hashlib.sha256()
                    with os.fdopen(child, "rb", closefd=False) as stream:
                        for chunk in iter(lambda: stream.read(1 << 20), b""):
                            digest.update(chunk)
                finally:
                    os.close(child)
                entries.append(("f", rel, "0755" if detail.st_mode & 0o111 else "0644", str(detail.st_size), digest.hexdigest()))
            else:
                refuse()

    walk(dirfd, "")
    if not links_stay_inside({entry[1]: entry[2] for entry in entries if entry[0] == "l"}):
        refuse()
    total = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item[1]):
        total.update("\0".join(entry).encode() + b"\0")
    return total.hexdigest()


def verified_slot(env, name):
    """Slot `name` through its own descriptor: sealed (seal walk), its stored manifest signature-verified (env.manifest) and the tree
    digest equal to the manifest's treeSha256. Returns the manifest; raises LayoutRefused."""
    try:
        fd = env.open_slot(name)
    except OSError:
        raise LayoutRefused("home_layout_mismatch") from None
    try:
        digest = seal_walk_digest(fd, True)
    finally:
        os.close(fd)
    try:
        manifest = env.manifest(name)
    except (OSError, ValueError):
        raise LayoutRefused("home_layout_mismatch") from None
    if manifest["treeSha256"] != digest:
        raise LayoutRefused("slot_seal_failed")
    return manifest


def layout_ok(state, current, env):
    """[A1] The phase-aware layout predicate, one function in murage-home-launch and murage-commands. state: the strict journal;
    current: what the `current` link names; env: open_slot(name) -> dirfd, manifest(name) -> the signature-verified stored manifest,
    trust -> {"minimumSequence", "launcherAbi"}. Committed group (no update in flight, or one before the flip): `current` is the
    installed slot, sealed, and its signed sequence is the journal's and at or above the image floor. Transition group (flip, verify,
    rollback): `current` is within what the phase allows, the candidate differs from the installed slot, and BOTH slots are sealed and
    matched to their own signed manifests, the candidate's to the in-flight record, the trust ABI and the sequence floor. Returns
    {slot: manifest} for the slots it verified; raises LayoutRefused(home_layout_mismatch | slot_seal_failed) for any other shape."""
    installed, inflight = state["installed"], state["inflight"]
    live = installed["slot"]
    if current not in ("A", "B"):
        raise LayoutRefused("home_layout_mismatch")
    phase = inflight["phase"] if inflight is not None else None
    if phase in (None, "installing", "installed"):
        if current != live:
            raise LayoutRefused("home_layout_mismatch")
        committed = verified_slot(env, live)
        if committed["sequence"] != installed["sequence"] or committed["sequence"] < env.trust["minimumSequence"]:
            raise LayoutRefused("home_layout_mismatch")
        return {live: committed}
    candidate = inflight["slot"]
    allowed = {"flip": (live, candidate), "verify": (candidate,), "rollback": (live,) if inflight["restored"] else (live, candidate)}
    if candidate == live or phase not in allowed or current not in allowed[phase]:
        raise LayoutRefused("home_layout_mismatch")
    committed = verified_slot(env, live)
    if committed["sequence"] != installed["sequence"] or committed["sequence"] < env.trust["minimumSequence"]:
        raise LayoutRefused("home_layout_mismatch")
    incoming = verified_slot(env, candidate)
    if (incoming["sequence"] != inflight["sequence"] or incoming["revision"] != inflight["revision"] or incoming["launcherAbi"] != env.trust["launcherAbi"]
            or incoming["sequence"] <= max(env.trust["minimumSequence"], committed["sequence"])):
        raise LayoutRefused("home_layout_mismatch")
    return {live: committed, candidate: incoming}
# ==== end shared ====


# ---- ports of server/cloud-home/home-volume-spec.ts (the TypeScript is the spec; T-P5 diffs the resulting trees) ---------

def parse_home_identity(value):
    """The image-owned identity file: service uid/gid, the turn and proxy ids, one distinct group per cloud engine."""
    def valid(item):
        return type(item) is int and item >= 1
    if not isinstance(value, dict) or not all(valid(value.get(name)) for name in ("uid", "gid", "turnGid", "proxyUid", "proxyGid")):
        raise ValueError("Invalid home service identity")
    gids = value.get("engineGids")
    if not isinstance(gids, dict):
        raise ValueError("Invalid home service identity")
    taken = {value["gid"], value["turnGid"], value["proxyGid"]}
    for engine in ENGINES:
        gid = gids.get(engine)
        if not valid(gid) or gid in taken:
            raise ValueError("Invalid home service identity")
        taken.add(gid)
    return value


def read_identity(path=IDENTITY):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError("Invalid home service identity")
        return parse_home_identity(json.loads(handle.read(65536)))


def _plain_directory(path):
    info = os.lstat(path)
    return stat.S_ISDIR(info.st_mode)


def validate_volume_marker(info, value, machine_id):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 130 or value != machine_id + "\n":
        raise ValueError("Home volume belongs to another machine or its binding is invalid")


def assert_unbound_volume_empty(data_dir):
    if not os.path.exists(os.path.join(data_dir, ".murage-home-machine")) and any(name != "lost+found" for name in os.listdir(data_dir)):
        raise ValueError("Unbound home volume is not empty")


def prepare_health_probe_dir(data_dir):
    """deploy/cloud-home/murage-control DATA_PROBE_DIR: root:root 0700 at the top of the bound volume, made as root before the drop; the
    final component is created with mkdir (never through a link) and opened O_NOFOLLOW|O_DIRECTORY, owner and mode set on that descriptor;
    a link, a non-directory or a directory on another device is refused."""
    path = os.path.join(data_dir, ".murage-health")
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise ValueError("Invalid home storage directory") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_dev != os.stat(data_dir).st_dev:
            raise ValueError("Invalid home storage directory")
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def bind_home_volume(data_dir, machine_id, uid, gid, proxy_uid, proxy_gid):
    """Port of bindHomeVolume: the machine marker (created O_EXCL|O_NOFOLLOW 0600 or validated), /data root:murage 1771 (the shared
    data-dir lease lives beside the data folder; the sticky bit keeps the server uid from renaming what it does not own), the storage
    directories with their owners and modes, then the health probe directory."""
    os.makedirs(data_dir, mode=0o711, exist_ok=True)
    if not _plain_directory(data_dir):
        raise ValueError("Home volume must be a directory")
    assert_unbound_volume_empty(data_dir)
    marker = os.path.join(data_dir, ".murage-home-machine")
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, (machine_id + "\n").encode())
        finally:
            os.close(fd)
    except FileExistsError:
        pass
    fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        validate_volume_marker(os.fstat(fd), os.read(fd, 131).decode("utf-8", errors="replace"), machine_id)
    finally:
        os.close(fd)
    os.chown(data_dir, 0, gid)
    os.chmod(data_dir, 0o1771)
    for name, owner, group, mode in (("home", uid, gid, 0o700), ("home/secrets", uid, gid, 0o700), ("server-home", uid, gid, 0o700),
                                     ("proxy", uid, proxy_gid, 0o2750), ("caddy", proxy_uid, proxy_gid, 0o700), ("browser", 0, 0, 0o711)):
        path = os.path.join(data_dir, name)
        os.makedirs(path, mode=0o700, exist_ok=True)
        if not _plain_directory(path):
            raise ValueError("Invalid home storage directory")
        os.chown(path, owner, group)
        os.chmod(path, mode)
    prepare_health_probe_dir(data_dir)


def prepare_engine_homes(identity, root=ENGINE_HOMES):
    """Port of prepareEngineHomes: root:root 0711, each engine home and its tmp root:murage-eng-<engine> 2770."""
    os.makedirs(root, mode=0o711, exist_ok=True)
    if not _plain_directory(root):
        raise ValueError("Invalid engine home root")
    os.chown(root, 0, 0)
    os.chmod(root, 0o711)
    for engine in ENGINES:
        for directory in (os.path.join(root, engine), os.path.join(root, engine, "tmp")):
            os.makedirs(directory, mode=0o2770, exist_ok=True)
            if not _plain_directory(directory):
                raise ValueError("Invalid engine home directory")
            os.chown(directory, 0, identity["engineGids"][engine])
            os.chmod(directory, 0o2770)


def prepare_broker_dir(identity, directory=BROKER_DIR):
    """Port of prepareBrokerDir: root:murage-turn 3770, setgid plus the sticky bit (a turn cannot unlink a socket it does not own), outside every engine home."""
    os.makedirs(directory, mode=0o3770, exist_ok=True)
    if not _plain_directory(directory):
        raise ValueError("Invalid engine home directory")
    os.chown(directory, 0, identity["turnGid"])
    os.chmod(directory, 0o3770)


# ---- the live slot, the trust root and the layout predicate (r3 sec. 1.4, A1) ---------------------------------------------

def assert_root_ancestors(releases=RELEASES):
    """/opt/murage-releases, /opt and /: root-owned, not group/world writable, not links (today's assertImmutableCode loop)."""
    path = releases
    while True:
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != SEAL_OWNER or info.st_mode & 0o022:
            raise Refused("home_layout_mismatch")
        if path == os.path.dirname(path):
            return
        path = os.path.dirname(path)


class SlotEnv:
    """layout_ok's view: a slot opened by name relative to the releases directory's descriptor (O_DIRECTORY|O_NOFOLLOW), its stored
    manifest signature-verified against the trust key, the trust floor and ABI."""
    def __init__(self, paths, trust, verify, keep=None):
        self.paths, self.trust, self.verify, self.keep = paths, trust, verify, keep
        self.walked, self.kept = [], None

    def open_slot(self, name):
        releases = os.open(self.paths["releases"], SLOT_OPEN)
        try:
            fd = os.open(name, SLOT_OPEN, dir_fd=releases)
        finally:
            os.close(releases)
        self.walked.append(name)
        if name == self.keep and self.kept is None:
            self.kept = os.dup(fd)  # the same open directory (same inode) the seal walk reads: what the supervisor is exec'd through
        return fd

    def manifest(self, name):
        raw = read_small(os.path.join(self.paths["update_state"], "manifests", name + ".json"), 65536)
        signature = read_small(os.path.join(self.paths["update_state"], "manifests", name + ".sig"), 128)
        if len(signature) != 64 or not self.verify(raw, signature, self.trust["key"]):
            raise ValueError("release_signature")
        return parse_manifest(raw, os.uname().machine)


def read_small(path, limit):
    fd = os.open(path, FILE_OPEN)
    with os.fdopen(fd, "rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("oversize")
    return raw


def verify_signature(raw, signature, key):
    """Ed25519 over the raw bytes with the image's OpenSSL 3 (openssl pkeyutl -rawin), the same check murage-commands makes."""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory(prefix="murage-launch-") as work:
        for name, value in (("manifest", raw), ("signature", signature)):
            with open(os.path.join(work, name), "wb") as handle:
                handle.write(value)
        try:
            result = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-verify", "-pubin", "-inkey", key, "-rawin", "-in", os.path.join(work, "manifest"),
                                     "-sigfile", os.path.join(work, "signature")], stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                                    env={"PATH": "/usr/bin:/bin"}, check=False)
        except (OSError, subprocess.SubprocessError):
            return False
    return result.returncode == 0 and b"Signature Verified Successfully" in result.stdout


def current_slot(releases):
    """What `current` names, read relative to the releases directory (O_DIRECTORY|O_NOFOLLOW); must be a link to A or B."""
    fd = os.open(releases, SLOT_OPEN)
    try:
        info = os.lstat("current", dir_fd=fd)
        if not stat.S_ISLNK(info.st_mode):
            raise Refused("home_layout_mismatch")
        target = os.readlink("current", dir_fd=fd)
    except OSError:
        raise Refused("home_layout_mismatch") from None
    finally:
        os.close(fd)
    if target not in SLOTS:
        raise Refused("home_layout_mismatch")
    return target


def peer_facts(pid, uid):
    """The gate server's identity as this client sees it: uid from SO_PEERCRED, the cgroup line from /proc."""
    with open("/proc/%d/cgroup" % pid, encoding="ascii") as stream:
        cgroup = stream.read(4096).strip()
    return {"uid": uid, "cgroup": cgroup}


def ask_gate(gate_sock, slot, peer=peer_facts):
    """One request to murage-commands' gate: the peer must be uid 0 in murage-commands.service's cgroup (SO_PEERCRED both ways); the
    answer is `grant` for exactly this slot, once. Anything else (no socket, another peer, deny) refuses the start: gate_denied."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(10)
            client.connect(gate_sock)
            pid, uid, _gid = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            facts = peer(pid, uid)
            if facts["uid"] != 0 or facts["cgroup"] != COMMANDS_CGROUP:
                raise Refused("gate_denied")
            client.sendall(json.dumps({"slot": slot}).encode())
            client.shutdown(socket.SHUT_WR)
            answer = client.recv(64)
    except OSError:
        raise Refused("gate_denied") from None
    if answer != b"grant\n":
        raise Refused("gate_denied")


def gate_decision(state, inhibit_present, current, gate_sock, peer=peer_facts):
    """r3 sec. 3, the launcher side, after layout_ok accepted `current` for the journal's phase. Returns when slot code may start;
    raises Refused(gate_phase | gate_denied) otherwise. No journal field produces a start: in verify and rollback(restored) the only
    way through is a live grant from murage-commands for this slot."""
    inflight = state["inflight"]
    if inflight is None:
        if inhibit_present:
            raise Refused("gate_phase")  # a reset/undo transition, or the instant before the updater lifts the inhibit after its commit
        return
    phase = inflight["phase"]
    if phase == "installing" and not inhibit_present:
        return  # the live slot is untouched by construction (layout_ok already required current == installed.slot)
    if phase == "verify" or (phase == "rollback" and inflight["restored"]):
        ask_gate(gate_sock, current, peer)
        return
    raise Refused("gate_phase")


def start_gate(paths=PATHS, verify=verify_signature, peer=peer_facts, ancestors=True):
    """Trust root, journal, `current`, the phase-aware predicate (both slots in a transition), then the gate. Returns
    (slot, dirfd, state): dirfd is the live slot's descriptor, the one the supervisor is exec'd through; nothing is re-resolved.
    ancestors: the root-owned, not group/world-writable walk up from the releases directory (a fixture tree under /tmp cannot pass it
    and checks assert_root_ancestors on its own)."""
    try:
        trust = read_trust(paths["trust"])
    except (OSError, ValueError):
        raise Refused("trust_root_invalid") from None
    try:
        state = parse_update_state(read_small(os.path.join(paths["update_state"], "state.json"), 65536))
    except (OSError, ValueError):
        raise Refused("home_layout_mismatch") from None
    if ancestors:
        assert_root_ancestors(paths["releases"])
    current = current_slot(paths["releases"])
    env = SlotEnv(paths, trust, verify, keep=current)
    try:
        layout_ok(state, current, env)
    except LayoutRefused as refused:
        if env.kept is not None:
            os.close(env.kept)
        raise Refused(refused.code) from None
    try:
        gate_decision(state, os.path.lexists(paths["inhibit"]), current, paths["gate"], peer)
    except Refused:
        os.close(env.kept)
        raise
    return current, env.kept, state


# ---- the drop and the exec ----------------------------------------------------------------------------------------------

def read_home_env(path=HOME_ENV):
    """home.env (written by murage-enroll), parsed like murage-enroll.home_fields: an allowlist of names, every required one present."""
    fd = os.open(path, FILE_OPEN)
    with os.fdopen(fd, "r", encoding="utf-8") as handle:
        raw = handle.read(65536)
    values = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        words = shlex.split(line, comments=True)
        if len(words) != 1 or "=" not in words[0]:
            raise ValueError("Invalid home metadata")
        name, value = words[0].split("=", 1)
        if name not in HOME_ENV_ALLOWED or name in values or not value or len(value) > 2048:
            raise ValueError("Invalid home metadata")
        values[name] = value
    if any(name not in values for name in HOME_ENV_REQUIRED):
        raise ValueError("Invalid home metadata")
    return values


def supervisor_env(home_env, slot, identity, safe_mode, releases=RELEASES):
    """The node environment, built from scratch: never the inherited one (no NODE_OPTIONS, nothing systemd or a shell set)."""
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "MURAGE_CLOUD_SECRETS_FD": "3", "MURAGE_RELEASE_ROOT": releases + "/" + slot,
           "MURAGE_HOME_IDENTITY": json.dumps(identity, sort_keys=True, separators=(",", ":"))}
    env.update(home_env)
    if safe_mode:
        env["MURAGE_SAFE_MODE"] = "1"
    return env


def drop_privileges(identity, user=HOME_USER):
    os.initgroups(user, identity["gid"])
    os.setgid(identity["gid"])
    os.setuid(identity["uid"])
    if os.getuid() != identity["uid"] or os.geteuid() != identity["uid"] or os.getgid() != identity["gid"] or os.getegid() != identity["gid"]:
        os._exit(1)


def exec_slot(path, argv, env):
    """The one exec of release-slot bytes (r3 sec. 1.3): refused while uid 0 or euid 0 or with group 0 among the supplementary groups,
    and whenever a slot path (reached through /opt/murage, /opt/murage-releases or /proc/self/fd) does not resolve under
    /opt/murage-releases/A or B. Never returns."""
    if os.getuid() == 0 or os.geteuid() == 0 or 0 in os.getgroups():
        os._exit(1)
    for candidate in [path] + list(argv):
        if isinstance(candidate, str) and (candidate.startswith("/opt/murage") or candidate.startswith("/proc/self/fd/")):
            if not re.fullmatch(r"/opt/murage-releases/(A|B)(/.*)?", os.path.realpath(candidate)):
                os._exit(1)
    os.execve(path, argv, env)
    os._exit(1)


def exec_supervisor(dirfd, env, node=NODE):
    os.set_inheritable(dirfd, True)
    exec_slot(node, [node, "/proc/self/fd/%d/%s" % (dirfd, SUPERVISOR)], env)


def main():
    if os.geteuid() != 0 or os.getuid() != 0:
        raise ValueError("Cloud home launcher requires root")
    os.umask(0o077)
    safe_mode = os.environ.get("MURAGE_SAFE_MODE") == "1"
    identity = read_identity()
    home_env = read_home_env()
    bind_home_volume(DATA, home_env["MURAGE_CLOUD_MACHINE_ID"], identity["uid"], identity["gid"], identity["proxyUid"], identity["proxyGid"])
    prepare_engine_homes(identity)
    prepare_broker_dir(identity)
    slot, dirfd, _state = start_gate()
    env = supervisor_env(home_env, slot, identity, safe_mode)
    drop_privileges(identity)
    exec_supervisor(dirfd, env)


if __name__ == "__main__":
    try:
        main()
    except Refused as refused:
        print("Cloud home start refused: " + refused.reason, file=sys.stderr)
        sys.exit(EXIT_REFUSED)
    except Exception:
        print("Cloud home launcher failed", file=sys.stderr)
        sys.exit(1)
