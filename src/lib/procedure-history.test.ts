import { expect, it, vi } from "vitest";
import { createHistoryStore, routineHistory, routineHistorySource, skillHistorySource, versionOrigin, type ProcedureHistory } from "./procedure-history";
import type { Routine } from "./routines";
const history:ProcedureHistory={currentRevision:"current",current:{revision:"current",description:"Current method",createdAt:0,origin:"owner"},revisions:[{revision:"old",description:"Earlier method",createdAt:0,origin:"learned"}]};
it("keeps global and task-audience endpoints explicit and never falls back when the task is missing",async()=>{
  const request=vi.fn().mockResolvedValue(history),task=skillHistorySource(request,"bot","skill",{kind:"task",threadId:"thread"});
  await task.load();await task.restore(history,history.revisions[0]!);
  expect(request.mock.calls[0]![0]).toBe("/api/bots/bot/skills/skill/history?threadId=thread");
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({expectedRevision:"current",targetRevision:"old",threadId:"thread"});
  const missing=skillHistorySource(request,"bot","skill",{kind:"task",threadId:null});
  expect(()=>missing.load()).toThrow("Select a task");expect(request).toHaveBeenCalledTimes(2);
  await skillHistorySource(request,"bot","skill",{kind:"global"}).load();expect(request.mock.calls[2]![0]).toBe("/api/bots/bot/skills/skill/history");
});
it("409 requires an explicit refresh and the next restore uses the returned current revision",async()=>{
  let current=history;
  const source={load:vi.fn(async()=>current),restore:vi.fn().mockRejectedValueOnce(Object.assign(Error("stale"),{status:409})).mockResolvedValue(undefined)};
  const store=createHistoryStore(source);await store.load();await store.restore(history.revisions[0]!);
  expect(store.getSnapshot().conflict).toBe(true);await store.restore(history.revisions[0]!);expect(source.restore).toHaveBeenCalledTimes(1);
  current={...history,currentRevision:"owner-edited"};await store.load();await store.restore(history.revisions[0]!);
  expect(source.restore.mock.calls[1]![0].currentRevision).toBe("owner-edited");expect(store.getSnapshot().notice).toContain("restored");
});
it("a failed history request is unavailable rather than an empty successful history",async()=>{
  const store=createHistoryStore({load:async()=>{throw Error("Private audience unavailable");},restore:vi.fn()});
  await store.load();expect(store.getSnapshot()).toMatchObject({phase:"failed",history:null,error:"Private audience unavailable"});
});
it("routine history preserves recorded origin and sends both owner CAS fields without other edits",async()=>{
  const routine={id:"routine",updatedAt:23,instructionRevision:"current",instructionHistory:[{id:"old",prompt:"Old",author:"owner",createdAt:1},{id:"current",prompt:"New",author:"rollback",rollbackOf:"old",createdAt:2}]} as Routine;
  expect(routineHistory(routine).current).toMatchObject({origin:"rollback",rollbackOf:"old"});
  const request=vi.fn().mockResolvedValueOnce({routines:[routine]}).mockResolvedValueOnce({routine}),restored=vi.fn(),source=routineHistorySource(request,routine.id,restored);
  const loaded=await source.load();await source.restore(loaded,loaded.revisions[0]!);
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({expectedRevision:"current",expectedUpdatedAt:23,targetRevision:"old"});expect(restored).toHaveBeenCalledWith(routine);
  expect(versionOrigin(undefined)).toBe("Origin not recorded");expect(versionOrigin("evaluated")).toBe("Evaluated improvement");
});
