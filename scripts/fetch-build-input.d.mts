// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface BuildInputPin { sha256: string; bytes: number; urls: string[] }
export const BUILD_INPUTS: Record<string, BuildInputPin>;
export function buildInputUrls(url: string, sha256: string, pins?: Record<string, BuildInputPin>): string[];
export function fetchBuildInput(url: string, options: {
  sha256: string; bytes?: number; maxBytes?: number; fetchImpl?: typeof fetch;
  timeoutMs?: number; pins?: Record<string, BuildInputPin>;
}): Promise<Response>;
