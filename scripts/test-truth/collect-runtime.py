#!/usr/bin/env python3
"""Verify private runtime result streams and atomically install their artifacts."""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import shutil
import tarfile
import tempfile


def collect(log, side, expected_sha, destination, scratch=None):
    raw = pathlib.Path(log).read_text()
    begin, end = f"BEGIN_RUNTIME {side}\n", f"\nEND_RUNTIME {side}"
    if begin not in raw or end not in raw:
        raise ValueError(f"Missing complete {side} runtime result")
    encoded = raw.rsplit(begin, 1)[1].split(end, 1)[0]
    destination = pathlib.Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="truth-runtime-collect-", dir=scratch) as temporary:
        root = pathlib.Path(temporary)
        names = {f"{side}-build.tar.gz", f"{side}-build.finished"}
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded, validate=True)), mode="r:") as archive:
            members = archive.getmembers()
            if len(members) != 2 or {member.name for member in members} != names or not all(member.isfile() and 0 <= member.size <= 512 * 1024**2 for member in members):
                raise ValueError("Unexpected runtime result entries")
            # Bookworm's Python predates tarfile's extraction-filter argument.
            # Only these two exact regular-file names are accepted; copy their
            # bytes directly, without applying archive paths or metadata.
            for member in members:
                with archive.extractfile(member) as source, (root / member.name).open("xb") as target:
                    shutil.copyfileobj(source, target)
        artifact, receipt = root / f"{side}-build.tar.gz", root / f"{side}-build.finished"
        provenance = json.loads(receipt.read_text())
        with artifact.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if provenance["sha"] != expected_sha or provenance["archiveSha256"] != digest:
            raise ValueError("Runtime source or artifact hash mismatch")
        if root.stat().st_dev != destination.stat().st_dev:
            raise ValueError("Choose --scratch on the destination filesystem, outside the synced checkout")
        # A concurrent reader may see a mismatched pair and refuse; it can never
        # validate a different artifact, since it hashes its own private copy.
        artifact.replace(destination / artifact.name)
        receipt.replace(destination / receipt.name)
        return provenance


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True)
    parser.add_argument("--side", choices=["base", "head"], required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--scratch")
    args = parser.parse_args()
    print(json.dumps(collect(args.log, args.side, args.sha, args.destination, args.scratch)))
