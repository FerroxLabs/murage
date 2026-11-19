// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SteerDelivery } from "../../contracts.ts";

/** Hermes' advertised ACP slash command; a custom ACP engine may implement the same contract. */
export function hermesSteerAnswer(chunk: string): "delivered" | "rejected" | null {
  if (chunk.startsWith("⏩ Steer queued for the active turn:") || chunk.startsWith("No active turn — queued for the next turn.")) return "delivered";
  if (chunk.startsWith("⚠️ Steer failed:")) return "rejected";
  return null;
}

/** One serialized control request at a time, so an uncorrelated ACP text acknowledgement belongs to one steer only.
 * Unknown answers are uncertain: the caller must never resend a message that the engine may already have taken. */
export function acpTurnSteering(options: {
  running(): boolean;
  send(text: string, beforeWrite?: () => void): Promise<unknown>;
}) {
  let ended = false, queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let acknowledge: ((answer: SteerDelivery) => void) | undefined;
  return {
    swallow(chunk: string): boolean {
      const answer = acknowledge && hermesSteerAnswer(chunk);
      if (!answer) return false;
      acknowledge!(answer);
      return true;
    },
    promptAnswered(): Promise<unknown> | null {
      ended = true;
      return queued ? tail : null;
    },
    steer(text: string, beforeWrite?: () => void): Promise<SteerDelivery> {
      text = text.trim();
      if (!text || ended || !options.running() || queued >= 32) return Promise.resolve("rejected");
      queued++;
      const next = tail.then(async (): Promise<SteerDelivery> => {
        if (ended || !options.running()) return "rejected";
        try { beforeWrite?.(); } catch (error) {
          if ((error as { code?: unknown })?.code === "MEMORY_CONTEXT_REVOKED") throw error;
          return "rejected";
        }
        let accepted: SteerDelivery | undefined;
        let resolveAnswer!: (answer: SteerDelivery) => void;
        const answer = new Promise<SteerDelivery>(resolve => { resolveAnswer = resolve; });
        acknowledge = verdict => { accepted ??= verdict; resolveAnswer(accepted); };
        // The message route owns the response deadline and late reconciliation.
        // Keep this promise live until the peer answers: an internal timeout
        // would hide a later refusal/acceptance from that existing callback.
        const response = options.send(`/steer ${text}`, beforeWrite).then((): SteerDelivery => accepted ?? "uncertain", (error): SteerDelivery => {
          if (error?.code === "MEMORY_CONTEXT_REVOKED") throw error;
          if (error instanceof Error && error.message === "MEMORY_CONTEXT_REVOKED") return "rejected";
          return accepted ?? (error?.acpRpcId !== undefined ? "rejected" : "uncertain");
        }).finally(() => { acknowledge = undefined; });
        // Return the acknowledgement promptly, but keep the serialization tail
        // on the RPC so no second steer borrows the first one's acknowledgement.
        pendingResponse = response;
        return await Promise.race([answer, response]);
      });
      let pendingResponse: Promise<SteerDelivery> | undefined;
      tail = next.then(() => pendingResponse, () => pendingResponse?.catch(() => undefined)).finally(() => { queued--; });
      return next;
    },
  };
}
