// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The values Murage's own records may hold, declared ONCE and read by both
// the code that writes those records and the backup that checks them
// (server/installation-record-validation.ts).
//
// Why: until 0.1.60 the backup kept its own copy of these lists. When channel
// messages (Telegram, Slack, Discord) started being saved as routine runs with
// triggerSource "channel", and a run could wait at "needs-you", the runtime
// lists grew and the backup's copy did not: one message to the Chief made
// every later backup fail (audit A-04). The runtime types are now derived
// from these arrays, so a new value cannot reach routines.json without the
// backup accepting it.
//
// Pure data: importing this never starts a runtime manager.

/** routines.ts RoutineRunStatus. */
export const ROUTINE_RUN_STATUSES = ["queued", "running", "waiting", "needs-you", "completed", "failed", "cancelled", "missed"] as const;
/** routines.ts RoutineRunTrigger: why a run exists. */
export const ROUTINE_RUN_TRIGGERS = ["schedule", "manual", "webhook", "channel"] as const;
/** routines.ts RoutineTarget. */
export const ROUTINE_TARGETS = ["bot", "room-goal"] as const;
/** routines.ts RoutineRunOn. */
export const ROUTINE_RUN_ON = ["ember", "cloud"] as const;
/** webhooks.ts WebhookAttempt outcome. */
export const WEBHOOK_ATTEMPT_OUTCOMES = ["accepted", "captured", "duplicate", "ignored", "rejected"] as const;
/** delegations.ts DelegationOutcome. */
export const DELEGATION_OUTCOMES = ["done", "failed", "denied", "expired", "cancelled", "busy_gave_up", "dropped", "error"] as const;
