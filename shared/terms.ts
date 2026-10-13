// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Terms of Service and Privacy Policy version this build asks people to
// accept. ONE place: change TERMS_VERSION when the published terms change and
// every install is asked again, once, the next time it opens (server/terms.ts
// compares it with the version on record). The value is the "Effective" date
// of the published Terms of Service.
export const TERMS_VERSION = "2026-10-10";
export const TERMS_URL = "https://murage.ai/terms-of-service";
export const PRIVACY_URL = "https://murage.ai/privacy-policy";

export interface TermsStatus {
  /** The version this build asks for. */
  version: string;
  /** True when that version is on record (or an automated run declared it). */
  accepted: boolean;
  /** The older version on record, when the terms have changed since. */
  acceptedVersion?: string;
  acceptedAt?: string;
  /** "environment" when MURAGE_TERMS_ACCEPTED declared it (automated runs only). */
  source?: "record" | "environment";
}
