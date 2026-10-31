// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one name the live stream and the bot email surfaces agree on (the server's emailStatus frame). Kept apart from bot-email.ts
// so the first paint (src/state/store.tsx) carries a string and no import cycle.
export const EMAIL_STATUS_EVENT = "murage:email-status";
