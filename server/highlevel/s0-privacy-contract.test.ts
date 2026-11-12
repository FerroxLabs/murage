import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { publicSignatures } from "../../scripts/highlevel-f0-snapshot.ts";
import { LOCATOR_PROFILE, LOCATOR_LIFECYCLE_EVENTS, LOCATOR_PUBLICATION_ORDER, LOCATOR_DELETION_ORDER,
  locatorMetadataSchema, locatorPayloadSchema, sealedLocatorSchema, permanentReplayTombstoneSchema,
  locatorLifetimeAllowsAccess, dispatchEvidenceSchema, creationEvidenceAdmissionSchema } from "./recovery-contract.ts";
import { CONTACT_RECOVERY_REQUIREMENT, recoveryEffectBindingDigest } from "./recovery-contract.ts";
import { INVOCATION_DESCRIPTORS, bindInvocationPlan, invocationPlanSchema } from "./operations/invocation-plans.ts";
const digest = "a".repeat(64);
const metadata = { approvalId: "approval_1", requestDigest: digest, authorityDigest: digest, operation: "contacts.create",
  locationId: "loc_1", connectionId: "conn_1", connectionEpoch: 1, credentialVersion: 1, planDigest: digest,
  conversationId: "conversation_1", reference: "locator_1", keyId: "epoch_key_1", commitment: digest, createdAt: 1000, expiresAt: 86_401_000 };

it("0c serialized plan digest binds all targets/effects/locators, with no extra parent values or repeated slots", () => {
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === "contacts.update")!;
  const readers = descriptor.readers.filter(read => read.when === "always").map((read, index) => ({ ...read, logicalKey: String(index).repeat(64), selectorDigest: digest }));
  const input = { approvalId: "approval_1", requestDigest: digest, authorityDigest: digest, operation: "contacts.update", locationId: "loc_1", connectionId: "conn_1", connectionEpoch: 1, credentialVersion: 1,
    version: 2, argumentDigest: digest, descriptorDigest: digest, branch: "plain-id", parents: { contactId: "contact_1" }, readers,
    mandatoryPreparationReads: 1, maxLogicalReads: 5, maxPhysicalReadAttempts: 10, mutationSends: 1,
    approvedTargetIds: ["contact_1"], approvedEffectDigest: digest, expectedEffectDigests: { contact_1: digest }, selectorDigest: digest,
    creationEvidence: "approved-target", locator: null, recoveryKind: "contact-direct", contactEvidence: CONTACT_RECOVERY_REQUIREMENT };
  const plan = bindInvocationPlan(input);
  expect(invocationPlanSchema.safeParse(plan).success).toBe(true);
  expect(Object.isFrozen(plan.readers)).toBe(true);
  for (const patch of [{ approvedTargetIds: ["other_contact"] }, { selectorDigest: "b".repeat(64) }, { connectionEpoch: 2 }, { authorityDigest: "b".repeat(64) }]) {
    expect(invocationPlanSchema.safeParse({ ...plan, ...patch }).success).toBe(false);
  }
  expect(() => bindInvocationPlan({ ...input, parents: { email: "private" } })).toThrow();
  expect(() => bindInvocationPlan({ ...input, expectedEffectDigests: { contact_1: digest, unapproved: digest } })).toThrow();
  expect(() => bindInvocationPlan({ ...input, readers: [...readers, { ...readers[0], logicalKey: "b".repeat(64) }] })).toThrow();
  const locator = { reference: "locator_1", commitment: digest, createdAt: 1000, expiresAt: 86_401_001 };
  expect(() => bindInvocationPlan({ ...input, locator })).toThrow();
  const effectDigest = recoveryEffectBindingDigest({ version: 2, planDigest: plan.planDigest, approvedEffectDigest: digest });
  expect(effectDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(recoveryEffectBindingDigest({ version: 2, planDigest: plan.planDigest, approvedEffectDigest: "b".repeat(64) })).not.toBe(effectDigest);
});

it("0c pins an independent deletable locator store, lifetime/capacity and indexed cleanup bounds", () => {
  expect(LOCATOR_PROFILE).toEqual({ maxLifetimeMs: 86_400_000, maxPayloadBytes: 4096, maxActivePayloads: 256,
    cleanupPageSize: 32, cleanupPagesPerTransaction: 1, ttlAnchor: "initial-preparation", extendOnRead: false,
    tombstoneExpiry: false, startupIndependentOfReplay: true, commitment: "keyed-hmac-sha256" });
  expect(LOCATOR_LIFECYCLE_EVENTS).toEqual(["terminal", "review-cancel", "review-stale", "grant-revoke", "connection-replace", "disconnect", "conversation-delete", "expiry", "missing-key", "tamper"]);
  expect(LOCATOR_PUBLICATION_ORDER).toEqual(["reserve-metadata", "commit-allocation-and-indexes", "publish-authenticated-ciphertext", "activate-bound-plan", "dispatch"]);
  expect(LOCATOR_DELETION_ORDER).toEqual(["publish-revocation", "retain-job-and-indexes", "unlink-payload", "fsync-directory", "remove-job-and-indexes"]);
});
it("0c TTL anchors at initial preparation; rollback, expiry and invalid extension refuse without decrypting", () => {
  expect(locatorMetadataSchema.safeParse(metadata).success).toBe(true);
  expect(locatorLifetimeAllowsAccess(metadata, 1000)).toBe(true);
  expect(locatorLifetimeAllowsAccess(metadata, metadata.expiresAt - 1)).toBe(true);
  for (const now of [999, metadata.expiresAt, metadata.expiresAt + 1, NaN]) expect(locatorLifetimeAllowsAccess(metadata, now)).toBe(false);
  expect(locatorMetadataSchema.safeParse({ ...metadata, expiresAt: metadata.expiresAt + 1 }).success).toBe(false);
  expect(locatorMetadataSchema.safeParse({ ...metadata, expiresAt: metadata.createdAt }).success).toBe(false);
  expect(locatorMetadataSchema.safeParse({ ...metadata, createdAt: -1 }).success).toBe(false);
  expect(metadata.expiresAt).toBe(86_401_000);
});
it("0c accepts only minimum approved selectors and at most 4 KiB, never bodies/review/provider responses", () => {
  expect(locatorPayloadSchema.safeParse({ kind: "contact-email", email: "fixture@example.test", identityRuleDigest: digest }).success).toBe(true);
  expect(locatorPayloadSchema.safeParse({ kind: "contact-phone", phone: "+15555550199", identityRuleDigest: digest }).success).toBe(true);
  expect(locatorPayloadSchema.safeParse({ kind: "redirect-domain-path", old: { domain: "fixture.example", path: "/approved" } }).success).toBe(true);
  for (const extra of [{ message: "PRIVATE_BODY_SENTINEL" }, { note: "PRIVATE_BODY_SENTINEL" }, { providerResponse: {} }, { reviewValues: {} }, { password: "fixture-only" }]) {
    expect(locatorPayloadSchema.safeParse({ kind: "contact-email", email: "fixture@example.test", identityRuleDigest: digest, ...extra }).success).toBe(false);
  }
  expect(locatorPayloadSchema.safeParse({ kind: "contact-name", query: "x".repeat(76), identityRuleDigest: digest }).success).toBe(false);
  expect(locatorPayloadSchema.safeParse({ kind: "redirect-domain-path", old: { domain: "fixture.example", path: "/" + "x".repeat(2047) }, next: { domain: "fixture.example", path: "/" + "y".repeat(2047) } }).success).toBe(false);
});
it("0c sealed records and permanent tombstones refuse plaintext, ciphertext spill and arbitrary retention", () => {
  const sealed = { metadata, algorithm: "aes-256-gcm", nonce: Buffer.alloc(12, 1).toString("base64url"), ciphertext: Buffer.alloc(32, 2).toString("base64url") };
  expect(sealedLocatorSchema.safeParse(sealed).success).toBe(true);
  expect(sealedLocatorSchema.safeParse({ ...sealed, email: "fixture@example.test" }).success).toBe(false);
  expect(sealedLocatorSchema.safeParse({ ...sealed, selectorPlaintext: "fixture@example.test" }).success).toBe(false);
  const tombstone = { approvalId: "approval_1", requestDigest: digest, authorityDigest: digest, operation: "contacts.create", planDigest: digest, dispatchAttempts: 1, outcome: "outcome_unknown" };
  expect(permanentReplayTombstoneSchema.safeParse(tombstone).success).toBe(true);
  for (const extra of [{ selector: "fixture@example.test" }, { ciphertext: sealed.ciphertext }, { locator: sealed }, { expiresAt: 1000 }, { refreshToken: "fixture-only" }]) {
    expect(permanentReplayTombstoneSchema.safeParse({ ...tombstone, ...extra }).success).toBe(false);
  }
});
it("0c creation attribution requires durable validated response from the exact dispatch, never a unique delayed index match", () => {
  const evidence = { approvalId: "approval_1", requestDigest: digest, authorityDigest: digest, operation: "contacts.upsert", credentialVersion: 1,
    recordId: "contact_1", creationBranch: "created", confirmationDigest: digest };
  expect(dispatchEvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(dispatchEvidenceSchema.safeParse({ ...evidence, creationBranch: "existing" }).success).toBe(true);
  const admission = { source: "authenticated-dispatch-response", evidence, durablyPublished: true, beforeTerminalRelease: true };
  expect(creationEvidenceAdmissionSchema.safeParse(admission).success).toBe(true);
  for (const patch of [{ source: "search-unique-after" }, { source: "absent-before-present-after" }, { durablyPublished: false }, { beforeTerminalRelease: false }]) {
    expect(creationEvidenceAdmissionSchema.safeParse({ ...admission, ...patch }).success).toBe(false);
  }
  for (const patch of [{ creationBranch: undefined }, { confirmationDigest: "invalid" }, { new: true }, { providerBody: {} }, { email: "fixture@example.test" }]) {
    expect(dispatchEvidenceSchema.safeParse({ ...evidence, ...patch }).success).toBe(false);
  }
});
it("0c narrowly folds only explicitly annotated equivalent readonly parameter properties", () => {
  const shorthand = "export class Example { constructor(readonly code: string) {} }";
  const portable = "export class Example {\n/** @frozenParameterProperty */\nreadonly code: string; constructor(code: string) { this.code = code; } }";
  expect(publicSignatures(portable)).toEqual(publicSignatures(shorthand));
  for (const changed of [portable.replace("readonly code: string", "readonly other: string"), portable.replace("readonly code: string", "readonly code: number"),
    portable.replace("constructor(code: string)", "constructor(code: number)"), portable.replace("readonly code:", "code:"),
    portable.replace("/** @frozenParameterProperty */", ""), portable.replace("constructor(code: string)", "constructor(code?: string)"),
    portable.replace("constructor(code: string)", "constructor(...code: string[])"), portable.replace("constructor(code: string)", "constructor(code: string, other: number)"),
    portable.replace("constructor(code: string) { this.code = code; }", "constructor(code: string);"),
    portable.replace("readonly code: string;", "readonly code!: string;"), portable.replace("readonly code: string;", 'readonly code: string = "fixed";'),
    portable.replace("readonly code: string;", "readonly code: string; readonly another: number;"),
  ]) expect(publicSignatures(changed), changed).not.toEqual(publicSignatures(shorthand));
});
it("0c freezes plain owner copy in the handoff locale inventory", () => {
  const copy = JSON.parse(readFileSync("server/highlevel/s0-locale-inventory.json", "utf8"));
  expect(copy["highlevel.contract.outcomeUnknown"]).toBe("Not sure it went through. Check HighLevel; Murage will not send it again.");
  expect(copy["highlevel.contract.courseImportSent"]).toBe("The course import was sent. Check it in HighLevel. Murage will not send it again.");
  expect(copy["highlevel.contract.locatorUnavailable"]).toBe("Murage can no longer check this change automatically. Check it in HighLevel. It will not be sent again.");
});
