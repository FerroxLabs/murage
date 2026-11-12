"""Run through it-remote.sh; audit the complete historical G-MARC test union.

run OUTPUT runs every file and full typecheck, preserving historical fixtures.
audit --vitest REPORT (repeatable) --electron REPORT checks executed coverage.
A complete report can contain failures; run still returns nonzero for failures.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((Path(__file__).parent / "test-set.json").read_text())


def relative(name):
    # Vitest reports retain the container's /work prefix after archival.
    return next((p for p in MANIFEST["vitest"] if name == p or name.endswith("/" + p)), name)


def audit(vitest, electron):
    expected = set(MANIFEST["vitest"] + MANIFEST["electron"])
    historical = set()
    for source in MANIFEST["sources"]:
        historical.update(re.findall(
            r"\b(?:server|src|shared|electron)/[\w./-]+\.(?:test\.(?:ts|mjs)|node-test\.mjs)",
            (ROOT / source).read_text()))
    assert historical == expected, "manifest must equal the historical verify/finish union"
    actual = set()
    for report in vitest:
        for result in json.loads(Path(report).read_text())["testResults"]:
            if result["assertionResults"] and result["status"] in ("passed", "failed"):
                actual.add(relative(result["name"]))
    if electron:
        for result in json.loads(Path(electron).read_text()):
            if result["tests"] > 0 and result["exit"] in (0, 1):
                actual.add(result["file"])
    missing = sorted(expected - actual)
    print(json.dumps({"expectedFiles": len(expected), "coveredFiles": len(expected & actual),
                      "missing": missing}, indent=2))
    return not missing


def run(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    commands = []

    def command(argv, log):
        with (output / log).open("w") as stream:
            result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
        commands.append({"argv": argv, "log": log, "exit": result.returncode})
        (output / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        return result.returncode

    # Workflows write pinned-URL wait/messages and server logs here. Archive
    # each changed artifact before restoring the previous lane's evidence.
    dirs = [ROOT / "lane-evidence" / name for name in (
        "connector-reconnect", "connector-reconnect-r1", "connector-reconnect-r2", "connector-reconnect-r3")]
    original = {p: p.read_bytes() for d in dirs for p in d.rglob("*") if p.is_file()}
    try:
        vitest = command(["node_modules/.bin/vitest", "run", *MANIFEST["vitest"],
                          "--reporter=default", "--reporter=json", "--outputFile=" + str(output / "vitest.json")], "vitest.log")
        electron = []
        for file in MANIFEST["electron"]:
            log = Path(file).name + ".log"
            code = command(["node", "--import", "./server/testing/safe-wipe-preload.mjs", "--test", "--test-reporter=tap", file], log)
            content = (output / log).read_text()
            counts = {key: int(value) for key, value in re.findall(r"^# (tests|pass|fail|skipped) (\d+)$", content, re.M)}
            electron.append({"file": file, "exit": code, **counts})
        (output / "electron.json").write_text(json.dumps(electron, indent=2) + "\n")
        types = command(["pnpm", "typecheck"], "typecheck.log")
        coverage = audit([output / "vitest.json"], output / "electron.json")
        summary = {"vitestExit": vitest, "electron": electron, "typecheckExit": types, "coverageComplete": coverage}
        (output / "status.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
        return coverage and vitest == 0 and types == 0 and all(row["exit"] == 0 for row in electron)
    finally:
        for directory in dirs:
            for path in directory.rglob("*"):
                if not path.is_file():
                    continue
                data = path.read_bytes()
                if original.get(path) != data:
                    target = output / "fixtures" / path.relative_to(ROOT)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    if path in original:
                        path.write_bytes(original[path])
                    else:
                        path.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("output")
    checker = sub.add_parser("audit")
    checker.add_argument("--vitest", action="append", default=[])
    checker.add_argument("--electron")
    args = parser.parse_args()
    ok = run(args.output) if args.mode == "run" else audit(args.vitest, args.electron)
    raise SystemExit(0 if ok else 1)
