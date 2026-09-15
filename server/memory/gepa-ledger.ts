import { createHash } from "node:crypto";
import { database, transaction } from "../database.ts";
import { GEPA_FRAME_BYTES, gepaEvaluationSchema, validateGepaReflection, type GepaJson } from "../gepa-protocol.ts";
import type { GepaCallLedger } from "../gepa-worker.ts";
import type { ProcedureEvidence } from "./procedure-review.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface GepaLedgerOptions {
  scopeId: string;
  jobId: string;
  snapshotDigest: string;
  evidence: ProcedureEvidence[];
  maxMetricCalls: number;
  maxReflections: number;
  /** Current source/audience and evaluator authority, checked before each call. */
  assertCurrent(): void;
}
interface Call {
  callId: string;
  inputHash: string;
  kind: "evaluate" | "reflect";
  state: "reserved" | "complete" | "revoked" | "not-started";
  value?: GepaJson;
  valueHash?: string;
}

/** This ledger prevents duplicate external calls. It does not invent a model
 * price or turn unknown provider cost into zero; the host owns spend admission. */
export function createGepaCallLedger(options: GepaLedgerOptions): GepaCallLedger {
  if (!/^[a-f0-9]{64}$/.test(options.snapshotDigest) || !/^[A-Za-z0-9._:-]{1,180}$/.test(options.jobId) ||
      !Number.isSafeInteger(options.maxMetricCalls) || options.maxMetricCalls < 1 || options.maxMetricCalls > 24 ||
      !Number.isSafeInteger(options.maxReflections) || options.maxReflections < 1 || options.maxReflections > 2) throw new Error("GEPA_LEDGER_IDENTITY_INVALID");
  if (!Array.isArray(options.evidence) || options.evidence.length > 64 || options.evidence.some(item => !["source", "record"].includes(item.kind) || typeof item.id !== "string" || !item.id || !Number.isSafeInteger(item.revision) || item.revision < 1)) throw new Error("GEPA_LEDGER_EVIDENCE_INVALID");
  options.assertCurrent();
  const jobKey = `gepa-job:${hash(options.jobId)}`;
  const identity = { v: 1, jobId: options.jobId, snapshotDigest: options.snapshotDigest, scopeId: options.scopeId, evidence: structuredClone(options.evidence), maxMetricCalls: options.maxMetricCalls, maxReflections: options.maxReflections };
  transaction(db => {
    if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(options.scopeId)) throw new Error("GEPA_LEDGER_SCOPE_UNAVAILABLE");
    const prior = db.prepare("SELECT scope_id,state,intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='gepa-job'").get(jobKey);
    if (prior) {
      if (prior.state !== "granted") throw new Error("GEPA_LEDGER_REVOKED");
      if (prior.scope_id !== options.scopeId || String(prior.intent) !== JSON.stringify(identity)) throw new Error("GEPA_LEDGER_IDENTITY_CONFLICT");
    } else db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','gepa-job',1,'granted',?)").run(jobKey, options.scopeId, JSON.stringify(identity));
  });
  const callKey = (callId: string) => {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(callId) || !callId.startsWith(options.jobId + ":")) throw new Error("GEPA_LEDGER_CALL_INVALID");
    return `gepa-call:${hash([options.jobId, callId])}`;
  };
  const read = (callId: string): Call | undefined => {
    const row = database().prepare("SELECT state,intent FROM memory_scope_bindings WHERE id=? AND scope_id=? AND subject_type='system' AND subject_id=?").get(callKey(callId), options.scopeId, jobKey);
    if (!row) return undefined;
    const call = JSON.parse(String(row.intent)) as Call;
    return row.state === "granted" ? call : { ...call, state: "revoked", value: undefined };
  };
  const save = (call: Call) => database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(callKey(call.callId), options.scopeId, jobKey, JSON.stringify(call));
  const assertHash = (inputHash: string) => { if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error("GEPA_LEDGER_INPUT_INVALID"); };
  return {
    lookupOrReserve(callId, inputHash, kind) {
      assertHash(inputHash);
      if (kind !== "evaluate" && kind !== "reflect") throw new Error("GEPA_LEDGER_CALL_INVALID");
      options.assertCurrent();
      return transaction(db => {
        options.assertCurrent();
        const prior = read(callId);
        if (prior) {
          if (prior.inputHash !== inputHash || prior.kind !== kind) throw new Error("GEPA_LEDGER_INPUT_CONFLICT");
          if (prior.state === "complete") {
            if (prior.value === undefined || prior.valueHash !== hash(prior.value)) throw new Error("GEPA_LEDGER_RECEIPT_INVALID");
            return { state: "complete" as const, value: structuredClone(prior.value) };
          }
          if (prior.state !== "not-started") throw new Error(prior.state === "revoked" ? "GEPA_LEDGER_REVOKED" : "GEPA_CALL_OUTCOME_UNCERTAIN");
        }
        const count = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? AND json_extract(intent,'$.kind')=? AND json_extract(intent,'$.state')!='not-started'").get(jobKey, kind)!.count);
        if (count >= (kind === "reflect" ? options.maxReflections : options.maxMetricCalls)) throw new Error("GEPA_LEDGER_CALL_LIMIT");
        save({ callId, inputHash, kind, state: "reserved" });
        return { state: "new" as const };
      });
    },
    releaseNotStarted(callId, inputHash) {
      transaction(() => {
        const prior = read(callId);
        if (!prior || prior.inputHash !== inputHash || prior.state !== "reserved") throw new Error("GEPA_LEDGER_RELEASE_INVALID");
        save({ ...prior, state: "not-started" });
      });
    },
    complete(callId, inputHash, value) {
      assertHash(inputHash);
      transaction(() => {
        const prior = read(callId);
        if (!prior || prior.inputHash !== inputHash) throw new Error("GEPA_LEDGER_INPUT_CONFLICT");
        const parsed: GepaJson = prior.kind === "evaluate" ? gepaEvaluationSchema.parse(value)
          : validateGepaReflection(typeof value === "string" ? value : (() => { throw new Error("GEPA_LEDGER_RECEIPT_INVALID"); })());
        if (Buffer.byteLength(JSON.stringify(parsed)) > GEPA_FRAME_BYTES) throw new Error("GEPA_LEDGER_RECEIPT_LIMIT");
        const valueHash = hash(parsed);
        if (prior.state === "complete") {
          if (prior.valueHash !== valueHash) throw new Error("GEPA_LEDGER_RECEIPT_CONFLICT");
          return;
        }
        if (prior.state !== "reserved") throw new Error("GEPA_LEDGER_REVOKED");
        try { options.assertCurrent(); }
        catch {
          // Keep proof of the known response, but no newly revoked content.
          save({ ...prior, state: "revoked", valueHash });
          return;
        }
        save({ ...prior, state: "complete", value: parsed, valueHash });
      });
      const completed = read(callId);
      if (completed?.state !== "complete") throw new Error("GEPA_LEDGER_REVOKED");
    },
  };
}
