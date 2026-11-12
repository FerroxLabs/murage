// SPDX-License-Identifier: AGPL-3.0-or-later
// The signed terms proof a Cloud home pulls instead of asking the customer a second time (browser-owner/DESIGN.md section 11).
//
// The customer accepts the Murage Cloud terms, the Terms of Service and the Privacy Policy, and confirms they are 18 or older, when they submit
// their order on the payment page. That acceptance is a terms_acceptances row, written at the verified completion of the order. A home that has
// no record for its own TERMS_VERSION asks the control plane (home-api.ts, operation terms-proof) and gets this envelope: ES256, the key every
// home already pins, the key no home and no bot holds. It proves version, time and account, has no expiry (it is evidence, kept and checkable
// later), and is bound to the home and its generation at issue.
//
// Minted ONLY from a row that
//   - belongs to the home's owner (terms_acceptances.user_id),
//   - counts as an acceptance (acceptanceCounts: a checkout row only once its order completed),
//   - proves the age (a checkout row through AGE_SCREENS, a site re-acceptance through AGE_REACCEPT_WORDINGS), and
//   - covers the home's version (home-terms-map.ts).
// The three document ids in the proof are always the ROW's own, never the documents in force now.
//
// The notice period: when a newer document set needs the customer's agreement but its 30-day notice has not run, the customer keeps going on their
// earlier acceptance. Then the answer is the same envelope with source "notice-period" and `graceUntil`, built from the OLDER acceptance. It is
// never stored by the home (memory only), so it cannot outlive graceUntil as a record. After the notice's effective date with no acceptance the
// answer is "none": the home shows its screen, which sends the customer to the site.
//
// The home never tells the control plane "the customer accepted": an HMAC-only call that could record an acceptance would let a taken-over home
// make a signed one. Nothing in home-api.ts writes terms_acceptances (test/home-api.test.ts pins that).
import { signPayload, type SignedEnvelope } from "./b3-signatures";
import { AGE_REACCEPT_WORDINGS, AGE_SCREENS, acceptanceCounts, currentVersions } from "./legal-flows";
import { acceptanceRank, coversHome, homeRank, rowsForHome } from "./home-terms-map";

const DAY_MS = 86_400_000;
/** The grace when no notice has gone out yet (noticePending): the customer is not asked before the notice has had time to run. */
export const NOTICE_GRACE_FALLBACK_MS = 7 * DAY_MS;

export interface TermsProofClaims {
  type: "murage-terms-v1"; homeId: string; generation: number; account: string; homeTermsVersion: string;
  documents: { cloudTerms: string; termsOfService: string; privacyPolicy: string };
  ageConfirmed: boolean; acceptedAt: number; source: "checkout" | "reaccept" | "notice-period";
  acceptanceId: string; consentId: string | null; screenVersion: string | null; graceUntil: number | null; issuedAt: number;
}
export type TermsProofAnswer = { status: "proof"; proof: SignedEnvelope } | { status: "none" };

interface AcceptanceWithScreen {
  id: string; cloud_terms_version: string; tos_version: string; privacy_version: string; source: string; consent_id: string | null; wording: string;
  accepted_at: number; screen_version: string | null;
}

/** Did the words this acceptance was given on carry the age confirmation? (The age is proven by the words, not by a column.) */
export function ageShown(a: Pick<AcceptanceWithScreen, "source" | "wording" | "screen_version">): boolean {
  if (a.source === "checkout") return a.screen_version !== null && AGE_SCREENS.includes(a.screen_version);
  if (a.source === "reaccept") return AGE_REACCEPT_WORDINGS.includes(a.wording);
  return false;
}

export async function mintTermsProof(env: Env, input: { homeId: string; generation: number; ownerId: string; homeTermsVersion: string; now: number }): Promise<TermsProofAnswer> {
  const { homeId, generation, ownerId, homeTermsVersion: home, now } = input;
  // A home version no row names is one nobody has said any acceptance covers: nothing is minted.
  if (rowsForHome(home).length === 0) return { status: "none" };
  const rows = (await env.DB.prepare(`SELECT a.id, a.cloud_terms_version, a.tos_version, a.privacy_version, a.source, a.consent_id, a.wording, a.accepted_at,
      c.screen_version FROM terms_acceptances a LEFT JOIN checkout_consents c ON c.id=a.consent_id
    WHERE a.user_id=? AND ${acceptanceCounts("a")} ORDER BY a.accepted_at DESC, a.rowid DESC LIMIT 50`).bind(ownerId).all<AcceptanceWithScreen>()).results;
  const claims = (a: AcceptanceWithScreen, source: TermsProofClaims["source"], graceUntil: number | null): TermsProofClaims => ({
    type: "murage-terms-v1", homeId, generation, account: ownerId, homeTermsVersion: home,
    documents: { cloudTerms: a.cloud_terms_version, termsOfService: a.tos_version, privacyPolicy: a.privacy_version },
    ageConfirmed: ageShown(a), acceptedAt: a.accepted_at, source, acceptanceId: a.id, consentId: a.consent_id, screenVersion: a.screen_version, graceUntil,
    issuedAt: now });
  const covering = rows.find((a) => (a.source === "checkout" || a.source === "reaccept") && coversHome(home, a.tos_version, a.privacy_version) && ageShown(a));
  if (covering) {
    // acceptedAt never moves past the proof's own time (a row stamped in the future is not evidence yet).
    if (covering.accepted_at > now) return { status: "none" };
    return { status: "proof", proof: await signPayload(env, claims(covering, covering.source as "checkout" | "reaccept", null)) };
  }
  // The notice period. Only for a home version whose documents are the ones in force now (the documents the notice is about), and only for a
  // customer who has an earlier acceptance of some home version on record.
  const cur = currentVersions();
  if (!rowsForHome(home).some((r) => r.tos === cur.termsOfService && r.privacy === cur.privacyPolicy)) return { status: "none" };
  // An EARLIER acceptance: its ids are those of a home version listed before this one (the table is in time order), never a newer one.
  const earlier = rows.find((a) => (a.source === "checkout" || a.source === "reaccept") && acceptanceRank(a.tos_version, a.privacy_version) >= 0
    && acceptanceRank(a.tos_version, a.privacy_version) < homeRank(home) && !coversHome(home, a.tos_version, a.privacy_version) && a.accepted_at <= now);
  if (!earlier) return { status: "none" };
  const notice = await env.DB.prepare(`SELECT effective_at FROM terms_change_notices WHERE user_id=? AND cloud_terms_version=? AND tos_version=? AND privacy_version=?`)
    .bind(ownerId, cur.cloudTerms, cur.termsOfService, cur.privacyPolicy).first<{ effective_at: number }>();
  // A delivered notice: until its effective date. No notice yet: a short grace, so no screen appears before the notice has run.
  const graceUntil = notice ? notice.effective_at : now + NOTICE_GRACE_FALLBACK_MS;
  if (graceUntil <= now) return { status: "none" };
  return { status: "proof", proof: await signPayload(env, claims(earlier, "notice-period", graceUntil)) };
}
