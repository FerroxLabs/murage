// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P9 (1.0.24): a reply Murage itself could not start is retried once, silently, with the owner's message kept (server/index.ts
// murageSetupRetryable). If it fails again the owner reads the real reason in plain words, never "Send it again", and the card offers
// Retry only. One table: the code Murage threw -> the reason. Owner of the server side: server/index.ts (catch of the direct dispatch);
// owner of the card side: src/components/RuntimeErrorCard.tsx (murageOwn).

export const MURAGE_START_FAILURE_PREFIX = "Murage couldn't start this reply";

const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^wipe-[a-z0-9]+(?:-[a-z0-9]+)*$/, "its delete protection could not be set up"],
  [/^instance_not_attached$/, "its AI engine was reloaded while your message was being prepared"],
  [/^invalid_attachment$/, "its AI engine changed while your message was being prepared"],
  [/^provider_route_changed$/, "the AI service picked for this bot changed while your message was being prepared"],
  [/^provider_stop_unconfirmed$/, "the engine had not confirmed that its previous reply stopped"],
  [/^decision-dispatch-without-provenance$/, "it lost track of which message started this reply"],
  [/^browser_turn_cancelled$/, "the browser task this reply needed was cancelled"],
  [/^memory_not_ready$/, "this conversation's memory was not ready in time"],
];

/** The plain line for a Murage start failure: the reason, then a full stop. An unknown code names no reason. */
export function murageStartFailureLine(code?: string): string {
  const reason = code === undefined ? undefined : REASONS.find(([pattern]) => pattern.test(code))?.[1];
  return reason ? `${MURAGE_START_FAILURE_PREFIX} because ${reason}.` : `${MURAGE_START_FAILURE_PREFIX}.`;
}

/** True for any line this module (or the 1.0.20 line) produced. */
export const isMurageStartFailureLine = (message: string): boolean => message.trim().startsWith(`${MURAGE_START_FAILURE_PREFIX}.`) || message.trim().startsWith(`${MURAGE_START_FAILURE_PREFIX} because `);

/** True when the code is one Murage itself throws on a reply's start path. */
export const isMurageStartFailureCode = (code: string): boolean => REASONS.some(([pattern]) => pattern.test(code));
