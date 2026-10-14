// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// For tests: the provider reply the server's fold would mint for an engine's own text (the real minter, the real event shape). Production mints one place only
// (index.ts foldRuntimeEvent); a test that stands in for the fold asks the same minter with an event of the same kind, so what it proves is the production rule.
import type { RuntimeEvent } from "../contracts.ts";
import { providerReplyOf, type ProviderReply } from "../provider-reply.ts";

let ordinal = 0;
/** The reply of the engine's turn `turnId` in `threadId` (an assistant text item with origin "engine"). */
export function engineReply(threadId: string, turnId: string): ProviderReply {
  const event: RuntimeEvent = { type: "item.completed", itemType: "assistant_text", origin: "engine", text: "reply", eventId: `test-event-${++ordinal}`, provider: "claudeAgent", threadId, turnId, createdAt: new Date().toISOString() };
  return providerReplyOf(event)!;
}
/** What Murage's own line looks like to the minter: nothing. */
export function murageLineReply(threadId: string, turnId: string): ProviderReply | undefined {
  return providerReplyOf({ type: "item.completed", itemType: "assistant_text", origin: "murage", text: "note", eventId: `test-event-${++ordinal}`, provider: "claudeAgent", threadId, turnId, createdAt: new Date().toISOString() });
}
