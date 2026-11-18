// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { f5BoundProjection, f5Id, f5ListProjection, f5Location, f5Object, f5ProjectionBudget, f5Query, f5Refs, f5Text, f5TooLarge } from "./automations.ts";

import type { ReadSpec, OperationSpec } from "./registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";

export const F5_FORMS_ENDPOINTS = Object.fromEntries(
  HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === "forms").map(row => [row.id, HIGHLEVEL_ENDPOINTS[row.id]!]),
);
const date = z.string().date();
const limit = z.number().int().min(1).max(50).optional();
const nonnegative = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function submissions(value: unknown, ref: "formId" | "surveyId") {
  const root = f5Object(value);
  const rows = Array.isArray(root.submissions) ? root.submissions : [];
  const scalar = f5ProjectionBudget();
  if (rows.length > 50) f5TooLarge();
  const projected = rows.map((row) => {
    const source = f5Object(row);
    const fields = Object.fromEntries(["id", "contactId", ref, "createdAt", "name", "email"].flatMap((key) => {
      const value = scalar(source[key]);
      return value === undefined ? [] : [[key, value]];
    }));
    // Answers are outside content, including custom field names. Drop provider
    // tracking and credential keys; keep other answers complete or refuse.
    const entries = Object.entries(f5Object(source.others));
    if (entries.length > 50) f5TooLarge();
    const others = Object.fromEntries(entries.flatMap(([key, value]) => {
      if (key.length > 128) f5TooLarge();
      if (/^(?:__proto__|prototype|constructor|eventData|authorization|token|access_?token|refresh_?token|secret|password|api_?key|cookie)$/iu.test(key)) return [];
      const name = scalar(key);
      if (typeof name !== "string" || !name) return [];
      if (Array.isArray(value) && value.length > 20) f5TooLarge();
      const answer = Array.isArray(value) ? value.map(scalar) : scalar(value);
      return answer === undefined ? [] : [[name, answer]];
    }));
    return { ...fields, others };
  });
  const meta = f5Object(root.meta);
  return f5BoundProjection({
    submissions: projected,
    meta: Object.fromEntries(["total", "currentPage", "nextPage", "prevPage"].flatMap((key) => {
      const value = meta[key] === null ? null : nonnegative(meta[key]);
      return value === undefined ? [] : [[key, value]];
    })),
  }, "submissions");
}

function operation(kind: "forms" | "surveys", submitted: boolean): ReadSpec {
  const id = kind === "forms" ? (submitted ? "forms.submissions" : "forms.list") : (submitted ? "forms.surveys.submissions" : "forms.surveys.list");
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === id)!;
  const ref = kind === "forms" ? "formId" : "surveyId";
  const validation = submitted
    ? z.object({ locationId: f5Id, [ref]: f5Id.optional(), q: f5Text(500).optional(), page: z.number().int().min(1).max(1000).optional(), limit, startAt: date.optional(), endAt: date.optional() }).strict().refine((a) => !a.startAt || !a.endAt || a.startAt <= a.endAt, "Choose a start date on or before the end date.")
    : z.object({ locationId: f5Id, skip: z.number().int().min(0).max(50_000).optional(), limit, type: f5Text(64).optional() }).strict();
  return {
    id, family: "forms", risk: "R", title: submitted ? (kind === "forms" ? "Read form responses" : "Read survey responses") : (kind === "forms" ? "List forms" : "List surveys"),
    row, endpoint: F5_FORMS_ENDPOINTS[id]!, args: row.argsSchema as z.ZodType<Record<string, unknown>>, preflight: row.preflight, nested: false, maxReads: 1,
    recordRefs: (a) => f5Refs(a, submitted ? ["locationId", ref] : ["locationId"]), fields: () => [], targets: () => 1,
    // Submission ids are not direct nested routes: the provider filters the
    // collection by this checked locationId, with an optional form/survey id.
    ownership: async (_pre, a, ctx) => f5Location(validation.parse(row.argsSchema.parse(a)), ctx.locationId),
    prepareRead: async (a, ctx) => {
      const parsed = validation.parse(row.argsSchema.parse(a));
      f5Location(parsed, ctx.locationId);
      return { path: row.path!, query: f5Query(parsed), resource: `location:${ctx.locationId}` };
    },
    // The host MUST pass this projection to highlevelCrmResult, just as it does
    // other CRM reads. No provider text becomes a receipt or Murage-authored row.
    project: (value) => submitted ? submissions(value, ref) : {
      ...f5ListProjection(value, kind, ["id", "name", "locationId"]),
      ...(nonnegative(f5Object(value).total) === undefined ? {} : { total: nonnegative(f5Object(value).total) }),
    },
  };
}
export const formsOperations: readonly OperationSpec[] = [
  operation("forms", false), operation("forms", true), operation("surveys", false), operation("surveys", true),
];
export default formsOperations;
