// Types for the test-only WAL source transform (server/testing/wal-transform.mjs).
export const TRANSFORM_MARKER: string;
export function walTarget(id: string): string | null;
export function transformWalSource(id: string, source: string): string;
