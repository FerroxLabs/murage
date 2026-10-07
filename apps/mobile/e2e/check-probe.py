#!/usr/bin/env python3
"""Checks the E2E probe line (E2EProbe.swift / E2EProbe.java) in a shell log.

usage: check-probe.py <shell.log> ios|android
"""
import json
import os
import re
import sys

log, platform = sys.argv[1], sys.argv[2]
lines = [line for line in open(log, encoding="utf-8") if "e2e probe " in line or "murage-e2e " in line]
if not lines:
    sys.exit("no probe line in " + log)
raw = re.split(r"e2e probe |murage-e2e ", lines[-1], maxsplit=1)[1].strip()
# A probe that threw logs "murage-e2e failed …" / "e2e probe failed …": say so, not a traceback.
try:
    probe = json.loads(raw)
except ValueError:
    sys.exit("probe failed: the page reported " + raw[:300])
if not isinstance(probe, dict):
    sys.exit("probe failed: not a probe result: " + raw[:300])
# The one list of methods (P4's contract), not a copy of it (preflight R-2c).
contract = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contract", "channel.json")
advertised = json.load(open(contract, encoding="utf-8"))["methods"]
problems = []
hello = probe.get("hello")
if not isinstance(hello, dict) or hello.get("version") != 1 or hello.get("methods") != advertised:
    problems.append("hello: " + json.dumps(probe.get("hello")))
if probe.get("frameWrapper") != "undefined":
    problems.append("a same-origin subframe got the wrapper: " + str(probe.get("frameWrapper")))
post = str(probe.get("framePost"))
if platform == "ios" and post != "rejected unavailable":
    problems.append("iOS subframe post was not rejected: " + post)
if platform == "android" and not (post == "no-port" or "unavailable" in post):
    problems.append("Android subframe post was not refused: " + post)
if not isinstance(probe.get("save"), dict) or probe["save"].get("saved") is not True:
    problems.append("chunked save failed: " + json.dumps(probe.get("save")))
safe_top = probe.get("safeTop")
if platform == "ios" and safe_top in (None, "0px"):
    problems.append("WebKit reported no top safe area (Decision 1): " + str(safe_top))
if platform == "android" and safe_top != "0px":
    problems.append("Android page saw a safe area, so it would pad twice (Decision 1): " + str(safe_top))
if problems:
    sys.exit("probe failed:\n  " + "\n  ".join(problems))
print("probe ok: " + json.dumps(probe))
