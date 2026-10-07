// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from "vitest";
import { DEFAULT_MEMORY_LEARNING_V1,upgradeMemoryLearning,downgradeMemoryLearning,memoryLearningPatchSchema,memoryLearningV1Schema } from "./learning-policy.ts";
it("migrates edited bytes to tokens and retires the old ceiling without disabling learning",()=>{
 const value=upgradeMemoryLearning({...DEFAULT_MEMORY_LEARNING_V1,inputLimit:350,outputLimit:70,dailyCostUsd:5},1);
 expect(value).toMatchObject({version:2,automaticFacts:true,dailyInputTokens:100,dailyOutputTokens:70,perCallOutputTokens:{grounding:64}});
 expect(value).not.toHaveProperty("dailyCostUsd");
 expect(downgradeMemoryLearning(value)).toMatchObject({inputLimit:400,outputLimit:70,dailyCostUsd:null});
 expect(memoryLearningPatchSchema.safeParse({dailyCostUsd:5}).success).toBe(false);
});
it("uses v2 daily defaults for an unedited installation",()=>expect(upgradeMemoryLearning(DEFAULT_MEMORY_LEARNING_V1,0)).toMatchObject({dailyInputTokens:400000,dailyOutputTokens:60000}));

import {beforeEach,afterEach,vi} from "vitest";
import {mkdirSync,rmSync} from "node:fs";
import {DATA_DIR} from "../config.ts";
import {database,closeDatabase} from "../database.ts";
import {readMemoryLearning,updateMemoryLearning} from "./learning-policy.ts";
import {extractCandidates,groundMemoryClaim,requestMemoryExtraction,reserveExtraction,type TextOnlyExtractor} from "./extract.ts";
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>vi.unstubAllGlobals());
const allowance=()=>JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
it("uses distinct daily and per-call caps, with 64 for grounding",async()=>{
 const db=database();updateMemoryLearning(db,{dailyOutputTokens:2064},0);
 const extractor:TextOnlyExtractor=async(_text,max)=>{expect(max).toBe(2000);return "[]";};
 extractor.ground=async(_input,max)=>{expect(max).toBe(64);return '{"supported":true}';};
 expect((await extractCandidates("tea",extractor,new AbortController().signal)).status).toBe("complete");
 expect((await groundMemoryClaim({text:"tea",quote:"tea",claimType:"owner-statement",speaker:"owner",outcome:"recorded"},extractor,new AbortController().signal)).supported).toBe(true);
 expect(allowance().output).toBe(2064);
 expect(reserveExtraction([{role:"user",content:"a"}]).reserved).toBe("budget-exhausted");
});
it.each([true,false])("settles usage only when reported (%s)",async reported=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:"[]"}}],...(reported?{usage:{prompt_tokens:10,completion_tokens:3}}:{})}))));
 const config={url:"https://fixture.invalid/v1",apiKey:"fake",model:"fake"};
 const extractor:TextOnlyExtractor=(text,max,signal,dispatch)=>requestMemoryExtraction(config,text,max,signal,dispatch?.messages);
 await extractCandidates("tea",extractor,new AbortController().signal);
 expect(allowance().output).toBe(reported?3:2000);
 if(reported)expect(allowance().input).toBe(10);else expect(allowance().input).toBeGreaterThan(10);
 expect(readMemoryLearning(database()).version).toBe(2);
});


it("keeps standalone v1 settings strict; database downgrades preserve switches in a binding",()=>{
 const v2=upgradeMemoryLearning(DEFAULT_MEMORY_LEARNING_V1,0);v2.botsPaused=["bot"];v2.learnFrom={chats:false,channels:false};
 const old=downgradeMemoryLearning(v2),again=upgradeMemoryLearning(old,1);
 expect(memoryLearningV1Schema.safeParse({...old,botsPaused:["bot"]}).success).toBe(false);
 expect(again.botsPaused).toEqual([]);expect(again.learnFrom).toEqual({chats:true,channels:true});expect(again.dailyInputTokens).toBe(Math.ceil(v2.dailyInputTokens*4/3.5));
});
