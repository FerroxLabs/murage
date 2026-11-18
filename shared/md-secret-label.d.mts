export interface SecretLabel { readonly sepEnd: number; readonly wrapped: boolean; }
export interface LabelStream { len: number; d: number; lead: boolean; win: string; prevAlnum: boolean; pendU: number; open: boolean; units: number; }
export const MD_STREAM_CAP: number;
export const SECRET_SCAN_BUDGET: number;
export const SECRET_PROVIDER_PATTERN: RegExp;
export const SECRET_TYPE_WORDS: readonly string[];
export interface SecretCandidate extends SecretLabel { readonly start: number; readonly name: string; readonly separator: string; }
export interface ScanResult { readonly text: string; readonly detected: boolean; readonly exhausted: boolean; }
export interface SecretScanResult extends ScanResult { readonly candidates: readonly SecretCandidate[]; readonly workUnits: number; readonly spans?: readonly SecretSpan[]; }
export function scanSecretText(text: string, options?: { providers?: boolean; vendor?: boolean; turnComplete?: boolean; mode?: "user" | "turn" | "machine"; budget?: number }): SecretScanResult;
export function isExactMarker(s: string): boolean;
export function findSecretLabels(line: string, charge?: ScanCharge): SecretLabel[];
export function maskSecretLabelsToEnd(text: string, mask: (rest: string) => string, charge?: ScanCharge, edits?: (edit: { start: number; end: number; length: number }) => void, discardCarry?: () => void): string;
export function createLabelStream(): LabelStream;
export function scanLabelDelta(state: LabelStream, raw: string): number;

export interface SecretSpan { readonly from: number; readonly to: number; }
export type ScanCharge = (units?: number) => void;
export function scan(text: string, options?: { providers?: boolean; vendor?: boolean; turnComplete?: boolean; mode?: "user" | "turn" | "machine"; budget?: number }, complete?: (text: string, result: SecretScanResult, spend: ScanCharge) => SecretScanResult): SecretScanResult;
