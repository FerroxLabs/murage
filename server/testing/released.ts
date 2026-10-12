// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helpers for the typed hand-off boundary. Released text can be made only by the result gate, so a test that needs some asks the gate with a
// permissive world; `words` reads any bot-facing value back as a plain string for assertions.
import { releaseStoredResult, type EgressMessage, type ReleasedResult, type ResultEgressDeps } from "../result-egress.ts";
import { outboundWords, type Outbound } from "../murage-status.ts";
import { ReleasedText, WorkerText, type EgressOrigin } from "../released-text.ts";

const permissive = (copyOf?: EgressOrigin): ResultEgressDeps => ({
  message: (_thread, id): EgressMessage => ({ id }),
  authorize: () => ({ ok: true }), copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
  messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true, withheldLine: "[withheld]",
  ...(copyOf ? {} : {}),
});

/** Text released by a gate that withholds nothing. `copyOf` names the original the text stands on (the gate releases no text without one). */
export function released(text: string, copyOf: EgressOrigin = { threadId: "worker-thread", messageIds: ["worker-reply"] }): ReleasedText {
  const result = releaseStoredResult({ origin: copyOf }, "worker", "destination", { fromBotId: "asker" }, false, new WorkerText(text), permissive(copyOf));
  if (result.kind !== "text") throw new Error(`the permissive gate released nothing: ${result.kind}`);
  return result.text;
}

export const words = (value: Outbound): string => outboundWords(value);

/** A gate answer read back as plain values, for assertions: released words and status lines become their strings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function plain(result: ReleasedResult): any {
  return result.kind === "text" ? { kind: "text", text: words(result.text), ...(result.copyOf ? { copyOf: result.copyOf } : {}) }
    : result.kind === "withheld" ? { kind: "withheld", line: words(result.line) } : result.kind === "refused" ? { kind: "refused", line: words(result.line), code: result.code } : result;
}
