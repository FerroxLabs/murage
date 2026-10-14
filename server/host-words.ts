// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one place a string becomes a Murage status. The lines that wrap here are composed by Murage modules from their own fixed tables (an
// admission refusal, an approval card's outcome, the digest's own summary); none of them carries a worker's words. The wrapper function is
// handed out once (`MurageStatus.claimHost`), to this module, so no other module can dress a string as a status. The hand-off boundary does not
// import this module: it asks for the lines already wrapped (the adapters below), and the import allowlist test keeps it that way.
import { authorizeWork, type WorkEdge } from "./execution-audience.ts";
import { MurageStatus } from "./murage-status.ts";
import { peerApprovalFailure, type PeerApprovalFailure } from "./peer-approval.ts";

const wrap = MurageStatus.claimHost();

/** A line a Murage module composed itself, from its own fixed tables. */
export function hostLine(words: string): MurageStatus { return wrap(words); }

export type AuthorizedWork =
  | Extract<ReturnType<typeof authorizeWork>, { ok: true }>
  | { ok: false; code: string; line: MurageStatus; /** The same words, for the message of an error the route raises. */ lineText: string; retry: "queue" | "never" };

/** `authorizeWork`, with the refusal line already a status. */
export function authorizeStatus(input: WorkEdge, continuing = false): AuthorizedWork {
  const verdict = authorizeWork(input, continuing);
  return verdict.ok ? verdict : { ok: false, code: verdict.code, line: hostLine(verdict.line), lineText: verdict.line, retry: verdict.retry };
}

/** An approval card's outcome, as the refusal a bot reads. */
export function peerApprovalStatus(outcome: PeerApprovalFailure): { error: MurageStatus; approvalOutcome: PeerApprovalFailure; approvalSource: "user" | "system" } {
  const failure = peerApprovalFailure(outcome);
  return { error: hostLine(failure.error), approvalOutcome: failure.approvalOutcome, approvalSource: failure.approvalSource };
}

/** The reason a shared queue refused a request (its own line, or its code). */
export function refusalStatus(refusal: { code: string; line?: string }): MurageStatus { return hostLine(refusal.line ?? refusal.code); }
