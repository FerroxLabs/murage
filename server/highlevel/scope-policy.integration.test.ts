// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planInvocation } from "./scope-policy.ts";
let reads = 0;
beforeEach(() => { reads = 0; vi.stubGlobal("fetch", () => { reads++; throw Error("unexpected policy I/O"); }); });
afterEach(() => { vi.unstubAllGlobals(); expect(reads).toBe(0); });
const metadata = { connectionId: "conn1", locationId: "loc1", connectionEpoch: 1, credentialVersion: 1,
  scopes: ["invoices.write", "invoices.readonly", "contacts.readonly", "documents_contracts/sendlink.write", "documents_contracts/list.readonly"] };
const invoice = (id: string) => ({ altId: "loc1", altType: "location", status: "draft", name: "Fixture invoice", currency: "USD",
  businessDetails: { name: "Fixture seller" }, items: [{ name: "Fixture item", currency: "USD", amount: 1, qty: 1 }],
  discount: { type: "fixed", value: 0 }, contactDetails: { id, name: "Fixture buyer", phoneNo: "+15550000001", email: "fixture@example.test" },
  issueDate: "2026-11-11", sentTo: { email: ["fixture@example.test"] }, liveMode: false });
it("S0 nested invoice contact selectors bind the actual contact ID before any I/O", () => {
  const first = planInvocation("payments.invoice.create", invoice("contact1"), metadata);
  const second = planInvocation("payments.invoice.create", invoice("contact2"), metadata);
  expect(first.ok, JSON.stringify(first)).toBe(true); expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw Error("expected invoice plans");
  expect(first.plan.mandatoryPreparationReads).toBe(2);
  expect(first.requiredScopes).toEqual(["contacts.readonly", "invoices.readonly", "invoices.write"]);
  const read = first.plan.readers.find(row => row.operation === "contacts.get")!;
  expect(read.maxReads).toBe(1);
  expect(read.selectorDigest).not.toBe(second.plan.readers.find(row => row.operation === "contacts.get")!.selectorDigest);
  expect(read.logicalKey).not.toBe(second.plan.readers.find(row => row.operation === "contacts.get")!.logicalKey);
});
it("S0 nested invoice contact scopes refuse before I/O", () => {
  expect(planInvocation("payments.invoice.create", invoice("contact1"), { ...metadata, scopes: ["invoices.readonly", "invoices.write"] }))
    .toMatchObject({ ok: false, refusal: { code: "missing_scope", permissionIds: ["contacts.readonly"] } });
});
it("empty unadopted document recipients require no contact scope", () => {
  const result = planInvocation("documents.send", { locationId: "loc1", documentId: "doc1", sentBy: "fixture@example.test", ccRecipients: [] }, metadata);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error("expected empty recipient plan");
  expect(result.plan.mandatoryPreparationReads).toBe(1);
  expect(result.plan.readers.some(row => row.operation === "contacts.get")).toBe(false);
  expect(result.requiredScopes).toEqual(["documents_contracts/list.readonly", "documents_contracts/sendlink.write"]);
});
it.each([1, 4, 5])("unadopted document recipients preserve the frozen no-URL-field policy (%i recipients)", count => {
  const recipient = { id: "contact1", email: "fixture@example.test", imageUrl: "fixture", contactName: "Fixture", firstName: "Fixture", lastName: "Recipient" };
  expect(planInvocation("documents.send", { locationId: "loc1", documentId: "doc1", sentBy: "fixture@example.test", ccRecipients: Array.from({length:count}, () => ({...recipient})) }, metadata))
    .toMatchObject({ ok: false, refusal: { code: "invalid_plan" } });
});
