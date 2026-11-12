import { expect, it, vi } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import * as registry from "./operations/registry.ts";
import { HIGHLEVEL_ENDPOINTS } from "./provider-contract.ts";
const read = (p: string) => existsSync(p) ? readFileSync(p, "utf8") : "";
const source = (p: string) => read(`server/highlevel/${p}`);
it("T-D1 everyReadHasPrepareRead: registry rejects a read without preparation", () => {
  const row = (registry as any).HIGHLEVEL_OPERATION_MANIFEST?.find((r: any) => r.id === "contacts.get");
  expect(row).toBeDefined();
  const spec = { id: row.id, family: row.family, risk: row.risk, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id], args: row.argsSchema, preflight: row.preflight, title: "Read", nested: false, maxReads: 1, recordRefs: () => [], fields: () => [], targets: () => 1, project: (v: unknown) => v };
  expect(() => registry.freezeOperationSpec(spec as any)).toThrow(/prepareRead/);
  expect(() => registry.freezeOperationSpec({ ...spec, prepareRead: async () => ({ path: "/contacts/a", resource: "contacts:contact:a" }) } as any)).not.toThrow();
});
for (const [name, patch, reason] of [
  ["T-D2 nestedRequiresOwnership", { nested: true }, /ownership/],
  ["T-D3 gdpRequiresRecheck", { recheck: undefined }, /recheck/],
  ["T-D4 noRunMember", { run: () => undefined }, /run/],
  ["schemaIdentity", { args: {} }, /schema/],
] as const) it(name, () => {
  const row = (registry as any).HIGHLEVEL_OPERATION_MANIFEST?.find((r: any) => r.id === "payments.invoice.update");
  expect(row).toBeDefined();
  const spec = { id: row.id, family: row.family, risk: row.risk, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id], args: row.argsSchema, preflight: row.preflight, title: "Update", nested: false, gate: row.gate, send: row.send, precondition: row.precondition, prepare: async () => ({}), recheck: async () => ({ ok: true }), recordRefs: () => [], fields: () => [], targets: () => 1, project: (v: unknown) => v, ...(patch as Record<string, unknown>) };
  expect(() => registry.freezeOperationSpec(spec as any)).toThrow(reason);
});
it("T-D5 freeze.acceptsReadSpec: frozen declaration accepts the union", () => {
  expect(source("held-request.ts")).toMatch(/freeze\(spec: OperationSpec<any>/);
  expect(source("held-request.ts")).toContain("sendFrozenRead");
});
it("T-D6 interface.noLocalRedeclaration", () => {
  expect(source("operations/registry.ts")).toContain("export interface SpecBase");
  for (const f of readdirSync("server/highlevel/operations").filter(f => f.endsWith(".ts") && f !== "registry.ts" && !f.endsWith(".test.ts"))) expect(source(`operations/${f}`)).not.toMatch(/interface (RequestDraft|SpecBase|ReadSpec|MutationSpec)\b/);
});
it("B wire hash and request digest are distinct; send copy exposes multipart range", () => {
  const s = source("held-request.ts");
  for (const key of ["FrozenUploadRef", "contentType", "bodySha256", "requestDigest", "fileOffset", "fileLength", "approvedRequestDigest"]) expect(s).toContain(key);
});
it("C action/review declarations bind held request and terminal reads", () => {
  const s = source("actions.ts");
  for (const key of ["read_done", "read_withheld", "settleRead", "held: HeldRequest", "ReviewDigestInput", "request_shape", "requestDigest", "bodySha256", "resource", "Escalation"]) expect(s).toContain(key);
  expect(source("client.ts")).toMatch(/beforeReadAttempt\?:\s*\(attempt: number\)/);
});
it("A anchored upload declarations", () => {
  expect(source("anchored-read.ts")).toContain("AnchoredReadRefused");
  expect(source("uploads.ts")).toContain("copyBytes(): Uint8Array");
});
it("E origin contract is variant specific", () => {
  expect(source("event-projection.ts")).toContain('[["item.started", "tool"], ["item.completed", "assistant_text"]]');
  expect(source("event-projection.ts")).toContain("originRequired");
});
it("D contact preflights cover self, children and custom fields", () => {
  const rows = (registry as any).HIGHLEVEL_OPERATION_MANIFEST;
  expect(rows).toBeDefined();
  for (const id of ["contacts.create", "contacts.update", "contacts.upsert"]) expect(rows.find((r: any) => r.id === id).preflight).toContain("location.customFields.list");
  for (const id of ["contacts.get", "contacts.tags.bulk"]) expect(rows.find((r: any) => r.id === id).preflight).toContain("contacts.get");
  for (const child of ["notes", "tasks"]) expect(rows.find((r: any) => r.id === `contacts.${child}.update`).preflight).toContain(`contacts.${child}.get`);
});
it("r3 effective authority bindings, send grammar and bus seam", () => {
  const s = read("shared/highlevel.ts");
  expect(s).toContain('export type Risk = "R" | "C" | "D"');
  for (const key of ["EffectiveGrant", "EffectiveHighLevelAccess", "workspaceFileRefSchema", "HIGHLEVEL:SEND"]) expect(s).toContain(key);
  expect(read("server/harness/bus.ts")).toContain("highlevelProjection(");
});
it("provider absent refuses before any lease", async () => {
  const { HighLevelClient } = await import("./client.ts");
  const lease = vi.fn();
  const client = new HighLevelClient({ leases: { lease, connection: vi.fn() } } as any);
  await expect(client.request({} as any, "snapshots.apply", "/snapshots/apply")).rejects.toThrow();
  expect(lease).not.toHaveBeenCalled();
});

import { expectTypeOf } from "vitest";
import type { RuntimeEvent, ItemOrigin } from "../contracts.ts";
import { ORIGIN_VARIANTS } from "./event-projection.ts";
import { HeldRequest } from "./held-request.ts";
import type { OperationSpec } from "./operations/registry.ts";
type OriginPair<E> = E extends { type: infer T; itemType: infer I } ? readonly [T, I] : never;
it("T-E5 types.originVariantsMatchContract; T-D5 freeze accepts R/C/D", () => {
  expectTypeOf<typeof ORIGIN_VARIANTS[number]>().toEqualTypeOf<OriginPair<Extract<RuntimeEvent, { origin: ItemOrigin }>>>();
  expectTypeOf<Parameters<typeof HeldRequest.freeze>[0]>().toEqualTypeOf<OperationSpec<any>>();
});
it("registry rejects pagination, preflight and endpoint drift", () => {
  const row = registry.HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === "contacts.get")!;
  const spec: any = { id: row.id, family: row.family, risk: "R", row, endpoint: HIGHLEVEL_ENDPOINTS[row.id], args: row.argsSchema,
    preflight: row.preflight, title: "Read", nested: true, ownership: async () => {}, maxReads: 1, prepareRead: async () => ({}),
    recordRefs: () => [], fields: () => [], targets: () => 1, project: (v: unknown) => v };
  expect(() => registry.freezeOperationSpec({ ...spec, nextPage: () => null })).toThrow(/nextPage/);
  expect(() => registry.freezeOperationSpec({ ...spec, preflight: ["contacts.delete"] })).toThrow(/preflight/);
  expect(() => registry.freezeOperationSpec({ ...spec, endpoint: { ...spec.endpoint, retry: "write" } })).toThrow(/endpoint/);
  expect(() => registry.freezeOperationSpec({ ...spec, recheck: () => ({ ok: true }) })).toThrow(/recheck/);
});
