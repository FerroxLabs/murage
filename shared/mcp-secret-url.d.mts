// SPDX-License-Identifier: AGPL-3.0-or-later
export const MASK: string;
export function isOpaqueSegment(segment: string): boolean;
export function maskPathname(pathname: string): string;
export function pathHasOpaqueSegment(pathname: string): boolean;
export function urlHasSecret(value: string): boolean;
export function displayUrl(value: string): string;
export function splitSecretUrl(value: string, options?: { keepFullInConfig?: boolean }): { storedUrl: string; fullUrl: string; urlSecret: boolean } | null;
