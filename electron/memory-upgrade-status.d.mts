// SPDX-License-Identifier: AGPL-3.0-or-later
export const MEMORY_UPGRADE_STATUS_FILE: string;
export type MemoryUpgradeNote = {
  state: "upgrading" | "blocked";
  code?: "MEMORY_MIGRATION_DISK_SPACE" | "MEMORY_SCHEMA_NEWER" | "MEMORY_MIGRATION_FAILED";
  phase?: "checking" | "copying" | "migrating";
  startedAt?: number; updatedAt?: number; copyBytes?: number; needBytes?: number; freeBytes?: number; shortBytes?: number; newerVersion?: number;
  partialName?: string;
};
export function clearMemoryUpgradeStatus(dataDir: string): void;
export function readMemoryUpgradeStatus(dataDir: string, options?: { pid?: number }): MemoryUpgradeNote | null;
export function memoryUpgradeProgress(status: MemoryUpgradeNote | null, dataDir: string, size?: (file: string) => number): number | null;
export function describeBytes(bytes: number): string;
export function memoryUpgradeLocale(language: string | undefined): string;
export function memoryUpgradeBlockedSentence(status: MemoryUpgradeNote | null, language?: string): string;
export function buildMemoryUpgradePage(options?: { language?: string; percent?: number | null }): string;
export function setMemoryUpgradeProgressScript(percent: number): string;
export function watchMemoryUpgrade(options: { dataDir: string; pid: number | (() => number | undefined); onUpdate: (status: MemoryUpgradeNote | null, percent: number | null) => void; intervalMs?: number; read?: typeof readMemoryUpgradeStatus; progress?: typeof memoryUpgradeProgress; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }): { active(): boolean; status(): MemoryUpgradeNote | null; stop(): void; tick(): void };
