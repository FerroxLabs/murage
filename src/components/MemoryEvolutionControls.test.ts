import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MemoryEvolutionControls } from "./MemoryEvolutionControls";
import type { MemoryEvolutionStatus } from "@/lib/memory-evolution-controls";
const initial:MemoryEvolutionStatus={authorized:false,corpus:{id:"memory-recall-groups",version:"1",kind:"synthetic"},policy:{revision:"baseline"},job:null};
it("labels the shipped synthetic recall scope without offering model or private-data selection",()=>{
  const html=renderToStaticMarkup(createElement(MemoryEvolutionControls,{status:initial,onRefresh:vi.fn()}));
  expect(html).toContain('aria-label="Tested recall improvements"');expect(html).toContain("Enable tested recall improvements");expect(html).toContain("These checks cover recall selection");expect(html).not.toContain("memory-recall-groups");expect(html).not.toContain("API key");
});
it("started failures expose an explicit retry and unknown cost without an automatic success claim",()=>{
  const html=renderToStaticMarkup(createElement(MemoryEvolutionControls,{status:{...initial,authorized:true,job:{id:"job",status:"deferred",reason:"MEMORY_EVOLUTION_INTERRUPTED",started:true,decision:null,publishedRevision:null,costKnown:false,actualCostUsd:null,heldout:null}},onRefresh:vi.fn()}));
  expect(html).toContain("Retry interrupted check");expect(html).toContain("Cost unavailable");expect(html).not.toContain("$0.00");expect(html).not.toContain("improved recall policy was applied");
});
it("last held-out scores are labelled synthetic and unknown accounting is not displayed as zero",()=>{
  const html=renderToStaticMarkup(createElement(MemoryEvolutionControls,{status:{...initial,authorized:true,job:{id:"job",status:"complete",reason:"accepted",started:true,decision:"accepted",publishedRevision:"evaluated-one",costKnown:false,actualCostUsd:null,heldout:{corpusDigest:"a".repeat(64),untouched:true,cases:4,baseline:0.5,candidate:0.75,regressions:0}}},onRefresh:vi.fn()}));
  expect(html).toContain("Last held-out result");expect(html).toContain("0.500");expect(html).toContain("0.750");expect(html).toContain("Scores describe the synthetic examples");expect(html).toContain("Cost unavailable");expect(html).not.toContain("$0.00");
});
it("classification has separate authorization and does not label its result as recall",()=>{
  const html=renderToStaticMarkup(createElement(MemoryEvolutionControls,{kind:"classification",status:{...initial,corpus:{...initial.corpus,id:"memory-classification-groups"}},onRefresh:vi.fn()}));
  expect(html).toContain("Tested classification improvements");expect(html).toContain("Enable tested classification improvements");expect(html).toContain("classification of synthetic source statements");expect(html).not.toContain("Enable tested recall improvements");
});
