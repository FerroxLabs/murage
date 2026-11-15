import {fixtureHelperPermits} from "./testing/helper-permits.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INTEL-SMOKE-WORKER-EXIT: Murage closing the channel while the helper is still reporting (idle maintenance, an index result)
// made a send fail with EPIPE, and the unhandled "error" event ended the helper with code 1 before it closed its index.
// A real helper process here: the channel really closes under it. Each acknowledgement below is a send into that closing channel.
import { fork } from "node:child_process";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

async function closeWhileReporting() {
  const permits=fixtureHelperPermits();
  const child = fork(resolve("server/memory/worker.ts"), [], { windowsHide: true, execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "pipe", "ipc"],env:permits.env });
  permits.attach(child);
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  const stderrClosed = new Promise<void>(done => child.stderr!.once("close", () => done()));
  await new Promise<void>((ready, failed) => {
    child.once("message", () => ready());
    child.once("exit", code => failed(new Error(`helper exited before ready: ${code}\n${stderr}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once("exit", (code, signal) => done({ code, signal })));
  for (let i = 0; i < 300; i++) child.send({ type: "checkpoint", requestId: `c${i}` });
  child.disconnect();
  const result = await exited;
  await stderrClosed;
  return { ...result, stderr };
}

it("a helper still reporting when the channel closes exits cleanly through its disconnect handler", async () => {
  for (let round = 0; round < 3; round++) expect(await closeWhileReporting()).toEqual({ code: 0, signal: null, stderr: "" });
}, 60_000);

it("the real helper captures leased text before index initialization while queued searches remain held", async () => {
  const permits=fixtureHelperPermits();
  const child=fork(resolve("server/memory/worker.ts"),[],{windowsHide:true,execArgv:["--experimental-strip-types","--no-warnings"],stdio:["ignore","ignore","pipe","ipc"],env:permits.env});
  permits.attach(child);
  const sent:Array<{type?:string;result?:{status:string;nextCursor:number;chunks:Array<{text:string}>}}>=[];
  child.on("message",message=>sent.push(message as typeof sent[number]));
  const exited=new Promise<number|null>(done=>child.once("exit",done));
  let stderr="";child.stderr!.on("data",data=>{stderr+=data;});
  try{
    await vi.waitFor(()=>expect(sent.some(message=>message.type==="ready")).toBe(true),{timeout:5000});
    child.send({type:"query",requestId:"held-query",input:{query:"fixture",scopeIds:["fixture-scope"],policyRevision:1,deletionEpoch:0,historical:false,cursor:"",limit:1,semantic:false}});
    const text="A captured fixture statement";
    child.send({id:"fixture-job",sourceId:"fixture-source",revision:1,leaseGeneration:1,policyRevision:1,deletionEpoch:0,scopeId:"fixture-scope",stage:"capture",kind:"message",speaker:"owner",outcome:"recorded",cursor:0,totalBytes:Buffer.byteLength(text),text});
    await vi.waitFor(()=>expect(sent.find(message=>message.type==="result")?.result).toMatchObject({status:"complete",nextCursor:Buffer.byteLength(text),chunks:[{text}]}),{timeout:3000});
    expect(sent.some(message=>["query-result","index-opening","initialised","error"].includes(message.type??""))).toBe(false);
    expect(stderr).toBe("");
  }finally{
    if(child.connected)child.disconnect();
    if(child.exitCode===null&&!child.signalCode){const timer=setTimeout(()=>child.kill("SIGKILL"),5000);try{await exited;}finally{clearTimeout(timer);}}
  }
},15000);
