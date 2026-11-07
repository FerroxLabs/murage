export interface SecretLabel { readonly sepEnd: number; readonly wrapped: boolean; }
export interface LabelStream { len: number; d: number; lead: boolean; win: string; prevAlnum: boolean; pendU: number; open: boolean; }
export const MD_STREAM_CAP: number;
export function isExactMarker(s: string): boolean;
export function findSecretLabels(line: string): SecretLabel[];
export function maskSecretLabelsToEnd(text: string, mask: (rest: string) => string): string;
export function createLabelStream(): LabelStream;
export function scanLabelDelta(state: LabelStream, raw: string): number;
