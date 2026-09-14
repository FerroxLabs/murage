import { z } from "zod";
export const backupSelectionSchema = z.object({
  scope: z.literal("application-data"),
  credentialPolicy: z.literal("preserve-in-encrypted-fidelity"),
}).strict();
export type BackupSelection = z.infer<typeof backupSelectionSchema>;
export const backupFileSchema = z.object({ path: z.string().min(1).max(4096), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const backupCoverageSchema = z.object({
  scope: z.literal("application-data"), fullInstallation: z.literal(false),
  credentialPolicy: z.literal("preserve-in-encrypted-fidelity"),
  components: z.array(z.object({ path: z.string().max(4096), status: z.enum(["included", "excluded", "missing"]), reason: z.string().max(512) }).strict()).max(100000),
}).strict();
export type BackupCoverage = z.infer<typeof backupCoverageSchema>;
export const fidelityManifestSchema = z.object({
  format: z.literal("murage.installation-fidelity"), version: z.literal(1), snapshotId: z.string().uuid(), createdAt: z.string().datetime(),
  sourceInstallation: z.string().min(1).max(4096),
  restorePolicy: z.literal("paused-review-required"), files: z.array(backupFileSchema).max(100000),
  database: z.object({ status: z.literal("absent") }).strict(), coverage: backupCoverageSchema, recovery: z.unknown(),
}).strict();
export type FidelityManifest = z.infer<typeof fidelityManifestSchema>;
