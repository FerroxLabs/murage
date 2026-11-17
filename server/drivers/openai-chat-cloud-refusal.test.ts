// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INT1019-CLOUD-MERGE-PLAN R1.4 and the refusal rule: the Cloud home's classifier, 1.0.19's classifiers and busyloop's all stay, and a
// Cloud-worded refusal suppresses every desktop Flux path for that error.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("./openai-chat.ts", import.meta.url), "utf8");
const core = readFileSync(new URL("./acp/core.ts", import.meta.url), "utf8");

// b796fbc9f and 3110d04b5 added typed refusal sites before retries and inside streamed responses.
describe("R1.4 ProviderHttpError sites share the Cloud-first constructor", () => {
  it("passes response ownership and refusal data at every throw site, and classifies Cloud first", () => {
    const sites = [...chat.matchAll(/new ProviderHttpError\(([^;]+)\);/g)].map(match => match[1]);
    expect(sites).toHaveLength(4);
    for (const site of sites) {
      expect(site).toContain("response.status,");
      expect(site).toContain("label, {");
      expect(site).toContain("decision, headers: response.headers, fromRouter: isFluxUrl(endpoint), key: secret }");
      expect(site).toMatch(/flux: (?:true|fluxRouteFor\(endpoint\).routed)|\{ flux,/);
    }
    expect(chat).toContain("throw new ProviderHttpError(response.status, body, label, { flux, fluxCode, decision, headers: response.headers, fromRouter: isFluxUrl(endpoint), key: secret });");
    const ctor = chat.slice(chat.indexOf("constructor(status: number, rawBody: string, label: string, options"));
    expect(ctor.indexOf("classifyCloudFluxRefusal(")).toBeGreaterThan(-1);
    expect(ctor.indexOf("classifyCloudFluxRefusal(")).toBeLessThan(ctor.indexOf("providerHttpMessage(status)"));
  });
  it("both Flux classifiers are imported under different names", () => {
    expect(chat).toContain('import { classifyFluxRefusal } from "../../shared/flux-refusal.ts";');
    expect(chat).toContain("import { classifyFluxRefusal as classifyCloudFluxRefusal, reportFluxRefusal }");
  });
  it("a Cloud-owned answer never latches the desktop budget memo, and its error card and gateway fields are skipped", () => {
    const site = chat.slice(chat.indexOf("const cloudClaims = "));
    expect(site.indexOf("if (!cloudClaims && flux && secret && classifyFluxRefusal(response.status, rawBody) === \"budget\") markBudgetReached(")).toBeGreaterThan(-1);
    expect(chat).toContain("const classified = error instanceof FluxBudgetReached || cloudRefusal ? undefined : classifyProviderError(");
    expect(chat).toContain("...(isFluxUrl(endpointUrl) && !cloudRefusal ? fluxRefusalFields(");
  });
});

describe("the ACP path: a Cloud refusal suppresses the desktop budget memo and the gateway fields", () => {
  it("guards the memo, the card, the engine text, the gateway fields and the reset date with the same flag", () => {
    expect(core).toContain("const providerError = fluxRefusal ? undefined : classifyProviderError(e, flux);");
    expect(core).toContain("if (!fluxRefusal && providerError?.fluxBudget && budgetKey) markBudgetReached(");
    // 3110d04b5 groups all desktop fields beneath one Cloud-ownership guard.
    const guarded = core.slice(core.indexOf("...(fluxRefusal ? {} : {"));
    const fields = guarded.slice(0, guarded.indexOf("\n                }),"));
    expect(fields).toContain("...legacyFields,");
    expect(fields).toContain("...(decision ? { fluxDecision: decision } : {})");
    expect(fields).toContain("...(resetsAt !== undefined ? { gatewayResetsAt: resetsAt } : {})");
    expect(fields).toContain("...(acpEngineLimitResetsAt(rpc?.data) !== undefined ?");
  });
  it("the retry-notice ending asks the Cloud classifier on a home, before it emits a gateway card", () => {
    const finish = core.slice(core.indexOf("const finishFluxRefusal = () => {"));
    const cloud = finish.indexOf("cloudRetryNoticeRefusal(");
    const card = finish.indexOf("gatewayCode: state.fluxRefusal.code");
    expect(cloud).toBeGreaterThan(-1);
    expect(cloud).toBeLessThan(card);
    const helper = core.slice(core.indexOf("export function cloudRetryNoticeRefusal("));
    expect(helper.slice(0, 300)).toContain('process.env.MURAGE_CLOUD_ROLE !== "home"');
  });
});
