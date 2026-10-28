// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one name the live stream and the bot call surfaces agree on (call.ring, call.answered, call.ended hints). Kept apart
// from bot-calls.ts so the first paint (src/state/store.tsx) carries a string, not the call words.
export const CALL_EVENT = "murage:bot-call";
