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
    "M-FIX3-target": (WALK, 'if (target.value) doubt("value-path"); // M-FIX3-target', '// M-FIX3-target removed'),
    "M-FIX3-record-data": (WALK, 'if (name === "printf" || name === "echo") return; // M-FIX3-record-data', '// M-FIX3-record-data removed'),
    "M-FIX3-class": ("server/always-ask.ts", 'if (procTraversal(homeSpelled(raw)) || protectedClimb(raw)) return "system"; // M-FIX3-class; FULL-DENY-1018: a deny rule holds at every level', '// M-FIX3-class removed'),
    "M-FIX2-pending-link": (WALK, 'if (ctx.links?.has(next)) doubt("value-path"); // M-FIX2-pending-link', '// M-FIX2-pending-link removed'),
    "M-FIX2-dd": (MARKS, 'doubt("tokenizer"); // M-FIX2-dd', 'return; // M-FIX2-dd'),
    "M-FIX2-long-value": (MARKS, 'doubt("tokenizer"); // M-FIX2-long-value', 'return; // M-FIX2-long-value'),
    "M-FIX2-wrapper-path": (WALK, 'return done(); // M-FIX2-wrapper-path;', '{} // M-FIX2-wrapper-path;'),
    "M-FIX2-command": (WALK, 'doubt("command"); // M-FIX2-command', 'return null; // M-FIX2-command'),
    "M-FIX2-copy": (WALK, 'if (direct) doubt("command"); // M-FIX2-copy', 'if (direct) return null; // M-FIX2-copy'),
    "M-FIX2-key": (WALK, 'followLinks(ctx, canonPath(resolved, ctx, "read").path); // M-FIX2-key', 'followLinks(ctx, resolved); // M-FIX2-key'),
    "M-FIX2-current": (WALK, 'if (ctx.written.has(key)) return key; // M-FIX2-current', '// M-FIX2-current removed'),
    "M-FIX2-session": (WALK, 'doubt("unavailable-exec"); // M-FIX2-session', 'return key; // M-FIX2-session'),
    "M-FIX2-shadow": (WALK, 'if (written) return undefined; // M-FIX2-shadow', '// M-FIX2-shadow removed'),
    "M-FIX2-python-root": (WALK, 'doubt("value-path"); // M-FIX2-python-root', 'return "complete"; // M-FIX2-python-root'),
    "M-FIX2-model": (MARKS, 'doubt("tokenizer"); // M-FIX2-model', 'return; // M-FIX2-model'),
    "M-FIX2-option": (MARKS, 'doubt("tokenizer"); // M-FIX2-option\n', 'continue; // M-FIX2-option\n'),
    "M-FIX2-option-value": (MARKS, 'doubt("tokenizer"); // M-FIX2-option-value', 'return; // M-FIX2-option-value'),
    "M-FIX4-first": ("server/always-ask.ts", 'return found && found.rule !== "unreadable" && found.rule !== "protected-path" ? found : null; // M-FIX4-first', 'return null; // M-FIX4-first'),
    "M-R7-awk": (WALK, '|| /system|getline|[|>]|@include|@load|ENVIRON/.test(arg)', '|| false'),
    "M-R7-sed": (MARKS, 'return !flagged && !/[wWrRe]/.test(rest);', 'return true;'),
    "M-R7-env": (MARKS, 'if (STARTUP_ENV.test(name)) doubt("tokenizer"); // M-FIX2-env', 'if (false) doubt("tokenizer"); // M-FIX2-env'),
    "M-X1-exec": (WALK, 'if (execCapableOption(name, marksArgs)) doubt("tokenizer"); // M-X1-exec', 'if (false) doubt("tokenizer"); // M-X1-exec'),
    "M-X1-climb": (WALK, 'protectedWritePath(resolveFrom(ctx.cwd, tail))) doubt("value-path"); // M-X1-climb', 'false) doubt("value-path"); // M-X1-climb'),
    "M-R7-climb": (WALK, 'doubt("value-path"); // M-R7-climb', '// M-R7-climb removed'),
    "M-R7-level": ("server/auto-approve.ts", 'if (!hasNoLimits(bot)) return lax(read);', 'return lax(read);'),
    "M-R10-relief": ("server/auto-approve.ts", 'hit.unseenScript !== true ? lax(read) : strict;', 'hit.unseenScript !== true ? strict : strict;'),
    "M-R10-owner": ("server/auto-approve.ts", 'if (routineCarve || !ownerOwnTurn(bot, context)) return strict;', '// M-R10-owner removed'),
    "M-R10-dd": ("server/always-ask.ts", 'if (cmd.name === "dd" && (texts[index] ?? "").startsWith("if=")) continue;', '// M-R10-dd removed'),
    "M-R10-inline": (WALK, 'if (input.strict) doubt("tokenizer");', 'doubt("tokenizer");'),
    "M-FD-gate": ("server/auto-approve.ts", '(destructive ? keyHit() : null) ?? gateHitSpelled([keyText,', '(destructive ? keyHit() : null) ?? (() => null)([keyText,'),
    "M-FD-redirect": ("server/always-ask.ts", 'if (found) deferred = { rule: "protected-path", what: PROTECTED_WHAT[found], protectedClass: found, program: "redirect" };', '// M-FD-redirect removed'),
    "M-FD-find": ("server/always-ask.ts", '(cmd.name === "find" && cmd.operands', '(false && cmd.operands'),
    "M-FD-sed-w": ("server/always-ask.ts", 'for (const one of wrote) {', 'for (const one of [] as RegExpMatchArray[]) {'),
    "M-FD-archive": ("server/always-ask.ts", 'if (dest !== undefined) {', 'if (false as boolean && dest !== undefined) {'),
    "M-FD-home": ("server/always-ask.ts", 'spelledHome.includes("/..") && HOME ?', 'false && HOME ?'),
    "M-FD-source": ("server/always-ask.ts", 'if (deviceReadPosition(cmd.name, texts, index)) protectDescendants = false;', 'if (false) protectDescendants = false;'),
    "M-FD-ffi": ("server/shell/walk.ts", 'if (OPAQUE_FOREIGN.test(text)) throw', 'if (false) throw'),
    "M-FD-ln": ("server/always-ask.ts", 'if (symlinkTarget(cmd.name, texts, index)) continue; // M-FD-ln', '// M-FD-ln removed'),
    "M-R13-ln-bare": ("server/always-ask.ts", 'if (words.some((one) => one.startsWith("-") && !LN_BARE.test(one))) return false; // M-R13-ln-bare', '// M-R13-ln-bare removed'),
    "M-R13-started": ("server/auto-approve.ts", 'context?.ownerStarted === true && context.fullAccessOrigin === "owner"', 'context?.fullAccessOrigin === "owner"'),
    "M-R11-unseen": ("server/auto-approve.ts", '|| ownerUnseen === true)', '|| false)'),
    "M-R11-unseen-owner": ("server/auto-approve.ts", 'if (routineCarve || !ownerOwnTurn(bot, context)) return false; // M-R11-unseen-owner', 'if (false) return false; // M-R11-unseen-owner'),
    "M-R11-unseen-turn": ("server/auto-approve.ts", 'return false; // M-R11-unseen-turn', '{} // M-R11-unseen-turn'),
    "M-R11-unseen-lane": ("server/auto-approve.ts", 'return false; // M-R11-unseen-lane', '{} // M-R11-unseen-lane'),
    "M-R11-unseen-deny": ("server/auto-approve.ts", 'if (deniedScript) catastrophe = deniedScript; // M-R11-unseen-deny', '// M-R11-unseen-deny removed'),
    "M-R11-unseen-wipe": ("server/auto-approve.ts", 'return !texts.some((t) => t !== undefined && plainWipe(t)); // M-R11-unseen-wipe', 'return true; // M-R11-unseen-wipe'),
    "M-FD-usrlocal": ("server/always-ask.ts", '.test(canonical) || canonical.startsWith("/usr/local/")) return false;', '.test(canonical)) return false;'),
    "M-R7-sysbin": (WALK, 'const systemProgram = direct !== undefined && SYSTEM_PROGRAM.test(direct); // M-R7-sysbin', 'const systemProgram = false; // M-R7-sysbin'),
    "M-FIX2-env": (MARKS, 'doubt("tokenizer"); // M-FIX2-env', 'return; // M-FIX2-env'),
    "M-FIX2-protected": ("server/always-ask.ts", 'return "system"; // M-FIX2-protected', 'return null; // M-FIX2-protected'),
    "M-FIX2-waiver": ("server/auto-approve.ts", 'return false; // M-FIX2-waiver', 'return true; // M-FIX2-waiver'),
    "M-PR-1a": (WALK, r"[A-Za-z0-9_~$}", r"[A-Za-z0-9_.~$}"),
    "M-PR-1b": (WALK, '&& canonPath(value, ctx, "write").value)', '&& false)'),
    "M-PR-1c": (WALK, 'return "incomplete"; // M-PR-1c', 'return "complete"; // M-PR-1c'),
    "M-PR-2": (WALK, 'return undefined; // M-PR-2', 'return "1p"; // M-PR-2'),
    "M-R1-sed": (MARKS, 'text === undefined || !sedProgramReadable(text)', 'false'),
    "M-R1-option": (MARKS, 'flag !== "e" && flag !== "f"', 'false'),
    "M-R1-program": (WALK, 'if (["awk", "gawk", "nawk"].includes(name) && awkRuns(marksArgs)', 'if (false'),
    "M-R1-literal": (MARKS, 'return /[`$@]|#\\{|\\beval\\b|\\bexec\\s*\\(/.test(text);', 'return false;'),
    "M-R1-interpreter-option": (WALK, 'text !== "-e" && text !== "--"', 'false'),
    "M-R1-unknown-option": (WALK, 'const valued = takesValue(key, text); doubt("tokenizer"); if (valued)', 'const valued = takesValue(key, text); if (valued)'),
    "M-R1-format": (WALK, 'const literal = String.raw`(?:"[^"\\\\\\n{}]*"|\'[^\'\\\\\\n{}]*\')`;', 'const literal = String.raw`(?:"[^"\\\\\\n]*"|\'[^\'\\\\\\n]*\')`;'),
    "M-R1-cwd": (WALK, 'ctx.cwdConflict || !ctx.cwd || !isAnchored(ctx.cwd)', 'false'),
    "M-R1-path": ("server/always-ask.ts", '(RISKY.has(cmd.name) || cmd.name === "touch")', 'false'),
    "M-R1-fold": (WALK, 'path = path.toLowerCase();', 'path = path;'),
    "M-R1-resolve": (WALK, 'path = realpathSync.native(next).replaceAll("\\\\", "/");', 'path = next;'),
    "M-R1-target": (WALK, 'if (target) return { file: target[1] ?? target[2]!, last: i };', 'if (false) return { file: "safe", last: i };'),
    "M-R1-dangling": (WALK, 'if (lstatSync(next).isSymbolicLink())', 'if (false)'),
    "M-R1-stdin": (WALK, 'if (file === "-") return undefined;', 'if (false) return undefined;'),
    "M-R1-uncertain": ("server/always-ask.ts", '&& candidate.kind === "value") doubt("value-path"); // M-R1-uncertain', '&& false) doubt("value-path"); // M-R1-uncertain'),
    "M-PR-3a": (WALK, 'parts.includes("proc") && parts.includes("..")', 'parts[0] === "proc" && parts.includes("..")'),
    "M-PR-3b": (WALK, r'return /^\/proc(?:\/|$)/.test(path); // M-PR-3b', 'return false; // M-PR-3b'),
    "M-PR-4": (WALK, 'if (out && canonPath(out.file, ctx, "write").value)', 'if (false)'),
    "M-PR-5a": (WALK, 'doubt("unavailable-exec"); // M-PR-5a', 'return absolute; // M-PR-5a'),
    "M-PR-5b": (WIRE, 'item.lateFrame || source === "interpreter" ? undefined : item.callKey; // M-PR-5b', 'item.callKey; // M-PR-5b'),
    "M-PR-6a": (MARKS, 'return COMPILERS.has(name) && args.some(arg => /(?:^|,)@/.test(arg));', 'return false;'),
    "M-PR-6b": (MARKS, 'return !COMPILERS.has(name) && !reader && args.some(arg => arg.startsWith("@"));', 'return false;'),
    "M-PR-6c": (WALK, 'if (rawName === "xargs" && rawArgs.some', 'if (false && rawArgs.some'),
    "M-PR-6d": (WALK, 'if ((name === "tar" || name === "rsync") && marksArgs.some', 'if (false && marksArgs.some'),
    "M-PR-7": (WALK, 'if (text.length > COMMAND_GATE_CHARS) doubt("scan-gate"); // M-PR-7', 'if (false) doubt("scan-gate"); // M-PR-7'),
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
