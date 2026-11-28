// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";

// Explicit fixture entry only. The application never imports this module.
import { compilePromptLayers, classifyPromptLayer } from "../server/prompt-cache-plan.ts";
import { requestUsage, coverage, tokenCount, type CacheUsage } from "../shared/prompt-cache-usage.ts";

type FixtureLayer = { id: string; text: string };
type Scenario = "cold" | "warm" | "configuration-edit" | "audience-change";
type QualificationUsage = CacheUsage & { reporting?: "missing" | "malformed" | "failed-without-usage" };
/** Each transport call observes one actual provider request; the caller owns its isolated transport and approved budget. No connection lookup or network is implicit. */
export async function qualifyPromptCache(
  transport: (request: { scenario: Scenario; position: number; system: string }) => Promise<QualificationUsage>,
  layers: readonly FixtureLayer[],
) {
  const prefix = (current: readonly FixtureLayer[]) => compilePromptLayers(current).prefix.map(l => l.text).join("");
  const baseline = prefix(layers);
  const edited = [...layers, { id: "memory", text: "\nNeutral fixture configuration edit." }];
  // This is a synthetic audience control, never an authorization verdict for live material.
  const withheld = layers.filter(l => classifyPromptLayer(l.id).privacy === "product");
  const report = { samples: 0, knownSamples: 0, missingInputSamples: 0, missingCacheSamples: 0, missingUsageSamples: 0, malformedUsageSamples: 0, failedWithoutUsageSamples: 0, reportedInput: 0, knownInput: 0, cachedRead: 0, requestSamples: 0, requestHits: 0, prefixStable: true, configurationChanged: prefix(edited) !== baseline, audienceChanged: prefix(withheld) !== baseline };
  for (let position = 0; position < 8; position++) {
    const scenario: Scenario = position === 0 ? "cold" : position < 6 ? "warm" : position === 6 ? "configuration-edit" : "audience-change";
    const current = position < 6 ? layers : position === 6 ? edited : withheld;
    const plan = compilePromptLayers(current);
    if (position < 6) report.prefixStable &&= plan.prefix.map(l => l.text).join("") === baseline;
    const usage = await transport({ scenario, position, system: plan.layers.map(l => l.text).join("") });
    report.samples++;
    let c = coverage(usage);
    const reporting = usage.reporting;
    // Canonical usage has lost raw failure/parse detail; only the fixture transport classifies these outcomes.
    if (reporting !== undefined) {
      if (reporting === "missing") report.missingUsageSamples++;
      else if (reporting === "failed-without-usage") report.failedWithoutUsageSamples++;
      else report.malformedUsageSamples++;
      c = { version: 1, inputComplete: false, cacheComplete: false };
    } else if (!c.inputComplete) report.missingUsageSamples++;
    if (reporting === undefined && tokenCount(usage.input)) report.reportedInput += usage.input;
    if (!c.inputComplete) report.missingInputSamples++;
    else if (!c.cacheComplete) report.missingCacheSamples++;
    else {
      report.knownSamples++;
      if (usage.input > 0) {
        report.requestSamples++; report.knownInput += usage.input; report.cachedRead += usage.cachedInput ?? 0;
        report.requestHits += Number((usage.cachedInput ?? 0) > 0);
      }
    }
  }
  const totalsValid = tokenCount(report.knownInput) && tokenCount(report.cachedRead) && report.cachedRead <= report.knownInput;
  return { ...report,
    reportedInput: tokenCount(report.reportedInput) ? report.reportedInput : null,
    knownInput: totalsValid ? report.knownInput : null, cachedRead: totalsValid ? report.cachedRead : null,
    tokenShare: totalsValid && report.knownInput > 0 ? report.cachedRead / report.knownInput : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await qualifyPromptCache(async ({ scenario }) => requestUsage(100, 1, scenario === "warm" ? 80 : 0), [
    { id: "house-rules", text: "Neutral fixture rules.\n" }, { id: "memory", text: "Neutral fixture notes.\n" },
    { id: "capabilities", text: "Neutral current-turn capabilities." },
  ]);
  console.log(JSON.stringify({ synthetic: true, ...report }));
}
