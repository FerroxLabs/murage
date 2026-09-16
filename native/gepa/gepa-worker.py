"""Pinned GEPA optimizer worker. One job, parent-owned RPC, no provider access."""
from __future__ import annotations

import importlib.metadata
import json
import math
import os
import queue
import re
import sys
import threading
import time

VERSION = "0.1.4"
MAX_FRAME = 1024 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,200}\Z")
PROTOCOL = sys.stdout.buffer
# Upstream incidental output must never enter the parent's JSONL stream.
sys.stdout = sys.stderr


class Failure(BaseException):
    # Upstream reflection catches Exception and retries a failed batch per
    # component. Protocol/budget/cancellation failures must escape that retry;
    # only the parent's durable ledger may decide whether a call can resume.
    pass


def require(condition, code="PROTOCOL_INVALID"):
    if not condition:
        raise Failure(code)


def fields(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected))


def integer(value, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def identifier(value):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None)
    return value


def candidate(value):
    fields(value, {"instruction"})
    require(isinstance(value["instruction"], str) and 0 < len(value["instruction"]) <= 20000)
    require(bool(value["instruction"].strip()) and "\x00" not in value["instruction"])
    return {"instruction": value["instruction"]}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(_value):
    raise Failure("PROTOCOL_INVALID")


def decode(raw):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
        pending, count = [(value, 0)], 0
        while pending:
            item, depth = pending.pop()
            count += 1
            require(depth <= 32 and count <= 50000, "FRAME_COMPLEXITY_LIMIT")
            if isinstance(item, (dict, list)):
                pending.extend((child, depth + 1) for child in
                               (item.values() if isinstance(item, dict) else item))
            elif isinstance(item, float):
                require(math.isfinite(item))
        require(isinstance(value, dict) and type(value.get("v")) is int and value["v"] == 1)
        return value
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Failure("PROTOCOL_INVALID") from error


def send(kind, **payload):
    raw = json.dumps({"v": 1, "type": kind, **payload}, ensure_ascii=True,
                     allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
    require(len(raw) <= MAX_FRAME, "FRAME_LIMIT")
    PROTOCOL.write(raw)
    PROTOCOL.flush()


class Transport:
    def __init__(self):
        self.frames = queue.Queue(maxsize=2)
        self.job_id = None
        self.error = None
        self.cancelled = threading.Event()
        self.deadline = time.monotonic() + 30
        self.counters = {"evaluate": 0, "reflect": 0}
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        # os.read avoids a daemon thread holding stdin's buffered-reader lock
        # during interpreter shutdown. The queue and unframed buffer are bounded.
        buffer = bytearray()
        try:
            while True:
                chunk = os.read(0, 4096)
                if not chunk:
                    raise Failure("PARENT_CLOSED")
                buffer.extend(chunk)
                while b"\n" in buffer:
                    end = buffer.index(b"\n") + 1
                    require(end <= MAX_FRAME, "FRAME_LIMIT")
                    frame = decode(bytes(buffer[:end]))
                    del buffer[:end]
                    if frame.get("type") == "cancel":
                        fields(frame, {"v", "type", "jobId"})
                        require(self.job_id is not None and frame["jobId"] == self.job_id)
                        self.cancelled.set()
                    else:
                        try:
                            self.frames.put_nowait(frame)
                        except queue.Full as error:
                            raise Failure("FRAME_QUEUE_LIMIT") from error
                require(len(buffer) < MAX_FRAME, "FRAME_LIMIT")
        except Failure as error:
            self.error = str(error)
        except OSError:
            self.error = "PARENT_READ_FAILED"

    def check(self):
        if self.cancelled.is_set():
            raise Failure("CANCELLED")
        if self.error:
            raise Failure(self.error)
        require(time.monotonic() < self.deadline, "WALL_LIMIT")

    def receive(self):
        while True:
            self.check()
            try:
                return self.frames.get(timeout=min(0.05, max(0.001, self.deadline - time.monotonic())))
            except queue.Empty:
                continue

    def call(self, kind, **payload):
        self.check()
        self.counters[kind] += 1
        call_id = f"{self.job_id}:{kind}:{self.counters[kind]}"
        send(kind, jobId=self.job_id, callId=call_id, **payload)
        response = self.receive()
        require(response.get("jobId") == self.job_id and response.get("callId") == call_id,
                "CALL_CORRELATION_INVALID")
        if response.get("type") == "call-error":
            fields(response, {"v", "type", "jobId", "callId", "code"})
            identifier(response["code"])
            raise Failure("PARENT_CALL_FAILED")
        require(response.get("type") == f"{kind}-result")
        return response


class StderrLogger:
    def log(self, _message):
        # GEPA log messages can contain complete candidate text. Keep diagnostics
        # on stderr but disclose only a bounded stage marker, never source traces.
        print("gepa: optimizer progress", file=sys.stderr, flush=True)


class Decisions:
    def __init__(self):
        self.events = []

    def add(self, value):
        # Fail closed instead of silently truncating the decision receipt.
        require(len(self.events) < 16, "DECISION_LIMIT")
        self.events.append(value)

    def on_proposal_end(self, event):
        self.add({"type": "proposal", "iteration": event["iteration"],
                  "candidate": candidate(event["new_instructions"])})

    def on_candidate_rejected(self, event):
        self.add({"type": "rejected", "iteration": event["iteration"],
                  "oldScore": event["old_score"], "newScore": event["new_score"],
                  "reason": str(event["reason"])[:1000]})

    def on_candidate_accepted(self, event):
        self.add({"type": "accepted", "iteration": event["iteration"],
                  "candidateIndex": event["new_candidate_idx"], "newScore": event["new_score"],
                  "parents": list(event["parent_ids"])})


class Adapter:
    propose_new_texts = None

    def __init__(self, transport, allowed_ids, maximum, batch_type):
        self.transport, self.allowed_ids = transport, allowed_ids
        self.maximum, self.batch_type, self.metric_calls = maximum, batch_type, 0

    def evaluate(self, batch, program, capture_traces=False):
        require(isinstance(batch, list) and 0 < len(batch) <= 24)
        require(all(item in self.allowed_ids for item in batch), "CASE_NOT_ALLOWED")
        require(self.metric_calls + len(batch) <= self.maximum, "METRIC_LIMIT")
        self.metric_calls += len(batch)
        response = self.transport.call("evaluate", candidate=candidate(program),
                                       caseIds=list(batch), captureTraces=bool(capture_traces))
        fields(response, {"v", "type", "jobId", "callId", "outputs", "scores", "trajectories"})
        outputs, scores, trajectories = response["outputs"], response["scores"], response["trajectories"]
        require(isinstance(outputs, list) and isinstance(scores, list)
                and len(outputs) == len(scores) == len(batch), "EVALUATION_ALIGNMENT_INVALID")
        require(all(type(score) in (int, float) and math.isfinite(score) for score in scores),
                "EVALUATION_SCORE_INVALID")
        if capture_traces:
            require(isinstance(trajectories, list) and len(trajectories) == len(batch),
                    "EVALUATION_ALIGNMENT_INVALID")
            trajectories = [{"caseId": item, "trace": trace}
                            for item, trace in zip(batch, trajectories, strict=True)]
        else:
            require(trajectories is None, "EVALUATION_ALIGNMENT_INVALID")
        return self.batch_type(outputs=outputs, scores=scores, trajectories=trajectories,
                               num_metric_calls=len(batch))

    def make_reflective_dataset(self, program, evaluation, components_to_update):
        candidate(program)
        require(components_to_update == ["instruction"] and evaluation.trajectories is not None)
        return {"instruction": [{"Case ID": trace["caseId"], "Output": output,
                                  "Score": score, "Feedback": trace["trace"]}
                                 for trace, output, score in zip(evaluation.trajectories,
                                                                evaluation.outputs, evaluation.scores, strict=True)]}


def optimize(transport, job):
    fields(job, {"v", "type", "jobId", "candidate", "trainIds", "validationIds", "limits", "randomSeed"})
    require(job["type"] == "start")
    transport.job_id = identifier(job["jobId"])
    program = candidate(job["candidate"])
    for key in ("trainIds", "validationIds"):
        require(isinstance(job[key], list) and 1 <= len(job[key]) <= 24)
        for item in job[key]:
            identifier(item)
        require(len(set(job[key])) == len(job[key]))
    require(not set(job["trainIds"]) & set(job["validationIds"]), "CORPUS_OVERLAP")
    fields(job["limits"], {"maxMetricCalls", "maxReflections", "wallMs"})
    metric_limit = integer(job["limits"]["maxMetricCalls"], 1, 24)
    reflection_limit = integer(job["limits"]["maxReflections"], 1, 2)
    wall_ms = integer(job["limits"]["wallMs"], 1, 30000)
    random_seed = integer(job["randomSeed"], 0, 2147483647)
    transport.deadline = time.monotonic() + wall_ms / 1000
    # The parent also enforces this deadline. Exit bounds a blocked stdout write
    # or upstream CPU loop where a cooperative stop callback cannot run.
    watchdog = threading.Timer(wall_ms / 1000, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    try:
        import gepa
        adapter = Adapter(transport, set(job["trainIds"] + job["validationIds"]), metric_limit, gepa.EvaluationBatch)
        decisions = Decisions()

        def reflect(prompt):
            require(isinstance(prompt, str), "REFLECTION_TEXT_REQUIRED")
            require(transport.counters["reflect"] < reflection_limit, "REFLECTION_LIMIT")
            response = transport.call("reflect", prompt=prompt)
            fields(response, {"v", "type", "jobId", "callId", "text"})
            text = response["text"]
            require(isinstance(text, str), "REFLECTION_FENCE_INVALID")
            match = re.fullmatch(r"```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```", text.strip())
            require(match is not None, "REFLECTION_FENCE_INVALID")
            candidate({"instruction": match.group(1).strip()})
            return text.strip()

        def stop(_state):
            transport.check()
            return transport.counters["reflect"] >= reflection_limit

        result = gepa.optimize(seed_candidate=program, trainset=job["trainIds"], valset=job["validationIds"],
                               adapter=adapter, reflection_lm=reflect, max_metric_calls=metric_limit,
                               stop_callbacks=stop, reflection_minibatch_size=min(2, len(job["trainIds"])),
                               candidate_selection_strategy="pareto", acceptance_criterion="strict_improvement",
                               use_merge=False, skip_perfect_score=False, use_wandb=False, use_mlflow=False,
                               display_progress_bar=False, use_cloudpickle=False, cache_evaluation=False,
                               track_best_outputs=False, run_dir=None, logger=StderrLogger(),
                               callbacks=[decisions], seed=random_seed, raise_on_exception=True)
        transport.check()
        require(result.total_metric_calls == adapter.metric_calls, "METRIC_ACCOUNTING_MISMATCH")
        send("result", jobId=transport.job_id, bestCandidate=candidate(result.best_candidate),
             bestIndex=result.best_idx, candidates=[candidate(item) for item in result.candidates],
             parents=result.parents, validationScores=result.val_aggregate_scores,
             metricCalls=result.total_metric_calls, reflectionCalls=transport.counters["reflect"],
             decisionEvents=decisions.events)
    finally:
        watchdog.cancel()


def main():
    transport = None
    try:
        require(sys.implementation.name == "cpython" and (3, 10) <= sys.version_info[:2] < (3, 15), "PYTHON_UNSUPPORTED")
        require(importlib.metadata.version("gepa") == VERSION, "GEPA_PIN_MISMATCH")
        send("ready", gepaVersion=VERSION, pythonVersion=".".join(str(part) for part in sys.version_info[:3]))
        transport = Transport()
        optimize(transport, transport.receive())
        return 0
    except Failure as error:
        send("failed", jobId=transport.job_id if transport else None, code=str(error))
        return 1
    except (Exception, KeyboardInterrupt):
        # Raw upstream exceptions may contain private evaluation content.
        send("failed", jobId=transport.job_id if transport else None, code="WORKER_FAILED")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
