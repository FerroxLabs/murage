// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const DATA_VERSION_FILE: string;
export const MURAGE_DOWNLOAD_URL: string;
export const NEWER_DATA_CODES: readonly string[];
export function isNewerDataRefusal(code: unknown): boolean;
export function releaseVersion(value: unknown): string | null;
export function compareReleaseVersions(a: string, b: string): number;
export function readDataVersion(dataDir: string): string | null;
export function newerDataVersion(recorded: string | null | undefined, running: string | null | undefined): string | null;
export function noteDataVersion(dataDir: string, version: string | null | undefined): boolean;
