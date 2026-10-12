// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export function validateEngineExclusionResource(resources: string, platform: string, arch?: string): string;
export function loadEngineExclusionResource(file: string, platform: string, arch: string, expectedVersion: number, run: (command: string, args: string[]) => string | Buffer): "loaded" | "skipped";
