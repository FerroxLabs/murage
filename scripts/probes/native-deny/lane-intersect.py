#!/usr/bin/env python3
"""Fail-closed work-ahead gate. HEAD may be --staged for pre-commit checks."""
import fnmatch
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def expand(pattern):
    match = re.search(r"\{([^{}]+)\}", pattern)
    if not match:
        return [pattern]
    return [item for word in match[1].split(",") for item in expand(pattern[:match.start()] + word + pattern[match.end():])]


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: lane-intersect.sh <base> <head|--staged>")
    base, head = sys.argv[1:]
    baseline = git("rev-parse", "--verify", "1a899c675^{commit}")
    if git("rev-parse", "--verify", f"{base}^{{commit}}") != baseline:
        raise ValueError("work-ahead base must be the fixed 1.0.19 baseline")
    root = Path(git("rev-parse", "--show-toplevel"))
    tracker = Path(os.environ.get("NATIVE_DENY_TRACKER", str(root / "rel1019/TRAIN-1019-TRACKER.md")))
    # Read the live tracker (or MAIN's literal path list) every time.
    # An absent/empty source is never a pass.
    text = tracker.read_text()
    patterns = []
    for line in text.splitlines():
        path = line.strip()
        if (re.fullmatch(r"[^\s`|]+", path) and not path.startswith(("/", "#"))
                and path != "." and ".." not in path.split("/")):
            patterns.append(path)
    for code in re.findall(r"`([^`\n]+)`", text):
        for token in re.findall(r"(?:server|shared|scripts|src|electron|companion|apps|tools)/[^\s;]+", code):
            patterns.extend(expand(token.rstrip(".,:)")))
    if not patterns:
        raise ValueError("tracker contains no parseable lane paths")
    owned_entries = len(patterns)
    patterns += ["server/drivers/**", "server/decision/**", "server/memory/**", "server/highlevel/**",
                 "server/auto-approve.ts", "server/permission-proxy.ts", "server/index.ts", "server/always-ask.ts",
                 "server/message-db.ts", "server/store.ts", "server/contracts.ts", "shared/permission-card.ts",
                 "server/browser-extension-service.ts", "shared/no-limits-decision.ts", "server/no-limits-*.ts",
                 "server/routine-permissions.ts", "server/testing/*", "scripts/scale/gen.ts",
                 "scripts/no-limits-live/**", "scripts/nolim-replay/**", "*fts*", "*wal*"]
    args = ["diff", "--no-renames", "--name-status", "-z"]
    args += ["--cached", base] if head == "--staged" else [f"{base}...{head}"]
    parts = subprocess.check_output(["git", *args]).decode().rstrip("\0").split("\0")
    errors = []
    paths = []
    if parts != [""]:
        if len(parts) % 2:
            raise ValueError("unexpected diff status framing")
        for status, path in zip(parts[::2], parts[1::2]):
            paths.append(path)
            if status != "A":
                errors.append(f"not a new file: {status} {path}")
            if not (path.startswith("server/native-deny/") or path.startswith("scripts/probes/native-deny/") or path == "shared/native-deny-probes.json"):
                errors.append(f"outside work-ahead paths: {path}")
            if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns):
                errors.append(f"owned by 1.0.19: {path}")
            # Fixed baseline, independently of the caller's diff base. This also
            # catches rename/delete-and-add attempts to reuse an existing file.
            result = subprocess.run(["git", "cat-file", "-e", f"1a899c675:{path}"], capture_output=True)
            if result.returncode == 0:
                errors.append(f"exists at fixed baseline: {path}")
            elif result.returncode != 128:
                errors.append(f"baseline lookup failed: {path}")
    print(f"tracker_sha256={hashlib.sha256(text.encode()).hexdigest()} owned_entries={owned_entries} files={len(paths)}")
    for error in errors:
        print(error)
    print("INTERSECTION: FAIL" if errors else "INTERSECTION: PASS (new files only; owned intersection empty)")
    return bool(errors)


try:
    sys.exit(main())
except Exception as error:
    print(f"INTERSECTION: FAIL CLOSED ({type(error).__name__}: {error})")
    sys.exit(2)
