// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for COMBINED verdicts added in r3.4d s23 (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
import { CHECKER } from "../invariants.current.ts";
import { ticks, from, run, base, tick, d, ls, remHist, send, rq, removeA, withToken, clone, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];

// quiescenceReachable#34 (stricter, was a must-accept witness, now invalid: admissionPinned admits owner.* only for an owner principal): an ok Remove by bot_credential that creates no authority, then a fair suffix. Original skips it (not an owner principal); mutant judges it and finds no Remove authority. admissionPinned rejects it.
SEPARATING.push({ id: "sep-quiescenceReachable-34-non-owner-ok-remove", invariant: "quiescenceReachable", settled: false,
  trace: run(withToken(), [[removeA("tB", { principal: "bot_credential" })], ...ticks(CHECKER.livenessBound)]) });

// removalSendNeedsSendingLease#19 (`x.copyOf === null`): an earlier request of the SAME attempt, kind and target that is a COPY naming a request that does not exist. Original: copies are not counted, accepts; mutant: counts it, rejects.
// environmentWellFormed (new rule: a copy names an existing request) rejects the orphan copy.
const lsS = () => ls({ phase: "sending", attemptId: "at1", attempts: ["at1"], keyTargets: [{ keyId: "k1", status: "pending" }] } as never);
const revoke = (id: string) => [[send(rq({ requestId: id, kind: "REVOKE_KEY", target: "k1", removalId: "L1", attemptId: "at1", authorityId: "aR" } as never))]] as never;
SEPARATING.push({ id: "sep-removalSendNeedsSendingLease-19-orphan-copy-counts", invariant: "removalSendNeedsSendingLease", settled: false,
  trace: run(from(w => { remHist(w); w.local.leases.L1 = lsS(); w.flux.requests.push(rq({ requestId: "v0", copyOf: "ghost", kind: "REVOKE_KEY", target: "k1", removalId: "L1", attemptId: "at1", authorityId: "aR" } as never)); }), revoke("v1")) });

// removalSendNeedsSendingLease#20 (`x.kind === r.kind`): an earlier request of the same attempt and target (k1) but another KIND (DELETE_INBOX on an inbox whose id is the key id k1). Original: kinds differ, accepts; mutant: counts it, rejects.
// environmentWellFormed (new rule: inbox and key ids are disjoint) rejects the inbox k1 beside the key k1.
SEPARATING.push({ id: "sep-removalSendNeedsSendingLease-20-delete-on-key-id-counts", invariant: "removalSendNeedsSendingLease", settled: false,
  trace: run(from(w => { remHist(w); w.local.leases.L1 = lsS(); w.flux.inboxes.k1 = clone(w.flux.inboxes.i1); w.flux.requests.push(d("v0", "at1", { target: "k1" })); }), revoke("v1")) });
void base; void tick;
