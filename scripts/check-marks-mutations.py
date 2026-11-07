#!/usr/bin/env python3
"""Driver-only mutation check. Restores each file, including existing edits.
Usage: python3 scripts/check-marks-mutations.py -- <vitest run command> server/nlmi-marks-guards.test.ts
No test command is embedded or run unless the driver supplies it.
"""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WALK = "server/shell/walk.ts"
MARKS = "server/shell/marks.ts"
WIRE = "server/outside-wire.ts"
# Each mutation changes one guard. Tests assert named reasons as well as holds.
MUTATIONS = {
    "M-PR-1a": (WALK, r"[A-Za-z0-9_~$}", r"[A-Za-z0-9_.~$}"),
    "M-PR-1b": (WALK, '&& canonPath(value, ctx, "write").value)', '&& false)'),
    "M-PR-1c": (WALK, 'return "incomplete"; // M-PR-1c', 'return "complete"; // M-PR-1c'),
    "M-PR-2": (WALK, 'if (fileFed) throw new Doubt("tokenizer"); // M-PR-2', 'if (false) throw new Doubt("tokenizer"); // M-PR-2'),
    "M-PR-3a": (WALK, 'parts.includes("proc") && parts.includes("..")', 'parts[0] === "proc" && parts.includes("..")'),
    "M-PR-3b": (WALK, r'return /^\/proc(?:\/|$)/.test(path); // M-PR-3b', 'return false; // M-PR-3b'),
    "M-PR-4": (WALK, 'if (out && canonPath(out.file, ctx, "write").value)', 'if (false)'),
    "M-PR-5a": (WALK, 'throw new Doubt("unavailable-exec"); // M-PR-5a', 'return absolute; // M-PR-5a'),
    "M-PR-5b": (WIRE, 'item.lateFrame || source === "interpreter" ? undefined : item.callKey; // M-PR-5b', 'item.callKey; // M-PR-5b'),
    "M-PR-6a": (MARKS, 'return COMPILERS.has(name) && args.some(arg => /(?:^|,)@/.test(arg));', 'return false;'),
    "M-PR-6b": (MARKS, 'return !COMPILERS.has(name) && !reader && args.some(arg => arg.startsWith("@"));', 'return false;'),
    "M-PR-6c": (WALK, 'if (rawName === "xargs" && rawArgs.some', 'if (false && rawArgs.some'),
    "M-PR-6d": (WALK, 'if ((name === "tar" || name === "rsync") && marksArgs.some', 'if (false && marksArgs.some'),
    "M-PR-7": (WALK, 'if (text.length > COMMAND_GATE_CHARS) throw new Doubt("scan-gate"); // M-PR-7', 'if (false) throw new Doubt("scan-gate"); // M-PR-7'),
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-targets", action="store_true", help="read-only check; runs no tests")
    parser.add_argument("runner", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    for label, (relative, before, _) in MUTATIONS.items():
        count = (ROOT / relative).read_text().count(before)
        if count != 1:
            raise SystemExit(f"{label}: expected one mutation target, got {count}")
    if args.check_targets:
        print(f"{len(MUTATIONS)} unique mutation targets; no tests run")
        return
    runner = args.runner[1:] if args.runner[:1] == ["--"] else args.runner
    if not runner:
        parser.error("supply the isolated driver's test command after --")
    subprocess.run(runner, cwd=ROOT, check=True)
    survived = []
    for label, (relative, before, after) in MUTATIONS.items():
        path = ROOT / relative
        original = path.read_bytes()
        try:
            path.write_bytes(original.replace(before.encode(), after.encode(), 1))
            result = subprocess.run([*runner, "--testNamePattern", label + r"(?:\s|:)"], cwd=ROOT)
            if result.returncode == 0:
                survived.append(label)
            print(f"{label}: {'SURVIVED' if result.returncode == 0 else 'killed'}", flush=True)
        finally:
            path.write_bytes(original)
    if survived:
        raise SystemExit("surviving mutations: " + ", ".join(survived))

if __name__ == "__main__":
    main()
