export const AGE_ORIGINAL_SHA256: string;
export const AGE_PAYLOAD_SHA256: string;
export function normalizedAgePayloadHash(bytes: Buffer): string | null;
export function signedAgeOwnedByCurrentApp(file: string, bytes: Buffer, context?: { currentExecutable?: string; run?: (args: string[]) => { status: number | null; error?: unknown; stderr?: unknown } }): boolean;
export interface BackupAgeDiagnostic {
  operation: "encrypt" | "decrypt";
  predicate: string;
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
  errorCode: string | null;
  elapsedMs: number | null;
}
export function normalizeBackupAgeDiagnostic(value: unknown): BackupAgeDiagnostic | null;
export function trustedBackupAgeExecutable(file: string, options?: { report?: (facts: Record<string, unknown>) => void }): boolean;
