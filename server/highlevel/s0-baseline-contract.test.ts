import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A baseline may not publish an S0 capability. Report that as an assertion on the
// requested contract behavior, never a failing static import or a fabricated implementation.
// Only absence is handled here: errors importing an existing module remain test errors.
async function publishedModule(path: string): Promise<Record<string, { safeParse(input: unknown): { success: boolean } }> | null> {
  return existsSync(path) ? import(/* @vite-ignore */ pathToFileURL(resolve(path)).href) : null;
}
const digest = "a".repeat(64);
const direct = { operation: "contacts.get", pathTemplate: "/contacts/:contactId", version: "2021-07-28", scope: "contacts.readonly",
  when: "always", maxReads: 1, selectors: [{ kind: "connection", field: "locationId" }, { kind: "argument", field: "contactId" }] };
const readers = [
  { ...direct, slot: "prepare.contacts.get", phase: "prepare", evidenceClass: "locator-observation", reuse: "preparation-only", logicalKey: "0".repeat(64), selectorDigest: digest },
  { slot: "prepare.location.customFields.list", operation: "location.customFields.list", pathTemplate: "/locations/:locationId/customFields", version: "2021-07-28", scope: "locations/customFields.readonly",
    phase: "prepare", when: "nonempty-custom-fields", maxReads: 1, selectors: [{ kind: "connection", field: "locationId" }], evidenceClass: "locator-observation", reuse: "preparation-only", logicalKey: "1".repeat(64), selectorDigest: digest },
  { ...direct, slot: "recovery.contacts.get", phase: "recovery", evidenceClass: "post-write-direct", reuse: "never", logicalKey: "2".repeat(64), selectorDigest: digest },
];
it("afix BLOCK 4 baseline planning accepts the independent custom-field plan and rejects scope removal", async () => {
  const published = await publishedModule("server/highlevel/operations/invocation-plans.ts");
  const plan = { version: 2, operation: "contacts.update", argumentDigest: digest, descriptorDigest: digest, branch: "nonempty-fields",
    locationId: "loc_1", connectionId: "conn_1", connectionEpoch: 1, credentialVersion: 1, readers,
    requiredScopes: ["contacts.write", "contacts.readonly", "locations/customFields.readonly"], mandatoryPreparationReads: 2, maxLogicalReads: 5, maxPhysicalReadAttempts: 10 };
  expect(published?.invocationArgumentPlanSchema.safeParse(plan).success ?? false, "published pure plan admission").toBe(true);
  expect(published?.invocationArgumentPlanSchema.safeParse({ ...plan, requiredScopes: ["contacts.write", "contacts.readonly"] }).success).toBe(false);
  expect(published?.invocationArgumentPlanSchema.safeParse({ ...plan, readers: [{ ...readers[0], operation: "users.get" }] }).success).toBe(false);
});
it("afix BLOCK 4 baseline ownership assigns both concrete admission and immutable RPC validation", () => {
  const path = "server/highlevel/s0-ownership.json";
  const published = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  expect(published?.["C2-client"]?.regions ?? [], "concrete reader/budget ownership").toContain("server/highlevel/client.ts:462-468,471-529,913-926 concrete admission/shared budget/cache");
  expect(published?.["C2-journal"]?.regions ?? [], "immutable RPC binding ownership").toContain("server/highlevel/rpc-approval-replay.ts:31-48 sole empty-target exception/v2 binding");
});
it("afix BLOCK 4 baseline evidence admits fresh direct proof and refuses locator/prewrite/partial proof", async () => {
  const published = await publishedModule("server/highlevel/recovery-contract.ts");
  const proof = { evidenceClass: "post-write-direct", reader: "contacts.get", exactId: true, wholeResponseIdentity: true,
    fullEffectDigest: true, initiatedAfterDispatch: true, invocationLocal: true, allTargets: true, onInsufficientEvidence: "outcome_unknown", resend: false };
  expect(published?.contactRecoveryRequirementSchema.safeParse(proof).success ?? false, "published direct proof admission").toBe(true);
  for (const patch of [{ reader: "contacts.search" }, { evidenceClass: "locator-observation" }, { fullEffectDigest: false }, { initiatedAfterDispatch: false }, { allTargets: false }]) {
    expect(published?.contactRecoveryRequirementSchema.safeParse({ ...proof, ...patch }).success, JSON.stringify(patch)).toBe(false);
  }
});
