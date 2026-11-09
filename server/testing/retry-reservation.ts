// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { captureMemoryUsage, createInferenceSlot, withMemoryInferenceLease, reportMemoryUsage, type MemoryUsageReport, type TextOnlyExtractor } from "../memory/extract.ts";
import { openLearningGate } from "./open-learning-gate.ts";

/** A real Continuity reservation; independent slots also let adapter tests exercise concurrent capture. */
export async function withRetryReservation<T>(call:()=>Promise<T>):Promise<T> {
  let value:T|undefined, failure:unknown, called=false;
  const reports:MemoryUsageReport[]=[];
  const extractor:TextOnlyExtractor=async()=>{
    called=true;
    try { value=await captureMemoryUsage(u=>reports.push(u),call); }
    catch(error){failure=error;}
    finally { for(const report of reports)reportMemoryUsage(report); }
    return "[]";
  };
  await withMemoryInferenceLease(async lease=>{
    await lease.request(extractor,"fixture",3000,new AbortController().signal,[{role:"user",content:"fixture"}],"continuity",{botId:"fixture",family:"lived"},openLearningGate("continuity"));
  },undefined,createInferenceSlot());
  if(!called)throw new Error("Fixture reservation was refused");
  for(const report of reports)reportMemoryUsage(report);
  if(failure)throw failure;
  return value as T;
}
