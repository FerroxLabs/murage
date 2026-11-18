// SPDX-License-Identifier: AGPL-3.0-or-later
// Which Cloud acceptance covers which HOME terms version (browser-owner/DESIGN.md section 11, "The version mapping").
//
// The two sides name their terms differently and must never be derived from each other:
//  - a home's server/terms.ts record names ONE date (shared/terms.ts TERMS_VERSION, "2026-10-10") for two documents, the Terms of Service
//    and the Privacy Policy. It is baked into the image and shared with the desktop app.
//  - the control plane names each document by a content-hash id (legal-docs.generated.ts), which moves whenever the legal docs build runs.
// This table is the only link. An acceptance covers home version H when a row with `home === H` names exactly the acceptance's own
// `tos_version` and `privacy_version`. The Murage Cloud terms are not part of the match: H stands for two documents, and the Cloud terms have
// the site's own re-acceptance. A table may hold several rows for one H. A newer legal document with no row covers nothing: the customer gets
// the site fallback, never a record the control plane did not witness. test/home-terms.test.ts fails when the documents in force have no row,
// so a legal change cannot ship without somebody saying which home version it answers.
export interface HomeTermsRow { home: string; tos: string; privacy: string }

export const HOME_TERMS_MAP: readonly HomeTermsRow[] = [
  { home: "2026-10-10", tos: "terms-of-service-f2a10ce6b0ef", privacy: "privacy-policy-2f6c539d1989" },
  // Regenerated from the live site (murage-site 03478d48): the same home version, the ids of the texts now in force. The row above stays,
  // so customers who accepted the earlier texts keep covering home version 2026-10-10.
  { home: "2026-10-10", tos: "terms-of-service-949a14d6cb42", privacy: "privacy-policy-7411767ea8a3" },
];

/** The shape a home sends: shared/terms.ts TERMS_VERSION is a plain date. */
export const HOME_TERMS_VERSION = /^\d{4}-\d{2}-\d{2}$/;

export const rowsForHome = (home: string): HomeTermsRow[] => HOME_TERMS_MAP.filter((r) => r.home === home);
/** The acceptance's ToS and Privacy ids cover home version `home`. */
export const coversHome = (home: string, tos: string, privacy: string): boolean => rowsForHome(home).some((r) => r.tos === tos && r.privacy === privacy);
/** The acceptance's ToS and Privacy ids are those of SOME home version. */
export const knownHomeAcceptance = (tos: string, privacy: string): boolean => HOME_TERMS_MAP.some((r) => r.tos === tos && r.privacy === privacy);
/** The table is append-only and in time order, so a row's place says which home version is older. The place of the first row an acceptance's ids
 *  match (-1: none), and of the first row for a home version (-1: none). */
export const acceptanceRank = (tos: string, privacy: string): number => HOME_TERMS_MAP.findIndex((r) => r.tos === tos && r.privacy === privacy);
export const homeRank = (home: string): number => HOME_TERMS_MAP.findIndex((r) => r.home === home);
