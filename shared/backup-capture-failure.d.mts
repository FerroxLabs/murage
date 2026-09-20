export interface BackupCaptureFailure { readonly stage: string; readonly code: string }
export const BACKUP_CAPTURE_STAGES: readonly string[];
export const BACKUP_CAPTURE_CODES: readonly string[];
export function normalizeCaptureFailure(input: unknown): BackupCaptureFailure | null;
export function captureFailureSentence(input: unknown): string;
