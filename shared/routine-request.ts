/**
 * Durable payload carried by a chat routine confirmation card.
 *
 * Tool input is normalized before it reaches this shape: timestamps are
 * milliseconds, weekly day names are the scheduler's numeric weekday values,
 * and every text field has already been scrubbed for credential-shaped data.
 * Keeping the normalized operation on the card lets a confirmation survive an
 * app restart without asking the model to interpret the request again.
 */

export type RoutineRequestRunOn = "ember" | "cloud";

export type RoutineRequestSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; everyMinutes: number; anchorAt?: number };

export interface RoutineRequestDefinition {
  watch?: import("./routine-watch.ts").RoutineWatchInput;
  name: string;
  instructions: string;
  schedule: RoutineRequestSchedule;
  runOn: RoutineRequestRunOn;
  /** Legacy calendar/display length. It does not stop an active run. */
  durationMinutes: number;
  /** Optional safety cap for active work. Missing means no timeout. */
  timeoutMinutes?: number;
}

export type RoutineRequestChanges =
  & Omit<Partial<RoutineRequestDefinition>, "timeoutMinutes">
  & { /** `null` removes an existing safety cap. */ timeoutMinutes?: number | null };

/** Another bot in the proposer's section that the routine is scheduled for.
 * Captured (id + display name) when the card is created so the card stays
 * meaningful if the bot is later renamed; authority over the card remains
 * with the proposing conversation. */
export interface RoutineRequestTargetBot {
  botId: string;
  name: string;
}

export type RoutineRequestOperation =
  | { action: "create"; routine: RoutineRequestDefinition; forBot?: RoutineRequestTargetBot }
  | { action: "update"; routineId: string; expectedUpdatedAt: number; changes: RoutineRequestChanges }
  | { action: "pause"; routineId: string; expectedUpdatedAt: number }
  | { action: "resume"; routineId: string; expectedUpdatedAt: number }
  | { action: "run_now"; routineId: string; expectedUpdatedAt: number }
  | { action: "delete"; routineId: string; expectedUpdatedAt: number };

export interface RoutineRequestCardData {
  version: 1;
  /** Absent on a routine card; "webhook" on a webhook card. */
  kind?: undefined;
  /** Also used as the scheduler's idempotency key after confirmation. */
  requestId: string;
  /** Authority is fixed when the card is created; an agent cannot redirect it later. */
  botId: string;
  threadId: string;
  createdAt: number;
  operation: RoutineRequestOperation;
  /** Written after a successful confirmation. Useful for support/debugging. */
  appliedAt?: number;
  resultId?: string;
}

/** A webhook proposed from chat (SL-J J1). The id is assigned once, when the
 * card is written, from the request id: a Confirm pressed again after a crash
 * finds the record it already made instead of making a second one. No secret
 * and no endpoint ever ride on this payload. */
export interface WebhookRequestDefinition {
  id: string;
  name: string;
  prompt: string;
  eventTypes?: string[];
}

export interface WebhookRequestChanges {
  name?: string;
  prompt?: string;
  /** `[]` is the explicit clear. */
  eventTypes?: string[];
}

export type WebhookRequestOperation =
  | { action: "create"; webhook: WebhookRequestDefinition }
  | { action: "update"; webhookId: string; expectedUpdatedAt: number; changes: WebhookRequestChanges }
  | { action: "pause"; webhookId: string; expectedUpdatedAt: number }
  | { action: "resume"; webhookId: string; expectedUpdatedAt: number }
  | { action: "delete"; webhookId: string; expectedUpdatedAt: number };

export interface WebhookRequestCardData extends Omit<RoutineRequestCardData, "operation" | "kind"> {
  kind: "webhook";
  operation: WebhookRequestOperation;
}

/** Every chat automation card: a routine (no `kind`) or a webhook. */
export type AutomationRequestCardData = RoutineRequestCardData | WebhookRequestCardData;

/** Undo is offered for this long after a change is applied (SL-J J2). */
export const AUTOMATION_UNDO_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Which applied changes offer Undo: delete and run now never do. */
export function automationActionUndoable(action: string): boolean {
  return action === "create" || action === "update" || action === "pause" || action === "resume";
}
