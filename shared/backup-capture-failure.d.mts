export interface BackupCaptureFailure { readonly stage: string; readonly code: string; readonly path?: string }
export const BACKUP_CAPTURE_STAGES: readonly string[];
export const BACKUP_CAPTURE_CODES: readonly string[];
export function normalizeCaptureFailure(input: unknown): BackupCaptureFailure | null;
export function captureFailureSentence(input: unknown): string;
export function captureFailurePath(value: unknown): string | undefined;
export function captureFailureReason(code: unknown, path?: unknown): string;
export interface BackupCaptureCause {
  readonly step?: string; readonly errno?: string; readonly syscall?: string; readonly code?: string; readonly innerCode?: string;
  readonly tool?: string; readonly exitCode?: number; readonly signal?: string; readonly toolStep?: string;
  readonly stderr?: string; readonly message?: string; readonly name?: string;
}
export function redactCauseText(value: unknown, max?: number): string | undefined;
export function normalizeCaptureCause(input: unknown): BackupCaptureCause | null;
export function describeCaptureError(error: unknown, step?: string): BackupCaptureCause | null;
