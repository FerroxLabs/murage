#!/usr/bin/env python3
"""Driver-only mutation check. Restores each file, including existing edits.
Usage: python3 scripts/check-marks-mutations.py -- <vitest run command> server/nlmi-marks-guards.test.ts
No test command is embedded or run unless the driver supplies it.
"""
import argparse
import json
import tempfile
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WALK = "server/shell/walk.ts"
MARKS = "server/shell/marks.ts"
WIRE = "server/outside-wire.ts"
# Each mutation changes one guard. Tests assert named reasons as well as holds.
MUTATIONS = {
    "M-FIX3-climb": (WALK, 'if (part === ".." && protectedWritePath(normalizePath(prefix))) return true; // M-FIX3-climb', '// M-FIX3-climb removed'),
    "M-FIX3-data": (WALK, 'followLinks(ctx, resolveFrom(ctx.cwd, path)); // M-FIX3-data', 'resolvePath(ctx, path); // M-FIX3-data'),
    "M-FIX3-target": (WALK, 'if (target.value) throw new Doubt("value-path"); // M-FIX3-target', '// M-FIX3-target removed'),
    "M-FIX3-record-data": (WALK, 'if (name === "printf" || name === "echo") return; // M-FIX3-record-data', '// M-FIX3-record-data removed'),
    "M-FIX3-class": ("server/always-ask.ts", 'if (procTraversal(homeSpelled(raw)) || protectedClimb(raw)) return "system"; // M-FIX3-class', '// M-FIX3-class removed'),
    "M-FIX2-pending-link": (WALK, 'if (ctx.links?.has(next)) throw new Doubt("value-path"); // M-FIX2-pending-link', '// M-FIX2-pending-link removed'),
    "M-FIX2-dd": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-dd', 'return; // M-FIX2-dd'),
    "M-FIX2-long-value": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-long-value', 'return; // M-FIX2-long-value'),
    "M-FIX2-wrapper-path": (WALK, 'if (/[\\\\/]/.test(renderWord(rest[0]!))) return done(); // M-FIX2-wrapper-path', '// M-FIX2-wrapper-path removed'),
    "M-FIX2-command": (WALK, 'throw new Doubt("command"); // M-FIX2-command', 'return null; // M-FIX2-command'),
    "M-FIX2-copy": (WALK, 'if (direct) throw new Doubt("command"); // M-FIX2-copy', 'if (direct) return null; // M-FIX2-copy'),
    "M-FIX2-key": (WALK, 'followLinks(ctx, canonPath(resolved, ctx, "read").path); // M-FIX2-key', 'followLinks(ctx, resolved); // M-FIX2-key'),
    "M-FIX2-current": (WALK, 'if (ctx.written.has(key)) return key; // M-FIX2-current', '// M-FIX2-current removed'),
    "M-FIX2-session": (WALK, 'throw new Doubt("unavailable-exec"); // M-FIX2-session', 'return key; // M-FIX2-session'),
    "M-FIX2-shadow": (WALK, 'if (written) return undefined; // M-FIX2-shadow', '// M-FIX2-shadow removed'),
    "M-FIX2-python-root": (WALK, 'throw new Doubt("value-path"); // M-FIX2-python-root', 'return "complete"; // M-FIX2-python-root'),
    "M-FIX2-model": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-model', 'return; // M-FIX2-model'),
    "M-FIX2-option": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-option\n', 'continue; // M-FIX2-option\n'),
    "M-FIX2-option-value": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-option-value', 'return; // M-FIX2-option-value'),
    "M-FIX2-env": (MARKS, 'throw new Doubt("tokenizer"); // M-FIX2-env', 'return; // M-FIX2-env'),
    "M-FIX2-protected": ("server/always-ask.ts", 'return "system"; // M-FIX2-protected', 'return null; // M-FIX2-protected'),
    "M-FIX2-waiver": ("server/auto-approve.ts", 'return false; // M-FIX2-waiver', 'return true; // M-FIX2-waiver'),
    "M-PR-1a": (WALK, r"[A-Za-z0-9_~$}", r"[A-Za-z0-9_.~$}"),
    "M-PR-1b": (WALK, '&& canonPath(value, ctx, "write").value)', '&& false)'),
    "M-PR-1c": (WALK, 'return "incomplete"; // M-PR-1c', 'return "complete"; // M-PR-1c'),
    "M-PR-2": (WALK, 'return undefined; // M-PR-2', 'return "1p"; // M-PR-2'),
    "M-R1-sed": (MARKS, 'text === undefined || !/^(?:\\d+(?:,\\d+)?)?p\\s*$/.test(text)', 'false'),
    "M-R1-option": (MARKS, 'flag !== "e" && flag !== "f"', 'false'),
    "M-R1-program": (WALK, 'if (["awk", "gawk", "nawk"].includes(name)', 'if (false'),
    "M-R1-literal": (MARKS, 'return /[`$@]|#\\{|\\beval\\b|\\bexec\\s*\\(/.test(text);', 'return false;'),
    "M-R1-interpreter-option": (WALK, 'text !== "-e" && text !== "--"', 'false'),
    "M-R1-unknown-option": (WALK, 'if (text.startsWith("-")) throw new Doubt("tokenizer");', 'if (text.startsWith("-")) continue;'),
    "M-R1-format": (WALK, 'const literal = String.raw`(?:"[^"\\\\\\n{}]*"|\'[^\'\\\\\\n{}]*\')`;', 'const literal = String.raw`(?:"[^"\\\\\\n]*"|\'[^\'\\\\\\n]*\')`;'),
    "M-R1-cwd": (WALK, 'ctx.cwdConflict || !ctx.cwd || !isAnchored(ctx.cwd)', 'false'),
    "M-R1-path": ("server/always-ask.ts", '(RISKY.has(cmd.name) || cmd.name === "touch")', 'false'),
    "M-R1-fold": (WALK, 'path = path.toLowerCase();', 'path = path;'),
    "M-R1-resolve": (WALK, 'path = realpathSync.native(next).replaceAll("\\\\", "/");', 'path = next;'),
    "M-R1-target": (WALK, 'if (target) return { file: target[1] ?? target[2]!, last: i };', 'if (false) return { file: "safe", last: i };'),
    "M-R1-dangling": (WALK, 'if (lstatSync(next).isSymbolicLink())', 'if (false)'),
    "M-R1-stdin": (WALK, 'if (file === "-") return undefined;', 'if (false) return undefined;'),
    "M-R1-uncertain": ("server/always-ask.ts", '&& candidate.kind !== "literal") throw new Doubt("value-path"); // M-R1-uncertain', '&& false) throw new Doubt("value-path"); // M-R1-uncertain'),
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
            with tempfile.TemporaryDirectory(dir=ROOT) as report_dir:
                report = Path(report_dir) / "result.json"
                result = subprocess.run([*runner, "--testNamePattern", label + r"(?:\s|:)",
                                         "--reporter=json", "--outputFile=" + str(report)], cwd=ROOT)
                try:
                    data = json.loads(report.read_text())
                    assertions = [test for suite in data["testResults"] for test in suite["assertionResults"]]
                    killed = result.returncode == 1 and any(
                        test.get("fullName", "").find(label + " ") >= 0
                        and test.get("status") == "failed"
                        and any("AssertionError" in message for message in test.get("failureMessages", []))
                        for test in assertions)
                except (OSError, ValueError, KeyError, TypeError):
                    killed = False
            if not killed:
                survived.append(label)
            print(f"{label}: {'killed' if killed else 'NOT PROVEN KILLED'}", flush=True)
        finally:
            path.write_bytes(original)
    if survived:
        raise SystemExit("surviving mutations: " + ", ".join(survived))

if __name__ == "__main__":
    main()
