import { beforeEach, expect, it } from "vitest";
import { cliFluxBudget } from "./cli-flux-budget.ts";
import { isBudgetReached, resetUnavailable } from "../voice/voice-routes.ts";
const route = { key: "fixture-key", baseUrl: "https://fixture.invalid/v1" };
const endpoint = { ...route, via: "flux" as const, label: "Flux", model: "speech" };
beforeEach(resetUnavailable);
it.each([
  { data: { http_status: 402, body: { error: "key_budget_reached" } } },
  { error: { message: 'API Error: 402 {"error":{"code":"budget_exceeded"}}' } },
  { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } } },
  new Error('unexpected status 402: {"error":"key_budget_reached"}'),
])("preserves a CLI budget envelope and marks only its captured route", error => {
  expect(cliFluxBudget(error, route)).toMatchObject({ fluxBudget: true });
  expect(isBudgetReached(endpoint)).toBe(true);
  expect(isBudgetReached({ ...endpoint, key: "rotated" })).toBe(false);
});
it.each([null, route])("does not mark premium or owner refusals (%s)", selected => {
  expect(cliFluxBudget({ message: 'API Error: 402 {"error":"premium_locked"}' }, selected)).toBeUndefined();
  expect(cliFluxBudget({ message: 'API Error: 402 {"error":"key_budget_reached"}' }, null)).toBeUndefined();
  expect(isBudgetReached(endpoint)).toBe(false);
});
