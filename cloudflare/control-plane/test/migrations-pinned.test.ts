// SPDX-License-Identifier: AGPL-3.0-or-later
// ITEM 9 (MurageMain 11-03): migrations 0133-0144, the launch set, pinned by the sha256 of each file as it stands at cloud-v2/item9-mediums.
// applied on staging/prod: never edit; add a new migration.
// (0144 took its last in-place edits in ITEM 9: the 'queued' state, then r2's door_computer_notices claim columns; staging stood at 0139 and
// prod at 0132 then.) A change to any of these
// files after staging or prod applied it would leave the deployed schema and the repo apart, so this test fails on any byte changed.
import { describe, expect, it } from "vitest";

const PINNED: Record<string, string> = {
  "0133_auto_canary_lease.sql": "50c9196de555b068ce35072f960b55f9c66a5a67debcceacc8838364b26909bb",
  "0134_browser_owner.sql": "7d314ee63fe68440b02cbc53f598ff2a407d122aa65fb9db0e25a05aaed9e82c",
  "0135_device_joins.sql": "aa68f11333d23fea36dd686f263e24f6afea8029164dce60576f2a7c40943867",
  "0136_cloud_autotopup.sql": "952898eb66362028eb2047afb97b3013da637a27cb9daa15e090b03071326e40",
  "0137_flux_terms_version.sql": "8cb7560e0f7fd4272800de7f329812207ce446725e33bcf0581c2783499b2b46",
  "0138_autotopup_review_fixes.sql": "b1ecf6c5a83f9b70d257a8115a4681ec8dd167560d0f8d1e2b9fe3d217734931",
  "0139_flux_first_key_retry.sql": "efbb7a2d8f9093ba6b0625a89bbdb9757802757c6357b607af0357f3428df91c",
  "0140_flux_welcome_mail.sql": "bfdcecb43035b0e828224109a4912d051a20c52184153c004934e3afd127b3a4",
  "0141_flux_email_proof.sql": "710333f590f0e4d27d2fe3676215ed9f7dd1769d70f9a502585dbf0cfbc5583e",
  "0142_flux_first_key_hold.sql": "076959d43b5c4ffff7b1b4726c0f05d5ce1071a0c036eb0840430b1f27c08160",
  "0143_flux_email_hold.sql": "8717059059c2beaf951f6662ecefb4a2f81e028aa815c8f75fc5ecbef8de718e",
  "0144_flux_email_proof_autosend.sql": "6fbd79f2f371d61d79608bf69ff9673ea0e7eb10824e4e58d6619596f102aa1f",
};

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob("../migrations/01[34]*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

describe("launch migrations 0133-0144 are pinned (applied on staging/prod: never edit; add a new migration)", () => {
  it("every file 0133-0144 exists and matches its pinned sha256", async () => {
    const byName = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path.split("/").at(-1)!, text]));
    const inRange = Object.keys(byName).filter((n) => n >= "0133" && n < "0145").sort();
    expect(inRange).toEqual(Object.keys(PINNED).sort());
    for (const name of inRange) expect([name, await sha256(byName[name]!)]).toEqual([name, PINNED[name]]);
  });
});
