import { HeldRequest } from "../held-request.ts";
import type { ProposeDetail } from "../actions.ts";
import { HIGHLEVEL_OPERATION_MANIFEST, type MutationSpec } from "../operations/registry.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";
/** Isolated action fixture for the C2 lifecycle tests; no provider or credential. */
export function heldNoteDetail(locationId: string, body: string): ProposeDetail {
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === "contacts.notes.create")!;
  const spec: MutationSpec<any> = {
    id: row.id, family: row.family, risk: "C", row, title: "Add note", endpoint: HIGHLEVEL_ENDPOINTS[row.id]!,
    args: row.argsSchema, nested: true, preflight: row.preflight, ownership: async () => {},
    gate: "GC", send: false, precondition: "none", recordRefs: () => ["c1"], fields: () => ["body"], targets: () => 1,
    project: value => value,
    prepare: async () => ({ path: "/contacts/c1/notes", resource: "contacts:contact:c1", body: { kind: "json", value: { body } } }),
  };
  const held = HeldRequest.freeze(spec, { path: "/contacts/c1/notes", resource: "contacts:contact:c1", body: { kind: "json", value: { body } } }, { locationId });
  return { kind: "change", risk: "C", escalation: "none", basis: "owner_exact_review", held, recordRefs: ["c1"], fields: ["body"] };
}
