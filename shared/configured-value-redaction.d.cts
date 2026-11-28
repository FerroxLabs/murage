// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
export function configuredValueRanges(text: string, values: Iterable<string>): Array<[number, number]>;
export function redactConfiguredValues(text: string, values: Iterable<string>, marker?: string): string;
