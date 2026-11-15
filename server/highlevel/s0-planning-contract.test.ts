import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import rows from "./operations/manifest-data.json" with { type: "json" };
import { INVOCATION_DESCRIPTORS, invocationArgumentPlanSchema, invocationPlanSchema } from "./operations/invocation-plans.ts";
import { contactRecoveryRequirementSchema, READ_BUDGET_PROFILE } from "./recovery-contract.ts";
import { accessLeaseSchema, scopeInventorySchema, OAUTH_TOKEN_CONTRACT } from "../../cloudflare/crm-broker/src/contracts.ts";
import { schemas as conversationSchemas } from "./operations/schemas/conversations.ts";
import { schemas as locationSchemas } from "./operations/schemas/location.ts";

it("afix BLOCK 3 field-definition creation always prepares the definition list", () => {
  const args = locationSchemas["location.customFields.create"].argsSchema.parse({ name: "Fixture preference", dataType: "TEXT", model: "contact" });
  expect(args).not.toHaveProperty("customFields");
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === "location.customFields.create")!;
  expect(descriptor.endpointScope).toBe("locations/customFields.write");
  const preparation = descriptor.readers.filter(read => read.phase === "prepare");
  expect(preparation).toEqual([{ slot: "prepare.location.customFields.list", operation: "location.customFields.list",
    pathTemplate: "/locations/:locationId/customFields", version: "2021-07-28", scope: "locations/customFields.readonly",
    phase: "prepare", when: "always", maxReads: 1, selectors: [{ kind: "connection", field: "locationId" }],
    evidenceClass: "locator-observation", reuse: "preparation-only" }]);
  expect(descriptor.readers.filter(read => read.phase === "recovery").map(read => [read.operation, read.when]))
    .toEqual([["location.customFields.list", "always"]]);
  // Contact value normalization remains conditional; a field definition is a different argument shape.
  for (const operation of ["contacts.create", "contacts.update", "contacts.upsert"]) {
    expect(INVOCATION_DESCRIPTORS.find(row => row.operation === operation)!.readers.find(read => read.operation === "location.customFields.list")!.when).toBe("nonempty-custom-fields");
  }
});

// Handwritten valid arguments: these schemas accept contact IDs, not conversation IDs.
const sendVectors = [
  ["conversations.send.sms", "SMS"], ["conversations.send.email", "Email"],
  ["conversations.send.whatsapp", "WhatsApp"], ["conversations.send.facebook", "FB"],
  ["conversations.send.instagram", "IG"], ["conversations.send.gmb", "GMB"],
  ["conversations.send.livechat", "Live_Chat"], ["conversations.send.scheduledSms", "SMS"],
  ["conversations.send.scheduledEmail", "Email"],
] as const;
it.each(sendVectors)("afix BLOCK 1 %s closes contact-to-conversation dependencies before history/ownership", (operation, type) => {
  const args = conversationSchemas[operation].argsSchema.parse({ type, contactId: "contact_1", status: "pending", scheduledTimestamp: 2_000_000_000 });
  expect(args).not.toHaveProperty("conversationId");
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === operation)!;
  const search = descriptor.readers.find(read => read.slot === "prepare.conversations.search");
  expect(search).toEqual({ slot: "prepare.conversations.search", operation: "conversations.search",
    pathTemplate: "/conversations/search", version: "2021-04-15", scope: "conversations.readonly",
    phase: "prepare", when: "no-conversation-id", maxReads: 2,
    selectors: [{ kind: "connection", field: "locationId" }, { kind: "argument", field: "contactId" }],
    evidenceClass: "locator-observation", reuse: "preparation-only" });
  // Every symbolic dependency must name a declared source, including recovery's retained parent.
  for (const read of descriptor.readers) for (const selector of read.selectors) {
    if (selector.kind === "dependency") expect(descriptor.readers.some(source => source.slot === selector.slot), `${operation}: ${read.slot} -> ${selector.slot}`).toBe(true);
  }
  const preparation = descriptor.readers.filter(read => read.phase === "prepare");
  expect(preparation.findIndex(read => read.slot === "prepare.conversations.search"))
    .toBeLessThan(preparation.findIndex(read => read.slot === "prepare.conversations.messages.list"));
  expect(preparation.findIndex(read => read.slot === "prepare.conversations.search"))
    .toBeLessThan(preparation.findIndex(read => read.slot === "prepare.conversations.get"));
  expect(preparation.reduce((count, read) => count + read.maxReads, 0)).toBe(5);
  // Instantiate the declared dependency with a fake selected ID, without fetching outside the plan.
  const found = { id: "conversation_1" };
  for (const slot of ["prepare.conversations.get", "prepare.conversations.messages.list", "recovery.conversations.messages.list"]) {
    const read = descriptor.readers.find(read => read.slot === slot)!;
    expect(read.selectors).toContainEqual({ kind: "dependency", slot: "prepare.conversations.search", field: "id" });
    expect(read.pathTemplate.replace(":conversationId", found.id)).toBe(slot.endsWith(".list") ? "/conversations/conversation_1/messages" : "/conversations/conversation_1");
  }
});

it("0a freezes exact ready row/descriptor/owner equality, explicitly excluding absent rows", () => {
  expect(INVOCATION_DESCRIPTORS.map(row => row.operation).sort()).toEqual(rows.filter(row => row.disposition === "ready").map(row => row.id).sort());
  for (const descriptor of INVOCATION_DESCRIPTORS) {
    const row = rows.find(row => row.id === descriptor.operation)!;
    expect(descriptor.owner).toMatch(/^F(?:[1-7]|9|10)$/);
    expect(descriptor.endpointScope).toBe(row.scope);
    for (const read of descriptor.readers) {
      const target = rows.find(row => row.id === read.operation)!;
      expect(target.risk).toBe("R"); expect(target.disposition).toBe("ready");
      expect(read.pathTemplate).toBe(target.path); expect(read.scope).toBe(target.scope);
      expect(read.maxReads).toBeLessThanOrEqual(5);
    }
  }
});
it("0a independent conditional vectors pin reader scopes before I/O", () => {
  const descriptor = (id: string) => INVOCATION_DESCRIPTORS.find(row => row.operation === id)!;
  const readers = (id: string) => descriptor(id).readers.map(read => [read.operation, read.phase, read.when]);
  expect(readers("contacts.create")).toEqual([
    ["contacts.search", "prepare", "approved-contact-locator"],
    ["location.customFields.list", "prepare", "nonempty-custom-fields"],
    ["contacts.get", "recovery", "dispatch-attributed-id"],
  ]);
  expect(descriptor("contacts.create").endpointScope).toBe("contacts.write");
  expect(descriptor("contacts.create").readers.map(read => read.scope)).toEqual(["contacts.readonly", "locations/customFields.readonly", "contacts.readonly"]);
  expect(readers("contacts.update")).toEqual([
    ["contacts.get", "prepare", "always"],
    ["location.customFields.list", "prepare", "nonempty-custom-fields"],
    ["contacts.get", "recovery", "always"],
  ]);
  expect(readers("contacts.tags.bulk")).toEqual([
    ["contacts.search", "prepare", "bulk-approved-ids"], ["contacts.get", "recovery", "bulk-approved-ids"],
  ]);
  expect(descriptor("contacts.tags.bulk").readers[0].selectors).toContainEqual({ kind: "argument", field: "contacts" });
  expect(readers("opportunities.upsert")).toContainEqual(["opportunities.get", "prepare", "body-id"]);
  expect(readers("opportunities.upsert")).toContainEqual(["opportunities.pipelines.list", "prepare", "always"]);
  expect(readers("opportunities.upsert")).toContainEqual(["users.list", "prepare", "multiple-user-ids"]);
  expect(descriptor("opportunities.upsert").readers.find(read => read.operation === "opportunities.pipelines.list")?.selectors)
    .toContainEqual({ kind: "dependency", slot: "prepare.opportunities.get", field: "pipelineId" });
  expect(descriptor("courses.import").readers).toEqual([]);
  expect(descriptor("courses.import").endpointScope).toBe("courses.write");
  expect(READ_BUDGET_PROFILE).toEqual({ logicalReads: 5, attemptsPerRead: 2, physicalReadAttempts: 10, mutationSends: 1, sharedBy: "invocation", proofAccumulation: false });
});
it("0a contact proof requires fresh exact-ID/digest post-write evidence; search remains a locator", () => {
  const requirement = { evidenceClass: "post-write-direct", reader: "contacts.get", exactId: true, wholeResponseIdentity: true, fullEffectDigest: true,
    initiatedAfterDispatch: true, invocationLocal: true, allTargets: true, onInsufficientEvidence: "outcome_unknown", resend: false };
  expect(contactRecoveryRequirementSchema.safeParse(requirement).success).toBe(true);
  for (const patch of [{ evidenceClass: "locator-observation" }, { reader: "contacts.search" }, { fullEffectDigest: false },
    { initiatedAfterDispatch: false }, { invocationLocal: false }, { allTargets: false }, { resend: true }]) {
    expect(contactRecoveryRequirementSchema.safeParse({ ...requirement, ...patch }).success, JSON.stringify(patch)).toBe(false);
  }
  expect(invocationPlanSchema.safeParse({ version: 1 }).success).toBe(false);
});
it("0a pure pre-I/O plans cannot add a reader, scope, selector, bound, or credential acquisition", () => {
  const digest = "a".repeat(64);
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === "contacts.update")!;
  const readers = descriptor.readers.filter(read => read.when === "always").map((read, i) => ({ ...read, logicalKey: String(i).repeat(64), selectorDigest: digest }));
  const plan = { version: 2, operation: "contacts.update", argumentDigest: digest, descriptorDigest: digest, branch: "plain-id",
    locationId: "loc_1", connectionId: "conn_1", connectionEpoch: 1, credentialVersion: 1, readers,
    requiredScopes: ["contacts.write", "contacts.readonly"], mandatoryPreparationReads: 1, maxLogicalReads: 5, maxPhysicalReadAttempts: 10 };
  expect(invocationArgumentPlanSchema.safeParse(plan).success).toBe(true);
  expect(invocationArgumentPlanSchema.safeParse({ ...plan, requiredScopes: ["contacts.write"] }).success).toBe(false);
  for (const patch of [{ operation: "users.get" }, { scope: "users.readonly" }, { maxReads: 5 }, { phase: "recovery" },
    { selectors: [{ kind: "argument", field: "otherId" }] }]) {
    expect(invocationArgumentPlanSchema.safeParse({ ...plan, readers: [{ ...readers[0], ...patch }] }).success).toBe(false);
  }
  expect(invocationArgumentPlanSchema.safeParse({ ...plan, mandatoryPreparationReads: 6 }).success).toBe(false);
  expect(invocationArgumentPlanSchema.safeParse({ ...plan, accessToken: "fixture-only" }).success).toBe(false);
  expect(invocationArgumentPlanSchema.safeParse({ ...plan, operation: "snapshots.apply" }).success).toBe(false);
});
it("0a source inventory is actual Location token-response provenance and access-only", () => {
  expect(OAUTH_TOKEN_CONTRACT).toEqual({ version: "2021-07-28", method: "POST", origin: "https://services.leadconnectorhq.com", path: "/oauth/token", encoding: "application/x-www-form-urlencoded", userType: "Location", versionHeader: false });
  const inventory = { provenance: "oauth-token-response", userType: "Location", locationId: "loc_1", scopes: ["contacts.write", "contacts.readonly"], grantVersion: 1, connectionEpoch: 1 };
  expect(scopeInventorySchema.safeParse(inventory).success).toBe(true);
  for (const patch of [{ provenance: "requested-scopes" }, { userType: "Company" }, { scopes: [] }, { scopes: ["oauth.write"] }, { scopes: ["none"] }]) {
    expect(scopeInventorySchema.safeParse({ ...inventory, ...patch }).success).toBe(false);
  }
  const lease = { ...inventory, grantId: "grant_1", credentialVersion: 1, accessToken: "fixture-access", expiresAt: 1000 };
  expect(accessLeaseSchema.safeParse(lease).success).toBe(true);
  expect(accessLeaseSchema.safeParse({ ...lease, refreshToken: "fixture-refresh" }).success).toBe(false);
});
it("0a preserves the frozen context/hooks and records real family owner tips", () => {
  const inventory = JSON.parse(readFileSync("server/highlevel/s0-owner-inventory.json", "utf8"));
  expect(inventory.base).toBe("5daadeac8ebbdc4100d9b9f2805c5e4135262c5a");
  expect(inventory.families).toHaveLength(17);
  for (const row of inventory.families) {
    expect(row.tip).toMatch(/^[a-f0-9]{40}$/); expect(row.status).toBe("owner-tip-observed-adoption-required");
  }
  const ownership = JSON.parse(readFileSync("server/highlevel/s0-ownership.json", "utf8"));
  expect(ownership["C2-client"].regions).toContain("server/highlevel/client.ts:462-468,471-529,913-926 concrete admission/shared budget/cache");
  expect(ownership["C2-journal"].regions).toContain("server/highlevel/rpc-approval-replay.ts:31-48 sole empty-target exception/v2 binding");
  expect(ownership["C2-cleanup-via-S-INT"].regions).toHaveLength(3);
  expect(ownership.S0.files).toContain("cloudflare/crm-broker/src/contracts.ts");
});
