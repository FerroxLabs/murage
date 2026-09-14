export const AGE_ORIGINAL_SHA256: string;
export const AGE_PAYLOAD_SHA256: string;
export function normalizedAgePayloadHash(bytes: Buffer): string | null;
export function signedAgeOwnedByCurrentApp(file: string, bytes: Buffer, context?: { currentExecutable?: string; run?: (args: string[]) => { status: number | null; error?: unknown; stderr?: unknown } }): boolean;
export function trustedBackupAgeExecutable(file: string): boolean;
