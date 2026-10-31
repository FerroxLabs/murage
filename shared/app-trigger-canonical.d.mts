export type JcsErrorCode = "float" | "int_range" | "lone_surrogate" | "duplicate_member" | "invalid_utf8" | "invalid_json" | "invalid_value" | "too_deep";
export class JcsError extends Error { readonly code: JcsErrorCode; constructor(code: JcsErrorCode, message?: string); }
export function canonicalize(value: unknown): string;
export function canonicalBytes(value: unknown): Buffer;
export function bodyDigest(value: unknown): string;
export function parseStrictJson(text: string): unknown;
export function parseStrictJsonBytes(bytes: Uint8Array): unknown;
