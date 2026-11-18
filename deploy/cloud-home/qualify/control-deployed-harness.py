#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# J5b r7 qualification harness: runs the REAL murage-control `run` loop (importlib, same file the image ships, or MC_UNDER_TEST) with
#  - a file-based control plane mock (no network): every heartbeat body is appended to $J5B_ROOT/cp-bodies.jsonl with the status it got;
#  - fault points and barriers driven by files under $J5B_ROOT/ctl (see FAULTS below), so a test cuts the process at an exact write;
#  - scaled time (J5B_SCALE) so a 60 s poll interval passes in a fraction of a second.
# Used by murage-control_test.py (unit mode, J5B_UNIT=1: clock, desired and snapshot publication stubbed) and by the deployed rig
# (J5B_UNIT=0: nothing stubbed). Run as `python3 -I control-deployed-harness.py`.
#
# FAULTS (a file in $J5B_ROOT/ctl; removing it ends the fault, no restart needed):
#   hold-heartbeat          heartbeat requests block until the file is removed
#   cp-default              content "ok" (default) or "503": the answer when cp-script.json is used up
#   cp-script.json          list of "ok" | "503" | "400", one per heartbeat, in order
#   fault-journal-erofs     every write to or open-for-write of home-events.journal raises EROFS
#   fault-sent-enospc       a journal write that holds a "sent" op raises ENOSPC
#   fault-short-write       content N: the next journal write is cut to N bytes (a short count is returned), later writes raise ENOSPC
#   fault-stall-overflow    a journal write holding both a "drop" and an "add" op is written up to its last byte, then STALL overflow_record_written
#   fault-stall-midline     a journal write holding an "add" op is written up to its middle, then STALL journal_midline (D7)
#   fault-overflow-enospc   a journal write holding both a "drop" and an "add" op raises ENOSPC (P21b)
#   fault-sent-key          content "AT COUNT": the first COUNT journal writes holding a "sent" op that names the key at AT raise ENOSPC (P24)
#   fault-dirfsync-after-rename   after the journal is renamed over (compaction) every directory fsync raises EIO while the file exists, and the rename leaves barrier-journal_renamed (P28)
#   fault-stall-ack         the ACK write that lists an `accepted` id waits (up to 3 s) for release-ack_stall and leaves barrier-ack_stall (P29)
#   hold-intake             the intake thread (any thread but the main one) blocks before its app probe until the file is removed (D3 .. D5)
# Barriers (r7, section 9): a fault point either NOTES (creates $J5B_ROOT/barrier-<name> and continues) or STALLS (creates it, then blocks until
# $J5B_ROOT/release-<name> exists). In the rig $J5B_ROOT is /run/murage-control/j5b, a path the unit can already write.
# Recorders: every cp-bodies.jsonl row also carries "journal_adds" (the [id, type, at] of every add in the journal's valid prefix when the request was
# made, P7c); after every journal fsync the durable `sent` keys are checked against acceptance order and a violation is appended to
# $J5B_ROOT/prefix-violations.log (P24).
import builtins
import errno
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import threading
import time
import urllib.error
import zlib

# J5B_DEPLOYED=1 (the rig, real units): the real paths, binding and CP transport are kept; only the fault points, barriers and scaled time apply.
# Faults and barriers then live in J5B_ROOT, which must be a path the control sandbox can write: /run/murage-control/j5b (ReadWritePaths=/run/murage-control).
DEPLOYED = os.environ.get("J5B_DEPLOYED") == "1"
ROOT = os.environ["J5B_ROOT"]
CTL = ROOT + "/ctl"
SCALE = float(os.environ.get("J5B_SCALE", "1"))
UNIT = os.environ.get("J5B_UNIT", "1") == "1"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("MC_UNDER_TEST") or os.path.join(HERE, "..", "murage-control")
WALL = 1_800_000_000_000
ADVERTISE = "restore.aborted,restore.stuck,home.event_spool_failed,restore.finished"

_loader = importlib.machinery.SourceFileLoader("murage_control", SRC)
mc = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_control", _loader))
_loader.exec_module(mc)

if not DEPLOYED:
    mc.CONTROL_STATE = ROOT + "/state"
    mc.SPOOL_STATE_PATH = mc.CONTROL_STATE + "/" + mc.SPOOL_STATE_NAME
    mc.PUBLIC = ROOT + "/run"
    mc.EVENTS, mc.SERVER_EVENTS = ROOT + "/events", ROOT + "/legacy"
    mc.APP_PROBE_URL = os.environ["J5B_APP_URL"]
    mc.INTAKE_S = float(os.environ.get("J5B_INTAKE_S", "0.05"))  # created when the control has no such name yet (base): harmless
    mc.refresh_probe_namespace = lambda *args, **kwargs: False
    os.makedirs(mc.CONTROL_STATE, exist_ok=True)
else:
    os.makedirs(CTL, exist_ok=True)

if UNIT and not DEPLOYED:
    mc.validate_desired = lambda value, binding, lease: value
    mc.sample_clock = lambda context, clock, public: {"wallMs": WALL, "bootMs": 1000, "monoMs": 1000, "bootId": "b"}
    mc.clocks_match = lambda a, b: True
    mc.fence = lambda context, public: None
    _poll = mc.poll_once
    mc.poll_once = lambda binding, context=None, request=None, clock=None, public=None, expected_uid=0: _poll(
        binding, context, request, clock, public, expected_uid, lambda *a: None)


def flag(name):
    return os.path.exists(CTL + "/" + name)


def fd_path(fd):
    try:
        return os.readlink("/proc/self/fd/%d" % fd)
    except OSError:
        return ""


def is_journal(path):
    return str(path).endswith("home-events.journal")


_real_write, _real_open, _real_builtin_open = os.write, os.open, builtins.open
_real_fsync = os.fsync
_short = {"armed": False}
_sent_fail = {"n": 0}


def note(name):
    _real_builtin_open(ROOT + "/barrier-" + name, "w").close()


def stall(name):
    note(name)
    while not os.path.exists(ROOT + "/release-" + name):
        time.sleep(0.02)


def journal_records(path):
    """The valid prefix of the journal (CCCCCCCC <json>\\n lines) as a list of op lists."""
    try:
        with _real_builtin_open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return []
    records, offset = [], 0
    while offset < len(data):
        end = data.find(b"\n", offset)
        if end < 0:
            break
        crc, _, raw = data[offset:end].partition(b" ")
        if crc != ("%08x" % (zlib.crc32(raw) & 0xFFFFFFFF)).encode():
            break
        try:
            records.append(json.loads(raw)["ops"])
        except (ValueError, KeyError):
            break
        offset = end + 1
    return records


def journal_path():
    return (mc.CONTROL_STATE if not DEPLOYED else "/var/lib/murage-control") + "/home-events.journal"


def accepted_order():
    """Event keys in the order the CP mock first accepted them."""
    order = []
    try:
        with _real_builtin_open(ROOT + "/cp-bodies.jsonl") as handle:
            for line in handle:
                row = json.loads(line)
                if row["status"] != "ok":
                    continue
                for event in ((row["body"] or {}).get("health") or {}).get("events", []):
                    key = (event["type"], event["at"])
                    if key not in order:
                        order.append(key)
    except (OSError, ValueError):
        pass
    return order


def check_prefix_closed():
    durable = {(op["type"], op["at"]) for ops in journal_records(journal_path()) for op in ops if op["r"] == "sent"}
    order = accepted_order()
    ranked = [key in durable for key in order]
    if durable and (not all(ranked[: sum(ranked)]) or sum(ranked) != len(durable & set(order))):
        with _real_builtin_open(ROOT + "/prefix-violations.log", "a") as log:
            log.write(json.dumps({"durable": sorted(durable), "order": order}) + "\n")


_renamed = {"done": False}


def fsync(fd):
    if _renamed["done"] and flag("fault-dirfsync-after-rename"):
        import stat as _stat
        try:
            if _stat.S_ISDIR(os.fstat(fd).st_mode) and fd_path(fd) == os.path.dirname(journal_path()):  # only the journal directory (the ACK directory is separate)
                raise OSError(errno.EIO, "input/output error")
        except OSError as error:
            if error.errno == errno.EIO:
                raise
    result = _real_fsync(fd)
    if is_journal(fd_path(fd)):
        check_prefix_closed()
    return result


def write(fd, data):
    if is_journal(fd_path(fd)):
        if flag("fault-journal-erofs"):
            raise OSError(errno.EROFS, "read-only file system")
        raw0 = bytes(data)
        if flag("fault-sent-enospc") and b'"r":"sent"' in raw0:
            raise OSError(errno.ENOSPC, "no space left on device")
        if flag("fault-sent-key") and b'"r":"sent"' in raw0:
            at, count = (open(CTL + "/fault-sent-key").read().split() + ["0", "0"])[:2]
            if ('"at":%s' % at).encode() in raw0 and _sent_fail["n"] < int(count):
                _sent_fail["n"] += 1
                raise OSError(errno.ENOSPC, "no space left on device")
        if flag("fault-overflow-enospc") and b'"r":"drop"' in raw0 and b'"r":"add"' in raw0:
            raise OSError(errno.ENOSPC, "no space left on device")
        if flag("fault-short-write"):
            if not _short["armed"]:
                _short["armed"] = True
                count = int(open(CTL + "/fault-short-write").read().strip() or "7")
                return _real_write(fd, bytes(data)[:count])
            raise OSError(errno.ENOSPC, "no space left on device")
        _short["armed"] = False
        raw = bytes(data)
        if flag("fault-stall-overflow") and b'"r":"drop"' in raw and b'"r":"add"' in raw:
            _real_write(fd, raw[:-1])
            stall("overflow_record_written")
        if flag("fault-stall-midline") and b'"r":"add"' in raw:
            _real_write(fd, raw[: len(raw) // 2])
            stall("journal_midline")
    return _real_write(fd, data)


def os_open(path, flags, *args, **kwargs):
    if is_journal(path) and flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT) and flag("fault-journal-erofs"):
        raise OSError(errno.EROFS, "read-only file system", str(path))
    return _real_open(path, flags, *args, **kwargs)


def builtin_open(path, mode="r", *args, **kwargs):
    if isinstance(path, (str, bytes, os.PathLike)) and is_journal(path) and any(c in mode for c in "wa+x") and flag("fault-journal-erofs"):
        raise OSError(errno.EROFS, "read-only file system", str(path))
    return _real_builtin_open(path, mode, *args, **kwargs)


_real_replace = os.replace


def replace(src, dst, *args, **kwargs):
    result = _real_replace(src, dst, *args, **kwargs)
    if is_journal(dst):
        _renamed["done"] = True
        note("journal_renamed")
    return result


os.write, os.open, builtins.open, io.open, os.fsync, os.replace = write, os_open, builtin_open, builtin_open, fsync, replace

_real_atomic_public = mc.atomic_public


def atomic_public(path, value, expected_uid=0):
    if str(path).endswith("home-events-ack.json") and flag("fault-stall-ack") and isinstance(value, dict) and value.get("accepted") and threading.current_thread() is threading.main_thread():
        note("ack_stall")
        end = time.monotonic() + 3
        while not os.path.exists(ROOT + "/release-ack_stall") and time.monotonic() < end:
            time.sleep(0.02)
    return _real_atomic_public(path, value, expected_uid)


mc.atomic_public = atomic_public
_real_app_report = mc.app_report


def app_report(*args, **kwargs):
    while (flag("hold-intake") or os.path.exists(ROOT + "/hold-intake")) and threading.current_thread() is not threading.main_thread():
        time.sleep(0.02)
    return _real_app_report(*args, **kwargs)


mc.app_report = app_report
_beat = {"n": 0}


def cp_request(binding, operation, body=None, door=False, owner_factor=False):
    if operation == "lease":
        return {"wire": 1, "installationId": "inst1", "holder": binding["homeId"], "generation": binding["generation"],
                "expiresAt": WALL + 3_600_000, "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
    if operation == "desired":
        return {"stub": True}
    while flag("hold-heartbeat"):
        time.sleep(0.02)
    if flag("hold-event-heartbeat") and any(e.get("type") in mc.CHANNEL_TYPES for e in (body.get("health") or {}).get("events", [])):
        note("event_heartbeat")
        while flag("hold-event-heartbeat"):
            time.sleep(0.02)
    try:
        script = json.load(open(CTL + "/cp-script.json"))
    except (OSError, ValueError):
        script = []
    if _beat["n"] < len(script):
        status = script[_beat["n"]]
    else:
        try:
            status = open(CTL + "/cp-default").read().strip() or "ok"
        except OSError:
            status = "ok"
    _beat["n"] += 1
    with _real_builtin_open(ROOT + "/cp-bodies.jsonl", "a") as log:
        adds = [[op["id"], op["type"], op["at"]] for ops in journal_records(journal_path()) for op in ops if op["r"] == "add"]
        log.write(json.dumps({"n": _beat["n"], "status": status, "body": body, "journal_adds": adds}, sort_keys=True) + "\n")
    if status != "ok":
        raise urllib.error.HTTPError("https://cp.test", int(status), "refused", {}, None)
    reply = mc.Reply({"wire": 1, "accepted": True})
    reply.event_types = ADVERTISE
    return reply


_deployed_binding = mc.load_private_binding if DEPLOYED else None
binding = {"homeId": "home-test", "generation": 1, "adminUrl": "https://cp.test", "credential": "c", "publicOrigin": "https://home.example"}
started = time.monotonic()


if DEPLOYED:
    mc.run(load=_deployed_binding, request=mc.machine_request, clock=mc.read_clock, sleep=lambda seconds: time.sleep(seconds / SCALE),
           monotonic=lambda: (time.monotonic() - started) * SCALE, public=mc.PUBLIC, expected_uid=0)
else:
    mc.run(load=lambda: binding, request=cp_request, clock=lambda: {}, sleep=lambda seconds: time.sleep(seconds / SCALE),
           monotonic=lambda: (time.monotonic() - started) * SCALE, public=mc.PUBLIC, expected_uid=os.getuid())
