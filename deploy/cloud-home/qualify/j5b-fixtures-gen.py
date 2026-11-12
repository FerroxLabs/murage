#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# J5b r6: writes the shared fixtures. Run from the repo root: python3 -I deploy/cloud-home/qualify/j5b-fixtures-gen.py
#  - deploy/cloud-home/testdata/j5b-records/*.txt (+ a byte-identical copy in server/cloud-home/testdata/j5b-records/): CRC32 line vectors, one record per line:
#    CCCCCCCC <json>\n where CCCCCCCC is the lowercase hex CRC32 of the json bytes (design section 4). Python and Node read the same files.
#  - testdata/j5b-health/*.json: health bodies (v1 homeEvents at 32 and 33 items, outboxDegraded) and ACK files with and without `control`.
#  - r7: the outbox `done` op is {"r":"done","id","type","at"} (it is also the tombstone): valid-done.txt, and compaction-input.txt + compaction.json
#    (compaction keeps every live `add` and the newest 128 tombstones per type).
#  - r7: testdata/j5b-ack/: offered-ids.json (32 ids, shared by P25 and T16), max.json (512 ids in total, the writer's maximum), over-513.json,
#    both-lists.json, hex17.json, no-control.json (+ manifest.json). Every id is the first 16 hex characters of a sha256.
import hashlib
import json
import os
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BASE_AT = 1_800_000_000_000


def crc_hex(raw):
    return "%08x" % (zlib.crc32(raw) & 0xFFFFFFFF)


def line(ops):
    raw = json.dumps({"v": 1, "ops": ops}, separators=(",", ":")).encode()
    return crc_hex(raw).encode() + b" " + raw + b"\n"


def add(n, type_="restore.aborted"):
    return {"r": "add", "id": "%016x" % n, "type": type_, "at": BASE_AT + n}


def hid(tag, n):
    return hashlib.sha256(("%s\0%d" % (tag, n)).encode()).hexdigest()[:16]


def done(n, type_="restore.aborted"):
    return {"r": "done", "id": "%016x" % n, "type": type_, "at": BASE_AT + n}


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


def records():
    l1, l2, l3, l4, l5 = line([add(1), add(2, "restore.stuck")]), line([add(3)]), line([{"r": "sent", "type": "restore.aborted", "at": BASE_AT + 1}]), line([add(4)]), line([add(5)])
    flipped = bytearray(l4)
    flipped[20] ^= 0x01  # one flipped byte inside the JSON
    ld1, ld2, ld3 = line([add(1)]), line([done(1)]), line([add(2, "restore.stuck")])
    files = {
        "valid-done.txt": (ld1 + ld2 + ld3, 3, True, ["%016x" % 1, "%016x" % 2], []),
        "valid.txt": (l1 + l2 + l3, 3, True, ["%016x" % 1, "%016x" % 2, "%016x" % 3], []),
        "flipped-byte.txt": (l1 + l2 + l3 + bytes(flipped) + l5, 3, False, ["%016x" % 1, "%016x" % 2, "%016x" % 3], ["%016x" % 4, "%016x" % 5]),
        "missing-newline.txt": (l1 + l2 + l4[:-1], 2, False, ["%016x" % 1, "%016x" % 2, "%016x" % 3], ["%016x" % 4]),
        "half-line.txt": (l1 + l2 + l4[: len(l4) // 2], 2, False, ["%016x" % 1, "%016x" % 2, "%016x" % 3], ["%016x" % 4]),
        "short-then-glued.txt": (l1 + l4[:7] + l5, 1, False, ["%016x" % 1, "%016x" % 2], ["%016x" % 5]),
    }
    manifest = {}
    firsts = {"valid-done.txt": [ld1, ld2, ld3], "valid.txt": [l1, l2, l3], "flipped-byte.txt": [l1, l2, l3], "missing-newline.txt": [l1, l2], "half-line.txt": [l1, l2], "short-then-glued.txt": [l1]}
    for name, (data, lines, clean, _prefix_ids, later) in files.items():
        prefix = firsts[name]
        ids = []
        for row in prefix:
            for op in json.loads(row[row.index(b" ") + 1:])["ops"]:
                if op["r"] == "add":
                    ids.append(op["id"])
        manifest[name] = {"valid_prefix_lines": lines, "valid_prefix_bytes": sum(len(row) for row in prefix), "clean": clean,
                          "ids_in_prefix": ids, "ids_after_bad_line": later}
        for directory in ("deploy/cloud-home/testdata/j5b-records", "server/cloud-home/testdata/j5b-records"):
            write(os.path.join(ROOT, directory, name), data)
    # compaction vector: 300 tombstones of restore.aborted, 40 of restore.stuck, 3 live adds (one per type), interleaved; one op per record line.
    lines, live, tomb = [], [], {"restore.aborted": [], "restore.stuck": []}
    for n in range(340):
        type_ = "restore.aborted" if n < 300 else "restore.stuck"
        op = {"r": "done", "id": hid("tomb", n), "type": type_, "at": BASE_AT + 1000 + n}
        tomb[type_].append(op)
        lines.append(line([op]))
        if n in (50, 150, 250):
            row = {"r": "add", "id": hid("live", n), "type": ("restore.aborted", "restore.stuck", "home.event_spool_failed")[(n // 100) % 3], "at": BASE_AT + 9000 + n}
            live.append(row)
            lines.append(line([row]))
    compaction = {"input_lines": len(lines), "live_add_ids": [row["id"] for row in live],
                  "kept_tombstone_ids": {t: [op["id"] for op in ops[-128:]] for t, ops in tomb.items()},
                  "dropped_tombstone_ids": {t: [op["id"] for op in ops[:-128]] for t, ops in tomb.items()}}
    for directory in ("deploy/cloud-home/testdata/j5b-records", "server/cloud-home/testdata/j5b-records"):
        write(os.path.join(ROOT, directory, "compaction-input.txt"), b"".join(lines))
        write(os.path.join(ROOT, directory, "compaction.json"), (json.dumps(compaction, indent=1, sort_keys=True) + "\n").encode())
    for directory in ("deploy/cloud-home/testdata/j5b-records", "server/cloud-home/testdata/j5b-records"):
        write(os.path.join(ROOT, directory, "manifest.json"), (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode())


def health():
    def items(count):
        return [{"id": "%016x" % (100 + n), "type": ("restore.aborted", "restore.stuck")[n % 2], "at": BASE_AT + 100 + n} for n in range(count)]

    def body(count, degraded=0, mutate=None):
        rows = items(count)
        if mutate:
            mutate(rows)
        return {"app": "murage", "door": "v2", "eventSpoolFailures": 0, "instance": "i" * 16, "homeEvents": {"v": 1, "items": rows, "outboxDegraded": degraded}}

    def extra_key(rows):
        rows[0]["text"] = "arbitrary text is never allowed"

    bodies = {
        "body-items-32.json": (body(32), True, 32, 0),
        "body-items-33.json": (body(33), False, 0, 0),
        "body-degraded.json": (body(2, 2), True, 2, 2),
        "body-degraded-33.json": (body(2, 33), False, 0, 0),
        "body-extra-key.json": (body(2, 0, extra_key), False, 0, 0),
        "body-legacy-counter.json": ({"app": "murage", "door": "v2", "eventSpoolFailures": 3, "instance": "i" * 16}, False, 0, 0),
    }
    manifest = {}
    for name, (value, valid, count, degraded) in bodies.items():
        write(os.path.join(ROOT, "testdata/j5b-health", name), (json.dumps(value, sort_keys=True) + "\n").encode())
        manifest[name] = {"valid": valid, "items": count, "outboxDegraded": degraded}
    acks = {
        "ack-with-control.json": {"v": 1, "control": 1, "acked": [], "accepted": []},
        "ack-without-control.json": {"v": 1, "acked": [], "accepted": []},
        "ack-control-0.json": {"v": 1, "control": 0, "acked": [], "accepted": []},
    }
    for name, value in acks.items():
        write(os.path.join(ROOT, "testdata/j5b-health", name), (json.dumps(value, sort_keys=True) + "\n").encode())
        manifest[name] = {"extended": name == "ack-with-control.json"}
    write(os.path.join(ROOT, "testdata/j5b-health", "manifest.json"), (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode())


def ack_fixtures():
    offered = [hid("offered", n) for n in range(32)]
    retained = [hid("retained", n) for n in range(480)]

    def ack(acked, accepted, control=1):
        value = {"v": 1, "acked": acked, "accepted": accepted}
        if control is not None:
            value["control"] = control
        return value

    files = {
        # 480 durable + 32 accepted while their add is not durable = 512 ids in total, disjoint: the writer's maximum (9,788 bytes)
        "max.json": (ack(retained, offered), True),
        "over-513.json": (ack(offered + [hid("over", n) for n in range(481)], []), False),  # the 32 offered ids plus 481 others = 513
        "both-lists.json": (ack(offered, [offered[0]]), False),
        "hex17.json": (ack([offered[0] + "0"] + offered[1:], []), False),
        "no-control.json": (ack(offered, [], None), False),
    }
    manifest = {"offered-ids.json": {"ids": 32}}
    write(os.path.join(ROOT, "testdata/j5b-ack", "offered-ids.json"), (json.dumps(offered) + "\n").encode())
    for name, (value, valid) in files.items():
        raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        assert len(raw) <= 16384, name
        write(os.path.join(ROOT, "testdata/j5b-ack", name), raw)
        manifest[name] = {"valid": valid, "bytes": len(raw)}
    assert manifest["max.json"]["bytes"] <= 9788 + 2, manifest["max.json"]
    write(os.path.join(ROOT, "testdata/j5b-ack", "manifest.json"), (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode())


records()
health()
ack_fixtures()
