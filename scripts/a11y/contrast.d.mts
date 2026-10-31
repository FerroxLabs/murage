export interface ContrastRow { palette: string; fg: string; bg: string; min: number; why: string; ratio: number | null; pass: boolean }
export const PAIRS: ReadonlyArray<readonly [string, string, number, string]>;
export function parsePalettes(css: string): Map<string, Record<string, string>>;
export function contrast(fgHex: string, bgHex: string): number | null;
export function measure(css: string): ContrastRow[];
