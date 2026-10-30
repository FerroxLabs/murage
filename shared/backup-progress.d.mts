export const BACKUP_PROGRESS_MESSAGE: "murage:recovery-progress";
export type BackupWorkerStep = "records" | "database-read" | "source-recheck" | "database-check" | "database-copy" | "database-clean" | "database-verify" | "database-digest" | "ledger"
  | "inventory" | "encrypt" | "readback" | "readback-entries" | "readback-hash" | "flush" | "publish" | "done";
export const BACKUP_WORKER_STEPS: readonly BackupWorkerStep[];
export interface BackupProgressNote { step: BackupWorkerStep; elapsedMs: number; done?: number; total?: number }
export type BackupProgressReport = (step: BackupWorkerStep, done?: number, total?: number) => void;
export function normalizeBackupProgress(raw: unknown): BackupProgressNote | null;
export function safeBackupProgress<A extends unknown[]>(report: ((...values: A) => void) | undefined): (...values: A) => void;
export function createBackupProgressReporter(post: (note: BackupProgressNote) => void, options?: { now?: () => number; minIntervalMs?: number }): BackupProgressReport;
export function createBackupStepLog(options: { job: string; log: (line: string) => void }): (raw: unknown) => void;
