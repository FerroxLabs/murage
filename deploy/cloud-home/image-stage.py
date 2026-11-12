#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""The marker that ties the two stages of build-image.sh together (LANE-G r3 sec. 2, Grok ruling d, conditions 4 and 5).

Stage 1 (MURAGE_IMAGE_STAGE=tree) builds the final slot A tree and calls `mark`: it records the revision, the architecture, this host's
machine id and the canonical tree digest (the home's own seal walk, computed by the checkout's trusted murage-commands). Stage 2
(MURAGE_IMAGE_STAGE=seal) calls `check` before it does anything else: no marker, another revision, another architecture, another host or a
tree whose digest is no longer the marked one refuses the build. Stage 2 then recomputes the digest again and requires the signed manifest's
treeSha256 to equal it, so the marker is a first, early refusal and the signature is the final authority.

Usage: image-stage.py mark|check MURAGE_COMMANDS TREE REVISION MARKER HOST_ID_FILE
Exit 0 on success; on refusal exit 1 with one line on stderr.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys

FORMAT = "murage-image-stage1-v1"


def load_commands(path):
    sys.dont_write_bytecode = True  # the checkout must stay clean: stage 2 refuses a dirty one
    loader = importlib.machinery.SourceFileLoader("mc", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def tree_digest(home, tree):
    fd = os.open(tree, home.SLOT_OPEN)
    try:
        return home.seal_walk_digest(fd, False)
    finally:
        os.close(fd)


def host_id(path):
    with open(path, "r", encoding="ascii") as stream:
        value = stream.read(257).strip()
    if not value or len(value) > 256:
        raise ValueError("host id unavailable")
    return value


def main(argv):
    if len(argv) != 7 or argv[1] not in ("mark", "check"):
        sys.exit("usage: image-stage.py mark|check MURAGE_COMMANDS TREE REVISION MARKER HOST_ID_FILE")
    action, commands, tree, revision, marker, host_file = argv[1:]
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        sys.exit("image stage: revision must be a full 40-hex commit")
    home = load_commands(commands)
    machine = os.uname().machine
    if action == "mark":
        if os.path.lexists(marker):
            sys.exit("image stage: stage 1 already completed on this host (marker exists); stage 1 never reruns, start from a fresh builder")
        record = {"format": FORMAT, "revision": revision, "machine": machine, "hostId": host_id(host_file), "treeSha256": tree_digest(home, tree)}
        directory = os.path.dirname(marker)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, sort_keys=True)
        print("stage 1 marker written: tree %s" % record["treeSha256"])
        return
    try:
        with open(marker, "rb") as stream:
            record = json.loads(stream.read(4097).decode("utf-8"))
    except (OSError, ValueError):
        sys.exit("image stage: no stage 1 marker on this host; run MURAGE_IMAGE_STAGE=tree first, on this builder")
    if not isinstance(record, dict) or record.get("format") != FORMAT or set(record) != {"format", "revision", "machine", "hostId", "treeSha256"}:
        sys.exit("image stage: the stage 1 marker is not valid")
    if record["revision"] != revision:
        sys.exit("image stage: stage 1 was built from another revision")
    if record["machine"] != machine or record["hostId"] != host_id(host_file):
        sys.exit("image stage: stage 1 was not completed on this host")
    if tree_digest(home, tree) != record["treeSha256"]:
        sys.exit("image stage: the tree changed after stage 1 (digest differs from the marked one); rebuild from a fresh builder")
    print("stage 1 marker verified: tree %s" % record["treeSha256"])


if __name__ == "__main__":
    main(sys.argv)
