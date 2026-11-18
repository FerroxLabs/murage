// SPDX-License-Identifier: AGPL-3.0-or-later
export const FINANCIAL_RULE_VERSION = 4;
export function hasFinancialIdentifier(text: string): boolean;
export function containsFinancialIdentifier(text: string): boolean;
export function passesFinancialFastPath(text: string): boolean;
export function maskFinancialIdentifiers(text: string): string;
export function financialRuleOffsets(text: string): Record<string, number[]>;
