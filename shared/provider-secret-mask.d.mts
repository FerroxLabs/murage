export const VENDOR_SECRET_RULES: readonly (readonly [string, RegExp])[];
export const VENDOR_SECRET_PATTERN: RegExp;
export function vendorSecretValueOffset(match: RegExpExecArray): number;
export function vendorSecretSpans(text: string): { start: number; end: number }[];
