import { INTEGRATED_SCOPE_VECTORS } from './scope-policy.integrated-vectors.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Handwritten expected plans. Never derive expected output from the descriptor or manifest.
export type ScopeVector = { operation: string; args: Record<string, unknown>; scopes: string[]; reads: [string, string, number][]; preparation: number };
const cr = ["contacts.readonly"], cw = ["contacts.readonly", "contacts.write"], or = ["opportunities.readonly"], ow = ["opportunities.readonly", "opportunities.write"];
const p = (operation: string, count = 1): [string, string, number] => [operation, "prepare", count];
const r = (operation: string, count = 1): [string, string, number] => [operation, "recovery", count];
const v = (operation: string, args: Record<string, unknown>, scopes: string[], reads: [string, string, number][], preparation: number): ScopeVector => ({ operation, args, scopes, reads, preparation });
export const IMPLEMENTED_SCOPE_VECTORS: readonly ScopeVector[] = [
  ...INTEGRATED_SCOPE_VECTORS,
  v("contacts.search", {}, cr, [], 0),
  v("contacts.get", { contactId: "c1" }, cr, [], 0),
  v("contacts.create", { email: "fixture@example.test" }, cw, [p("contacts.search", 2), r("contacts.get")], 2),
  v("contacts.update", { contactId: "c1", firstName: "Ada" }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("contacts.upsert", { email: "fixture@example.test" }, cw, [p("contacts.search", 2), r("contacts.get")], 2),
  v("contacts.delete", { contactId: "c1" }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("contacts.tags.add", { contactId: "c1", tags: ["X"] }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("contacts.tags.remove", { contactId: "c1", tags: ["X"] }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("contacts.tags.bulk", { contacts: ["c1"], type: "add", tags: ["X"] }, cw, [p("contacts.search"), r("contacts.get")], 1),
  v("contacts.notes.list", { contactId: "c1" }, cr, [p("contacts.get")], 1),
  v("contacts.notes.get", { contactId: "c1", noteId: "n1" }, cr, [p("contacts.get")], 1),
  v("contacts.notes.create", { contactId: "c1", body: "Fixture note" }, cw, [p("contacts.get"), p("contacts.notes.list"), r("contacts.notes.list")], 2),
  v("contacts.notes.update", { contactId: "c1", noteId: "n1", body: "Fixture note" }, cw, [p("contacts.get"), p("contacts.notes.get"), r("contacts.notes.get")], 2),
  v("contacts.notes.delete", { contactId: "c1", noteId: "n1" }, cw, [p("contacts.get"), p("contacts.notes.get"), r("contacts.notes.get")], 2),
  v("contacts.tasks.list", { contactId: "c1" }, cr, [p("contacts.get")], 1),
  v("contacts.tasks.get", { contactId: "c1", taskId: "t1" }, cr, [p("contacts.get")], 1),
  v("contacts.tasks.create", { contactId: "c1", title: "Fixture task", dueDate: "2026-11-11T12:00:00Z" }, cw, [p("contacts.get"), p("contacts.tasks.list"), r("contacts.tasks.list")], 2),
  v("contacts.tasks.update", { contactId: "c1", taskId: "t1", title: "Fixture task" }, cw, [p("contacts.get"), p("contacts.tasks.get"), r("contacts.tasks.get")], 2),
  v("contacts.tasks.complete", { contactId: "c1", taskId: "t1", completed: true }, cw, [p("contacts.get"), p("contacts.tasks.get"), r("contacts.tasks.get")], 2),
  v("contacts.tasks.delete", { contactId: "c1", taskId: "t1" }, cw, [p("contacts.get"), p("contacts.tasks.get"), r("contacts.tasks.get")], 2),
  v("contacts.appointments.list", { contactId: "c1" }, cr, [p("contacts.get")], 1),
  v("contacts.followers.add", { contactId: "c1", followers: ["u1"] }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("contacts.followers.remove", { contactId: "c1", followers: ["u1"] }, cw, [p("contacts.get"), r("contacts.get")], 1),
  v("opportunities.pipelines.list", {}, or, [], 0),
  v("opportunities.search", {}, or, [], 0),
  v("opportunities.get", { opportunityId: "o1" }, or, [p("opportunities.pipelines.list")], 1),
  v("opportunities.create", { pipelineId: "p1", contactId: "c1", name: "Fixture deal" }, ["contacts.readonly", ...ow], [p("opportunities.pipelines.list"), p("contacts.get"), r("opportunities.search", 2)], 2),
  v("opportunities.update", { opportunityId: "o1", name: "Fixture deal" }, ow, [p("opportunities.get"), p("opportunities.pipelines.list"), r("opportunities.get")], 2),
  v("opportunities.status", { opportunityId: "o1", status: "won" }, ow, [p("opportunities.get"), p("opportunities.pipelines.list"), r("opportunities.get")], 2),
  v("opportunities.upsert", { pipelineId: "p1", name: "Fixture deal" }, ow, [p("opportunities.pipelines.list"), r("opportunities.search", 2)], 1),
  v("opportunities.delete", { opportunityId: "o1" }, ow, [p("opportunities.get"), p("opportunities.pipelines.list"), r("opportunities.get")], 2),
  v("opportunities.followers.add", { opportunityId: "o1", followers: ["u1"] }, [...ow, "users.readonly"], [p("opportunities.get"), p("opportunities.pipelines.list"), p("users.get"), r("opportunities.get")], 3),
  v("opportunities.followers.remove", { opportunityId: "o1", followers: ["u1"] }, [...ow, "users.readonly"], [p("opportunities.get"), p("opportunities.pipelines.list"), p("users.get"), r("opportunities.get")], 3),
  v("opportunities.pipelines.create", { name: "Fixture pipeline", stages: [{ name: "First", position: 0 }] }, ["opportunities.readonly", "pipelines.create"], [p("opportunities.pipelines.list"), r("opportunities.pipelines.list")], 1),
  v("opportunities.pipelines.update", { pipelineId: "p1", name: "Fixture pipeline" }, ["opportunities.readonly", "pipelines.write"], [p("opportunities.pipelines.list"), r("opportunities.pipelines.list")], 1),
  v("opportunities.pipelines.delete", { pipelineId: "p1" }, ["opportunities.readonly", "pipelines.write"], [p("opportunities.pipelines.list"), r("opportunities.pipelines.list")], 1),
];
