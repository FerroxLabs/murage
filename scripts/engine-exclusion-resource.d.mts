// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export function validateEngineExclusionResource(resources: string, platform: string, arch?: string): string;
export function loadEngineExclusionResource(file: string, platform: string, arch: string, expectedVersion: number, run: (command: string, args: string[], env: Record<string, string>) => string | Buffer, binary: string, host?: { platform: string; arch: string }): "loaded";
export const WINDOWS_ADDON_FUNCTIONS: string[];
export const POSIX_ADDON_FUNCTIONS: string[];
export function requiredAddonFunctions(platform: string): string[];
