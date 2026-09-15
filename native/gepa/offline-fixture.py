"""Explicit offline parent fixture; never installs dependencies or calls models.

After root authorizes execution:
  <python> native/gepa/offline-fixture.py -- <worker command and arguments>
This is actual GEPA with scripted reflection, not model-generated improvement.
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time

MAX_FRAME = 1024 * 1024
SEED = "For each input, add offset=0.\n\nExample:\n```text\nsample\n```"
BAD = SEED.replace("offset=0", "offset=-1")
GOOD = SEED.replace("offset=0", "offset=1")
CASES = {"train-1": 1, "train-2": 2, "val-3": 3, "val-4": 4}
# Untouched holdout remains solely in this parent and is absent from job frames.
HOLDOUT = [5, 6]


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


class Child:
    def __init__(self, command):
        # Explicit command only; no shell, profile discovery, inherited credentials
        # or PYTHONPATH. Existing development qualification uses an isolated venv.
        env = {key: os.environ[key] for key in ("SystemRoot", "TMPDIR", "TEMP", "TMP") if key in os.environ}
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env)
        self.frames = queue.Queue()
        self.reader = threading.Thread(target=self.read_frames, daemon=True)
        self.reader.start()

    def read_frames(self):
        try:
            while True:
                raw = self.process.stdout.readline(MAX_FRAME + 1)
                if not raw:
                    self.frames.put(None)
                    return
                require(len(raw) <= MAX_FRAME and raw.endswith(b"\n"), "invalid child frame")
                self.frames.put(json.loads(raw))
        except BaseException as error:
            self.frames.put(error)

    def send(self, frame):
        self.process.stdin.write(json.dumps(frame, allow_nan=False).encode("utf-8") + b"\n")
        self.process.stdin.flush()

    def next(self):
        frame = self.frames.get(timeout=35)
        if isinstance(frame, BaseException):
            raise frame
        return frame

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def start(child, name, limits=None):
    ready = child.next()
    require(ready and ready["type"] == "ready" and ready["gepaVersion"] == "0.1.4", "actual pinned GEPA required")
    child.send({"v": 1, "type": "start", "jobId": name, "candidate": {"instruction": SEED},
                "trainIds": ["train-1", "train-2"], "validationIds": ["val-3", "val-4"],
                "limits": limits or {"maxMetricCalls": 24, "maxReflections": 2, "wallMs": 30000}, "randomSeed": 0})
    return ready


def response(frame):
    instruction = frame["candidate"]["instruction"]
    match = re.search(r"offset=(-?\d+)", instruction)
    require(match is not None, "fixture candidate format")
    offset = int(match.group(1))
    inputs = [CASES[case_id] for case_id in frame["caseIds"]]
    outputs = [value + offset for value in inputs]
    scores = [1 / (1 + abs(actual - (value + 1))) for value, actual in zip(inputs, outputs, strict=True)]
    return {"v": 1, "type": "evaluate-result", "jobId": frame["jobId"], "callId": frame["callId"],
            "outputs": outputs, "scores": scores,
            "trajectories": [{"input": value, "expected": value + 1, "actual": actual,
                              "diagnostic": "Check the observed result against the required offset."}
                             for value, actual in zip(inputs, outputs, strict=True)] if frame["captureTraces"] else None}


def cycle(command, unchanged=False):
    child = Child(command)
    try:
        ready = start(child, "synthetic-cycle")
        reflections, metric_calls, seen = 0, 0, set()
        evaluation_requests = []
        while True:
            frame = child.next()
            require(frame is not None and frame["jobId"] == "synthetic-cycle", "unexpected child termination/job")
            if frame["type"] == "result":
                break
            require(frame["type"] in ("evaluate", "reflect"), f"unexpected frame: {frame}")
            require(frame["callId"] not in seen, "duplicate RPC")
            seen.add(frame["callId"])
            if frame["type"] == "evaluate":
                evaluation_requests.append({"caseIds": frame["caseIds"], "captureTraces": frame["captureTraces"]})
                metric_calls += len(frame["caseIds"])
                require(metric_calls <= 24, "metric cap exceeded")
                child.send(response(frame))
            else:
                reflections += 1
                require(reflections <= 2, "reflection cap exceeded")
                require("expected" in frame["prompt"] and "actual" in frame["prompt"], "missing real diagnostic traces")
                child.send({"v": 1, "type": "reflect-result", "jobId": frame["jobId"], "callId": frame["callId"],
                            "text": "```\n" + (SEED if unchanged else BAD if reflections == 1 else GOOD) + "\n```"})
        require(child.process.wait(timeout=5) == 0, "result requires zero exit")
        expected = SEED if unchanged else GOOD
        require(frame["bestCandidate"] == {"instruction": expected}, "entire nested-code instruction must roundtrip")
        require(frame["metricCalls"] == metric_calls and frame["reflectionCalls"] == reflections == 2, "accounting mismatch")
        proposals = [event["candidate"] for event in frame["decisionEvents"] if event["type"] == "proposal"]
        expected_proposals = [{"instruction": SEED}, {"instruction": SEED}] if unchanged else [{"instruction": BAD}, {"instruction": GOOD}]
        require(proposals == expected_proposals, "actual proposals required")
        require([event["type"] for event in frame["decisionEvents"] if event["type"] != "proposal"] ==
                (["rejected", "rejected"] if unchanged else ["rejected", "accepted"]),
                "upstream reject/select events required")
        require(frame["candidates"][frame["bestIndex"]] == frame["bestCandidate"], "best index mismatch")
        require(frame["validationScores"][frame["bestIndex"]] == (0.5 if unchanged else 1), "validation score mismatch")
        offset = int(re.search(r"offset=(-?\d+)", frame["bestCandidate"]["instruction"]).group(1))
        heldout_scores = [1 / (1 + abs((value + offset) - (value + 1))) for value in HOLDOUT]
        require(all(score == (0.5 if unchanged else 1) for score in heldout_scores), "untouched holdout score mismatch")
        if unchanged:
            require(len(frame["candidates"]) == 1 and frame["bestIndex"] == 0 and metric_calls == 10,
                    "unchanged reflection must retain only the seed after actual child evaluations")
        return {"scenario": "actual-gepa-unchanged-reflection" if unchanged else "actual-gepa-scripted-reflection", "pythonVersion": ready["pythonVersion"],
                "metricCalls": metric_calls, "reflectionCalls": reflections, "nestedFencePreserved": True,
                "heldoutCases": len(HOLDOUT), "decisionTypes": [event["type"] for event in frame["decisionEvents"]],
                "evaluationRequests": evaluation_requests, "decisionEvents": frame["decisionEvents"]}
    finally:
        child.close()


def refusal(command, mode):
    child = Child(command)
    try:
        start(child, "synthetic-refusal", {"maxMetricCalls": 24, "maxReflections": 2, "wallMs": 500} if mode == "wall" else None)
        frame = child.next()
        require(frame and frame["type"] == "evaluate", "seed evaluation required")
        if mode == "cancel":
            child.send({"v": 1, "type": "cancel", "jobId": frame["jobId"]})
        elif mode == "alignment":
            reply = response(frame)
            reply["scores"] = []
            child.send(reply)
        elif mode == "correlation":
            reply = response(frame)
            reply["callId"] += "-forged"
            child.send(reply)
        elif mode == "wall":
            pass  # Deliberately do not answer the child's pending request.
        terminal = child.next()
        code = child.process.wait(timeout=5)
        require(code != 0, "refused worker must not exit zero")
        if mode == "wall":
            require(code == 124 or terminal and terminal.get("code") == "WALL_LIMIT", "wall limit must stop worker")
        else:
            expected = {"cancel": "CANCELLED", "alignment": "EVALUATION_ALIGNMENT_INVALID", "correlation": "CALL_CORRELATION_INVALID"}[mode]
            require(terminal and terminal["type"] == "failed" and terminal["code"] == expected, "wrong refusal")
        return {"scenario": mode, "exitCode": code}
    finally:
        child.close()


def main():
    require(len(sys.argv) > 2 and sys.argv[1] == "--", "supply -- followed by an explicit worker command")
    command = sys.argv[2:]
    began = time.monotonic()
    results = [cycle(command), cycle(command, unchanged=True)]
    results.extend(refusal(command, mode) for mode in ("alignment", "correlation", "cancel", "wall"))
    print(json.dumps({"classification": "offline-fixture-scripted-reflection", "scenarios": results,
                      "elapsedSeconds": time.monotonic() - began}, allow_nan=False))


if __name__ == "__main__":
    main()
