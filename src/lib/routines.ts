export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; everyMinutes: number; anchorAt: number }
  /** 1.0.4 SL-I I3: runs once each time this engine's limit resets (server/routines.ts) */
  | { type: "limit_reset"; engineKey: string }
  /** 1.0.11 APP-TRIGGERS: started by connected-app events, never by a clock; nextRunAt is always null. */
  | { type: "app_event"; triggerId: string };

export type RoutineRunOn = "ember" | "cloud";

export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus =
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  | "paused"
  | "stopped"
  | "failed";

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "channel" | "app";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  /** The run limit came while a card waited on the owner; answering it lets
   * the run finish. */
  | "needs-you"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface RoutineInstructionRevision {
  id:string;prompt:string;parentId?:string;author:"owner"|"learned"|"rollback";createdAt:number;
  evaluationReceiptId?:string;rollbackOf?:string;
}
export interface Routine {
  instructionRevision?:string;
  instructionHistory?:RoutineInstructionRevision[];
  watch?: import("../../shared/routine-watch").RoutineWatchBinding;
  id: string;
  name: string;
  prompt: string;
  target: RoutineTarget;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  /** Optional wall-clock safety limit. Missing means the run is unlimited. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  /** Absent means skip; see server/routines.ts. */
  overlap?: "skip" | "queue";
  /** Set once at creation: each run starts with the last run's report. Absent means off. No control. */
  carryLastReport?: true;
  /** The approval level its runs are judged at; absent means the bot's own
   * level when a run starts (server/routine-permissions.ts). */
  permissionMode?: import("./permission-mode").PermissionMode;
  /** "Always allow for this routine": exact-command and stop-line keys. */
  alwaysAllow?: string[];
  /** The routine's own conversation, where every run works. */
  threadId?: string;
  skippedRuns?: number;
  lastSkippedAt?: number;
  /** Derived by the server from settled runs. */
  failureStreak?: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  /** 1.0.4 SL-I I3: queued until this engine's limit resets */
  limitWait?: { engineKey: string; until: number; n: number };
  watch?: import("../../shared/routine-watch").RoutineWatchRun;
  event?: import("../../shared/routine-event").RoutineEvent;
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  /** Room task created for a team-goal run. */
  executionThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /** Concise, redacted question or approval reason while status is waiting. */
  attention?: string;
  cost?: number | null;
  denials?: string[];
  /** Plain lines in this run's history: a command run without a card, when
   * its write or delete target was held in a value. Each names only the tool
   * and that target (`rm on "$TMP"`, `a redirect to "$OUT"`), never the
   * command's other arguments. */
  notes?: string[];
  /** How many more such lines (repeats, or past the cap) this run had. */
  notesMore?: number;
  createdAt: number;
  seenAt?: number;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  /** `null` explicitly removes the limit; omission preserves it on updates. */
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
  overlap?: "skip" | "queue";
  /** Creation only (the editor); an edit never changes it. */
  carryLastReport?: boolean;
  /** A level, or `inherit` to follow the bot's level. */
  permissionMode?: import("./permission-mode").PermissionMode | "inherit";
}
