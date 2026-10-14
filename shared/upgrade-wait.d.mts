export function formatDone(value: number, locale?: string): string;
export function formatTotal(value: number, locale?: string): string;
export function formatElapsed(ms: number, locale?: string): string;
export function tweenStep(shown: number, target: number, elapsed: number, duration: number): number;
export type MemorySpan = { kind: "years" | "year" | "months"; n: number };
export function memorySpan(firstMessageAt: number | null | undefined, now?: number): MemorySpan | null;
export function etaMinutes(ms: number | null | undefined): number | null;
export function etaBelievable(input: { stable: boolean; fraction: number; elapsedMs: number }): boolean;
export const SLEEP_GAP_MS: number;
export const ADVANCE_FRESH_MS: number;
export function createEtaGate(): { update(input: { phase: string; etaMs: number | null | undefined }): { minutes: number | null; slow: boolean }; reset(): void; shown(): number | null; slow(): boolean };
export function createAdvanceTracker(freshMs?: number): { observe(signature: unknown, at: number): void; advancing(at: number): boolean; reset(): void };
export function createMonotonePercent(): (fraction: number, done?: boolean) => number;
export interface EtaGateState { shown: number | null; candidate: number | null; count: number; rises: number; phase: string; slow: boolean }
export function newGate(): EtaGateState;
export function gateStep(gate: EtaGateState, input: { phase: string; etaMs: number | null | undefined }): { gate: EtaGateState; minutes: number | null; slow: boolean };
