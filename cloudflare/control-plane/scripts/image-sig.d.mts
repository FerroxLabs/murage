// SPDX-License-Identifier: AGPL-3.0-or-later
export const IMAGE_SIG_VERSION: string;
export const TRUSTED_IMAGE_KEY_FPS: string[];
export const ACCEPTED_CHECK_SHA256: string[];
export const REVOKED_IMAGE_IDS: string[];
export const IMAGE_SIG_MAX_AGE_DAYS: number;
export const IMAGE_SIG_ALERT_DAYS: number[];
export const DAY_MS: number;
export const RECHECK_TTL_MS: number;
export const RECHECK_TIMEOUT_MS: number;
export const ID_RE: RegExp;
export const CREATED_RE: RegExp;
export const HEX64_RE: RegExp;
export const VERIFIED_AT_RE: RegExp;
export const SIG_RE: RegExp;
export function validImageId(v: unknown): v is string;
export function validCreatedAt(v: unknown): v is string;
export function validImageSizeText(v: unknown): v is string;
export function imageSizeText(x: unknown): string | null;
export function parseCreatedMs(s: string): number | null;
export function parseVerifiedAtMs(s: unknown): number | null;
export interface PayloadFields { imageId: string; createdAt: string; imageSize: string; env: "staging" | "prod"; checkSha256: string; verdict: "pass"; verifiedAt: string }
export function buildPayload(f: PayloadFields): string;
export function b64urlEncode(bytes: Uint8Array): string;
export function b64urlDecode(s: string): Uint8Array | null;
export function decodeStoredSig(s: unknown): Uint8Array | null;
export function derToP1363(der: Uint8Array | ArrayBuffer): Uint8Array;
export interface CustomerEntry { kind: "customer"; verifiedBy: string; checkVersion: string; verifiedAt: string; createdAt: string; imageSize: string;
  env: "staging" | "prod"; checkSha256: string; verdict: "pass"; keyFp: string; sig: string }
export function parseCustomerEntry(v: unknown): { ok: true; entry: CustomerEntry } | { ok: false };
export function daysLeft(verifiedAtMs: number, nowMs: number): number;
export function p1363ToDer(raw: Uint8Array): Uint8Array;
