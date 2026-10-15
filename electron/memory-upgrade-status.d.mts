// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ParsedUpgradeState } from "../shared/upgrade-contract.mjs";
export const MEMORY_UPGRADE_STATUS_FILE: string;
export type MemoryUpgradeNote = {
  state: "upgrading" | "blocked";
  code?: "MEMORY_MIGRATION_DISK_SPACE" | "MEMORY_SCHEMA_NEWER" | "MEMORY_MIGRATION_FAILED";
  phase?: "checking" | "copying" | "migrating" | "indexing" | "converting" | "reclaiming";
  done?: number; total?: number;
  startedAt?: number; updatedAt?: number; copyBytes?: number; needBytes?: number; freeBytes?: number; shortBytes?: number; newerVersion?: number;
  partialName?: string;
  step?: "tables" | "indexes" | "backfill" | "validating" | "committing";
  stepElapsedMs?: number;
  /** The contract's reading (shared/upgrade-contract.mjs), parsed. */
  upgrade: ParsedUpgradeState;
};
export function cleanUpgrade(raw: unknown): ParsedUpgradeState;
export function statusFromHealth(body: unknown, now?: number): MemoryUpgradeNote | null;
export function clearMemoryUpgradeStatus(dataDir: string): void;
export function readMemoryUpgradeStatus(dataDir: string, options?: { pid?: number }): MemoryUpgradeNote | null;
export function memoryUpgradeProgress(status: MemoryUpgradeNote | null, dataDir: string, size?: (file: string) => number): number | null;
export function describeBytes(bytes: number): string;
export function memoryUpgradeLocale(language: string | undefined): string;
export function memoryUpgradeBlockedSentence(status: { code?: string; shortBytes?: number; needBytes?: number } | null, language?: string, options?: { logPath?: string }): string;
export function copiedBytes(status: MemoryUpgradeNote | null, dataDir: string, size?: (file: string) => number): number | null;
export function watchMemoryUpgrade(options: { dataDir: string; pid: number | (() => number | undefined); onUpdate?: (status: MemoryUpgradeNote | null, percent: number | null) => void; onLife?: (status: MemoryUpgradeNote | null, percent: number | null) => void; onReading?: (status: MemoryUpgradeNote | null, percent: number | null) => void; now?: () => number; intervalMs?: number; read?: typeof readMemoryUpgradeStatus; progress?: typeof memoryUpgradeProgress; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }): { feed(body: unknown): void; active(): boolean; status(): MemoryUpgradeNote | null; stop(): void; tick(): void };
