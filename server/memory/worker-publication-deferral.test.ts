// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-c (capture publication). Consumer owner: recall-fix-c (worker recovery).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ioBudget } from "../io-budget.ts";
import { database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob } from "./jobs.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { captureAndPublish, freshDataDir } from "./testing/recall-fixture.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const fault = vi.hoisted(() => ({ held: false, failures: 0, checkpointHeld: false, checkpointAttempts: 0 }));
vi.mock("./consolidate.ts", async original => {
  const actual = await original<typeof import("./consolidate.ts")>();
  const { DatabaseBusyError } = await import("../database.ts");
  return { ...actual, refreshMemoryCheckpoint: (id: string) => {
    fault.checkpointAttempts++;
    if (fault.checkpointHeld) throw new DatabaseBusyError("fixture-checkpoint", 0);
    return actual.refreshMemoryCheckpoint(id);
  } };
});
vi.mock("./jobs.ts", async original => {
  const actual = await original<typeof import("./jobs.ts")>();
  const { BgDeferred } = await import("../bg-admission.ts");
  return { ...actual, publishMemoryWork: (...args: Parameters<typeof actual.publishMemoryWork>) => {
    if (fault.held && args[2].status === "complete") throw new BgDeferred(10);
    if (args[2].status !== "complete") fault.failures++;
    return actual.publishMemoryWork(...args);
  } };
});
let controller: MemoryWorkerController;
beforeEach(() => {
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setImmediate","clearImmediate","Date"]});
  vi.spyOn(performance,"now").mockImplementation(() => Date.now());
  freshDataDir(); fault.held = false; fault.failures = 0; fault.checkpointHeld = false; fault.checkpointAttempts = 0;
});
afterEach(async () => { fault.held = false; if(controller)(controller as unknown as {child:unknown}).child=null; await controller?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("a refused publication retains its lease and heartbeat, then publishes the same result without a failed attempt", async () => {
  storeAnchorMessage(database(), "thread", "owner-line", "The fixture gate is green.");
  captureSource(database(), {id:"fixture-source",threadId:"thread",messageId:"owner-line",kind:"text",speaker:"owner",outcome:"recorded",text:"The fixture gate is green."});
  controller = new MemoryWorkerController();
  const work = claimMemoryJob((controller as unknown as {owner:string}).owner)!;
  const before = database().prepare("SELECT status,attempts,lease_generation FROM memory_jobs WHERE id=?").get(work.id);
  const held = controller as unknown as {child: unknown; ready: boolean; work: typeof work | null; heartbeat: unknown; later(step:()=>void, delay?:number):void; onWorkerMessage(child:unknown,event:unknown):void};
  held.child = {kill(){}, on(){}, send(){}}; held.ready = true; held.work = work;
  vi.spyOn(ioBudget,"withSource").mockImplementation(<T,>(_source: string, operation: () => T): T => operation());
  vi.spyOn(ioBudget,"nextAdmissionMs").mockReturnValue(10);
  const pending: Array<() => void> = [];
  held.later = step => {pending.push(step);};
  fault.held = true;
  held.onWorkerMessage(held.child, {type:"result",result:captureWork(work)});
  expect(pending).toHaveLength(1);
  pending.shift()!();
  expect(fault.failures).toBe(0);
  expect(held.work).toBe(work);
  expect(held.heartbeat).toBeTruthy();
  expect(database().prepare("SELECT status,attempts,lease_generation FROM memory_jobs WHERE id=?").get(work.id)).toEqual(before);
  fault.held = false;
  expect(pending).toHaveLength(1);
  pending.shift()!();
  expect(held.work).toBeNull();
  expect(database().prepare("SELECT status,attempts FROM memory_jobs WHERE id=?").get(work.id)).toEqual({status:"complete",attempts:before!.attempts});
  expect(fault.failures).toBe(0);
});

it("a committed capture retries its refused checkpoint without publishing the capture twice", () => {
  storeAnchorMessage(database(), "thread", "checkpoint-line", "The fixture gate is green.");
  captureSource(database(), {id:"checkpoint-source",threadId:"thread",messageId:"checkpoint-line",kind:"text",speaker:"owner",outcome:"recorded",text:"The fixture gate is green."});
  controller = new MemoryWorkerController();
  const work = claimMemoryJob((controller as unknown as {owner:string}).owner)!;
  const held = controller as unknown as {child:unknown;ready:boolean;work:typeof work|null;later(step:()=>void,delay?:number):void;onWorkerMessage(child:unknown,event:unknown):void};
  held.child = {kill(){},on(){},send(){}}; held.ready = true; held.work = work;
  vi.spyOn(ioBudget,"withSource").mockImplementation(<T,>(_source:string,operation:()=>T):T=>operation());
  const pending:Array<()=>void>=[]; held.later=step=>{pending.push(step);};
  fault.checkpointHeld=true;
  held.onWorkerMessage(held.child,{type:"result",result:captureWork(work)});
  pending.shift()!();
  expect(held.work).toBeNull();
  expect(database().prepare("SELECT status,attempts FROM memory_jobs WHERE id=?").get(work.id)).toEqual({status:"complete",attempts:0});
  expect(database().prepare("SELECT count(*) AS n FROM memory_checkpoint_publications WHERE job_id=?").get(work.id)!.n).toBe(0);
  expect(pending).toHaveLength(1);
  fault.checkpointHeld=false; pending.shift()!();
  expect(fault.checkpointAttempts).toBe(2);
  expect(database().prepare("SELECT count(*) AS n FROM memory_checkpoint_publications WHERE job_id=?").get(work.id)!.n).toBe(1);
  expect(database().prepare("SELECT sequence FROM memory_checkpoint_heads").get()!.sequence).toBe(1);
  expect(fault.failures).toBe(0);
});

it("an acknowledged index batch keeps its helper while receipt admission waits beyond the helper deadline", () => {
  controller = new MemoryWorkerController();
  const state = controller as unknown as {child:unknown;ready:boolean;indexing:boolean;indexRequestId:string|null;indexDeadline:number;later(step:()=>void,delay?:number):void;onWorkerMessage(child:unknown,event:unknown):void;tick():void;killOwn(child:unknown):void};
  state.child = {kill(){},on(){},send(){}};state.ready=true;state.indexing=true;state.indexRequestId="fixture-index";state.indexDeadline=Date.now()+60_000;
  const pending:Array<()=>void>=[];state.later=step=>{pending.push(step);};
  vi.spyOn(ioBudget,"withSource").mockImplementation(<T,>(_source:string,operation:()=>T):T=>operation());
  const kill = vi.spyOn(state,"killOwn").mockImplementation(()=>{});
  state.onWorkerMessage(state.child,{type:"index-result",requestId:"fixture-index",records:[],embeddingStatus:"indexed"});
  expect(pending).toHaveLength(1);
  vi.setSystemTime(Date.now()+60_001);state.tick();
  expect(kill).not.toHaveBeenCalled();
  expect(state.indexing).toBe(true);
  pending.shift()!();
  expect(state.indexing).toBe(false);
});


it("startup capture is not stranded behind an index batch whose copy charges are held", () => {
  captureAndPublish("The earlier fixture reference is ready.");
  storeAnchorMessage(database(),"thread","next-owner-line","The next fixture reference is ready.");
  captureSource(database(),{id:"next-fixture-source",threadId:"thread",messageId:"next-owner-line",kind:"text",speaker:"owner",outcome:"recorded",text:"The next fixture reference is ready."});
  controller = new MemoryWorkerController();
  const state=controller as unknown as {child:unknown;ready:boolean;tick():void;indexing:boolean;nextEligibleWorkAt:number;work:NonNullable<ReturnType<typeof claimMemoryJob>>|null;later(step:()=>void):void;onWorkerMessage(child:unknown,event:unknown):void};
  const sent:unknown[]=[];state.child={kill(){},on(){},send(message:unknown){sent.push(message);}};state.ready=true;
  const pending:Array<()=>void>=[];state.later=step=>{pending.push(step);};
  vi.spyOn(ioBudget,"withSource").mockImplementation(<T,>(_source:string,operation:()=>T):T=>operation());
  state.tick();
  expect(state.work).toMatchObject({sourceId:"next-fixture-source"});
  expect(state.indexing).toBe(false);
  expect(sent).toContainEqual(expect.objectContaining({sourceId:"next-fixture-source"}));
  state.onWorkerMessage(state.child,{type:"result",result:captureWork(state.work!)});
  pending.shift()!();
  expect(state.work).toBeNull();
  vi.setSystemTime(Date.now()+60_001);state.nextEligibleWorkAt=0;state.tick();
  expect(state.indexing).toBe(true);
  expect(sent).toContainEqual(expect.objectContaining({type:"index"}));
});
