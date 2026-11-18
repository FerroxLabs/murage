// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The I/O meter reads this leaf without importing the database admission code that depends on the meter.
export interface ReadOnlyState { since: number; reason: string; freeBytes: number; needBytes: number }
export let readOnly: ReadOnlyState | undefined;
export function setReadOnly(state: ReadOnlyState): void { readOnly ??= state; }
export function isReadOnly(): boolean { return readOnly !== undefined; }
