import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askSchema, askAnswerSchema, askLiveBodySchema, askProofRecordSchema } from "./phone-ask-contract.ts";

const fx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-ask-proof.json", import.meta.url), "utf8"));
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("D8 shared proof fixtures", () => {
  it("accepts plain, want and strict submitted proofs", () => {
    for (const body of [fx.request, { ...fx.request, proof: "want" }, { ...fx.request, proof: fx.proof }]) {
      expect(askSchema.safeParse(body).success).toBe(true);
    }
    for (const bad of fx.invalidRequests) expect(askSchema.safeParse({ ...fx.request, proof: bad.proof }).success, bad.name).toBe(false);
    expect(askSchema.safeParse({ ...fx.request, proof: fx.proof, askOwnerProof: true }).success).toBe(false);
  });

  it("requires device, thread and a strict challenge on confirm; sent always declares proven", () => {
    for (const answer of [fx.confirm, ...fx.answers]) expect(askAnswerSchema.safeParse(answer).success).toBe(true);
    for (const key of ["deviceId", "threadId", "challenge"]) {
      const answer = { ...fx.confirm }; delete answer[key];
      expect(askAnswerSchema.safeParse(answer).success, key).toBe(false);
    }
    for (const patch of [{ v: 2 }, { decision: "allow-task" }, { nonce: "x" }, { digest: "x" }, { expiresAt: 0 }, { expiresAt: 9007199254740992 }, { extra: true }]) {
      expect(askAnswerSchema.safeParse({ ...fx.confirm, challenge: { ...fx.confirm.challenge, ...patch } }).success).toBe(false);
    }
    const sent = { ...fx.answers[2] }; delete sent.proven;
    expect(askAnswerSchema.safeParse(sent).success).toBe(false);
    expect(askAnswerSchema.safeParse({ ...sent, proven: "true" }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ state: "plain", challenge: fx.confirm.challenge }).success).toBe(false);
  });

  it("pins the digest of the shown text and confirm-device-mismatch refusal fixture", () => {
    expect(sha256(fx.request.text)).toBe(fx.record.rawTextHash);
    expect(sha256(["murage-ask/1", fx.record.deviceId, fx.request.askId, fx.request.botId, fx.confirm.threadId, fx.record.rawTextHash].join("\n"))).toBe(fx.record.digest);
    expect(fx.confirm.challenge.digest).toBe(fx.record.digest);
    expect(fx.confirmationCases.map((c: { name: string }) => c.name)).toEqual(["confirm-device-match", "confirm-device-mismatch"]);
    for (const c of fx.confirmationCases) {
      expect(c.pairedDeviceId === fx.confirm.deviceId, c.name).toBe(c.sign);
      expect(c.fallback).toBe(!c.sign);
    }
  });

  it("requires every v1 record field and rejects malformed fields without coercion", () => {
    expect(askProofRecordSchema.safeParse(fx.record).success).toBe(true);
    for (const key of Object.keys(fx.record)) {
      const record = { ...fx.record }; delete record[key];
      expect(askProofRecordSchema.safeParse(record).success, key).toBe(false);
    }
    for (const bad of fx.invalidRecords) {
      const record = { ...fx.record, ...bad.patch }; if (bad.omit) delete record[bad.omit];
      expect(askProofRecordSchema.safeParse(record).success, bad.name).toBe(false);
    }
  });

  it("accepts only strict live/not-live bodies with 1-64 answers and safe generations", () => {
    for (const body of [fx.askLive.body, fx.askLive.notLive]) expect(askLiveBodySchema.safeParse(body).success).toBe(true);
    const entry = fx.askLive.body.answers[0];
    for (const generation of [0, Number.MAX_SAFE_INTEGER]) expect(askLiveBodySchema.safeParse({ answers: [{ ...entry, generation }] }).success).toBe(true);
    for (const bad of fx.askLive.invalidEntries) {
      const changed = { ...entry, ...bad.patch }; if (bad.omit) delete changed[bad.omit];
      expect(askLiveBodySchema.safeParse({ answers: [changed] }).success, bad.name).toBe(false);
    }
    for (const count of [1, 64]) expect(askLiveBodySchema.safeParse({ answers: Array(count).fill(entry) }).success).toBe(true);
    for (const count of [0, 65]) expect(askLiveBodySchema.safeParse({ answers: Array(count).fill(entry) }).success).toBe(false);
    expect(askLiveBodySchema.safeParse({ ...fx.askLive.body, extra: true }).success).toBe(false);
    expect(askLiveBodySchema.safeParse({ answers: [{ ...fx.askLive.notLive.answers[0], keyId: entry.keyId }] }).success).toBe(false);
  });
});
