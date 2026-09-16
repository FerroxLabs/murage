import { expect, it, vi } from "vitest";
import { canRetryMemoryEvolution, memoryEvolutionCost, memoryEvolutionHistorySource, memoryEvolutionReason, runMemoryEvolutionAction, type MemoryEvolutionStatus } from "./memory-evolution-controls";
const status=(patch:Partial<MemoryEvolutionStatus>={}):MemoryEvolutionStatus=>({authorized:false,corpus:{id:"memory-recall-groups",version:"1",kind:"synthetic"},policy:{revision:"baseline"},job:null,...patch});
const job:NonNullable<MemoryEvolutionStatus["job"]>={id:"job",status:"deferred",reason:"MEMORY_EVOLUTION_INTERRUPTED",started:true,decision:null,publishedRevision:null,costKnown:false,actualCostUsd:null,heldout:null};
it("enable authorizes only the shipped check and never sends a corpus hash or privacy label",async()=>{
  const request=vi.fn().mockResolvedValue(status({authorized:true}));await runMemoryEvolutionAction(request,status(),{action:"evolution-authorize"});
  expect(request.mock.calls[0]![0]).toBe("/api/memory/action");expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({action:"evolution-authorize"});
});
it("only the exact authorized started deferred job can be retried",async()=>{
  const request=vi.fn().mockResolvedValue(status());
  for(const candidate of [status({job}),status({authorized:true,job:{...job,started:false}}),status({authorized:true,job:{...job,status:"blocked"}})]){
    expect(canRetryMemoryEvolution(candidate)).toBeFalsy();await expect(runMemoryEvolutionAction(request,candidate,{action:"evolution-retry",jobId:"job"})).rejects.toThrow("cannot be retried");
  }
  await runMemoryEvolutionAction(request,status({authorized:true,job}),{action:"evolution-retry",jobId:"job"});expect(request).toHaveBeenCalledTimes(1);
});
it("unknown cost stays unknown and a passed but unapplied result is not labelled applied",()=>{
  expect(memoryEvolutionCost(status({job:{...job,actualCostUsd:0}}))).toBe("Cost unavailable");
  expect(memoryEvolutionCost(status({job:{...job,costKnown:true,actualCostUsd:0.001}}))).toBe("$0.001");
  expect(memoryEvolutionReason(status({job:{...job,status:"complete",decision:"accepted"}}))).toContain("application has not been recorded");
});
it("policy restore uses the exact refreshed revision and supports the built-in baseline",async()=>{
  const request=vi.fn().mockResolvedValueOnce({current:{revision:"current"},revisions:[{revision:"current",origin:"evaluated",createdAt:1},{revision:"old",origin:"rollback",rollbackOf:"baseline",createdAt:0}]}).mockResolvedValueOnce(status()),refresh=vi.fn(async()=>{}),source=memoryEvolutionHistorySource(request,refresh);
  const history=await source.load();expect(history.currentRevision).toBe("current");expect(history.revisions.find(row=>row.revision==="old")?.rollbackOf).toBe("baseline");
  await source.restore(history,history.revisions.find(row=>row.revision==="baseline")!);
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({action:"evolution-rollback",expectedRevision:"current",targetRevision:"baseline"});expect(refresh).toHaveBeenCalledTimes(1);
});
it("classification authorization selects its separate shipped corpus action",async()=>{
  const request=vi.fn().mockResolvedValue(status({authorized:true}));await runMemoryEvolutionAction(request,status(),{action:"evolution-authorize-classification"});
  expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({action:"evolution-authorize-classification"});
});
