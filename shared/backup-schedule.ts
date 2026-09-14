import { z } from "zod";
import { backupSelectionSchema } from "./installation-backup.ts";
import { parseUpdateCandidate, type UpdateCandidate } from "./update-candidate.mjs";

export const backupUpdateCandidateSchema = z.unknown().transform((value, context): UpdateCandidate => {
  try { return parseUpdateCandidate(value); } catch { context.addIssue({code:"custom",message:"Invalid update candidate"}); return z.NEVER; }
});

export const backupReferenceSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const zone = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Choose a valid timezone");
export const backupScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  installationRef: backupReferenceSchema.optional(), destinationRef: backupReferenceSchema.optional(), recoveryRef: backupReferenceSchema.optional(),
  timezone: zone.optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  catchupMs: z.number().int().min(60000).max(7 * 86400000).optional(),
  maxBytes: z.number().int().positive().max(1024 ** 4).optional(), maxDurationMs: z.number().int().min(1000).max(30 * 60000).optional(),
  selection: backupSelectionSchema.optional(), preUpgrade: z.boolean().default(false), closedApp: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled && [value.installationRef,value.destinationRef,value.recoveryRef,value.timezone,value.time,value.catchupMs,value.maxBytes,value.maxDurationMs,value.selection].some(entry => entry === undefined))
    context.addIssue({ code: "custom", message: "Enabled backups require explicit destination, recovery, schedule, scope and budgets" });
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export const backupClosedResultSchema=z.object({
  status:z.enum(["disabled","not-due","busy","verified","needs-review","unavailable"]),
  at:z.number().int().nonnegative(),revision:z.number().int().nonnegative(),
  jobId:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reason:z.enum(["pending-work","owner-unavailable","references-unavailable","capture-unconfirmed","state-unavailable","capability-unavailable"]).optional(),
}).strict();
export type BackupClosedResult=z.infer<typeof backupClosedResultSchema>;
export const backupReceiptSchema = z.object({
  jobId: z.string().regex(/^[a-f0-9]{64}$/), installationRef: backupReferenceSchema, destinationRef: backupReferenceSchema,
  selectionHash: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().uuid(), artifactRef: backupReferenceSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), verifiedAt: z.number().int().nonnegative(),
  candidateId: z.string().regex(/^update-[a-f0-9]{64}$/).optional(),
}).strict();
export type BackupReceipt = z.infer<typeof backupReceiptSchema>;
export const backupHandoffSchema = z.object({ version:z.literal(1),id:z.string().uuid(),bindingRevision:z.string().regex(/^[a-f0-9]{64}$/),installationIdentity:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().nonnegative(),upgrade:backupUpdateCandidateSchema.optional() }).strict();
export type BackupHandoff = z.infer<typeof backupHandoffSchema>;

/** Latest eligible wall-clock minute; one occurrence ID per local calendar day.
 * A repeated DST hour still names the same day; nonexistent local times skip. */
export function latestBackupOccurrence(schedule: BackupSchedule, now: number): { at: number; day: string } | null {
  if (!schedule.enabled || !schedule.timezone || !schedule.time || !schedule.catchupMs || !Number.isSafeInteger(now) || now < 0) return null;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23" });
  const earliest = now - schedule.catchupMs;
  for (let at = Math.floor(now / 60000) * 60000; at >= earliest; at -= 60000) {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    if (`${parts.hour}:${parts.minute}` === schedule.time) return { at, day: `${parts.year}-${parts.month}-${parts.day}` };
  }
  return null;
}
