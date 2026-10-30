// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const MAX_BACKUP_DURATION_MS: number;
export const CLOSED_BACKUP_PROCESS_LIMIT_MS: number;
export const BACKUP_BUDGET_ARGUMENT: string;
export function validStoredDuration(value: unknown): boolean;
export function decideBackupBudget(input: { storedMs: number; lastBytes?: number; liveBytes?: number; lastRunMs?: number }): number;
export function backupBudgetArgument(handoffId: string, budgetMs: number): string;
export function withoutBackupBudgetArgument(args: readonly string[]): string[];
export function readBackupBudgetArgument(argv: readonly string[], handoffId: string | undefined, storedMs: number): number;
