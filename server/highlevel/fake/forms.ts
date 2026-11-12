// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FakeHighLevelRoute } from "../fake-provider.ts";
const fixtures = [
  { operation: "forms.list", method: "GET", path: /^\/forms\/$/u, value: { forms: [{ id: "form_1", locationId: "location_1", name: "Intake" }], total: 1 } },
  { operation: "forms.surveys.list", method: "GET", path: /^\/surveys\/$/u, value: { surveys: [{ id: "survey_1", locationId: "location_1", name: "Feedback" }], total: 1 } },
  { operation: "forms.submissions", method: "GET", path: /^\/forms\/submissions$/u, value: { submissions: [{ id: "submission_1", contactId: "contact_1", formId: "form_1", others: { answer: "SENTINEL" } }], meta: { total: 1, currentPage: 1, nextPage: null } } },
  { operation: "forms.surveys.submissions", method: "GET", path: /^\/surveys\/submissions$/u, value: { submissions: [{ id: "submission_1", contactId: "contact_1", surveyId: "survey_1", others: { answer: "SENTINEL" } }], meta: { total: 1, currentPage: 1, nextPage: null } } },
] as const;
export const formsRoutes = fixtures.map((route) => ({ ...route, handle: () => structuredClone(route.value) })) satisfies readonly FakeHighLevelRoute[];
export default formsRoutes;
