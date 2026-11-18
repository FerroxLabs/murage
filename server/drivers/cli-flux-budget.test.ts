import { beforeEach, expect, it } from "vitest";
import { cliFluxBudget } from "./cli-flux-budget.ts";
import { isBudgetReached, resetUnavailable } from "../voice/voice-routes.ts";
const route = { key: "fixture-key", baseUrl: "https://api.fluxrouter.ai/v1" };
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
  const refusal = cliFluxBudget({ message: 'API Error: 402 {"error":"premium_locked"}' }, selected);
  if (selected) expect(refusal).toMatchObject({ fluxDecision: { reason: "fluxStop", action: "STOP", wait: "-" } });
  else expect(refusal).toBeUndefined();
  expect(cliFluxBudget({ message: 'API Error: 402 {"error":"key_budget_reached"}' }, null)).toBeUndefined();
  expect(isBudgetReached(endpoint)).toBe(false);
});
it.each([
  { data:{http_status:429,body:{error:{state:'key_revoked',message:'Rate limit'}}} },
  { message:'Rate limit',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429,body:{error:{state:'key_revoked'}}}} },
])('carries structural terminal evidence out of nested CLI envelopes', error => {
  expect(cliFluxBudget(error,route)).toMatchObject({fluxDecision:{reason:'keyRevoked',action:'STOP',wait:'-'}});
});
it('keeps a nested CLI hold wait',()=>{
 expect(cliFluxBudget({data:{http_status:429,body:{error:{state:'concurrency',retry_after:2}}}},route)).toMatchObject({fluxDecision:{reason:'hold',action:'RETRY_ONCE',wait:2}});
});

it('typed CLI status takes precedence over a stale status in display text',()=>{
 const error=Object.assign(new Error('unexpected status 401'),{data:{http_status:429,body:{error:{state:'concurrency',retry_after:2}}}});
 expect(cliFluxBudget(error,route)).toMatchObject({httpStatus:429,fluxDecision:{reason:'hold',action:'RETRY_ONCE',wait:2}});
});
