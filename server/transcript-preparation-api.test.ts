// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
describe.skipIf(process.platform === "win32")("bounded transcript preparation through a fake-engine server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `
      const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
      const {transaction}=await import(${JSON.stringify(new URL("./database.ts", import.meta.url).href)});
      const {setMemoryMode}=await import(${JSON.stringify(new URL("./memory/repository.ts", import.meta.url).href)});
      const {writeFileSync}=await import('node:fs'); const {join}=await import('node:path');
      setMemoryMode('off');
      const store=new Store(()=>({instanceId:'verification',model:'claude-sonnet-5-5'}));
      const bot=store.createBot({name:'Transcript fixture',computer:'off',browser:false,composio:false},{seedMessages:false});
      transaction(()=>{for(let i=0;i<3000;i++)store.appendMessage(bot.threadId,{role:i%2?'bot':'user',kind:'text',text:'fixture line '+i});});
      writeFileSync(join(process.env.MURAGE_DATA_DIR,'transcript-fixture.json'),JSON.stringify({bot:bot.id,thread:bot.threadId}));
      const original=Store.prototype.activeTextLines;
      const evidence={windows:[],renderMax:0};
      const raw=new WeakMap();
      const saveEvidence=()=>writeFileSync(join(process.env.MURAGE_DATA_DIR,'transcript-slices.json'),JSON.stringify(evidence));
      Store.prototype.activeTextLines=function(thread,limit){
        const result=original.call(this,thread,limit);
        if(thread!==bot.threadId)return result;
        let pulse=false, sampled=false; setImmediate(()=>{pulse=true;});
        const rendered=new Set();let scheduled=false;
        for(const row of result.messages){
          const snapshot=raw.get(row)??{text:row.text,engine:row.engine};raw.set(row,snapshot);
          const engine=snapshot.engine;
          Object.defineProperty(row,'engine',{configurable:true,enumerable:true,get(){
            rendered.add(row.id);
            if(rendered.size>evidence.renderMax){evidence.renderMax=rendered.size;saveEvidence();}
            if(!scheduled){scheduled=true;setImmediate(()=>{rendered.clear();scheduled=false;});}
            return engine;
          }});
          const text=snapshot.text;Object.defineProperty(row,'text',{configurable:true,enumerable:true,get(){
          if(!sampled){sampled=true;evidence.windows.push({limit,pulse});saveEvidence();}
          return text;
        }});}
        return result;
      };
    ` });
  }, 60_000);
  afterAll(async () => {
    const evidenceDir = process.env.ELD_EVIDENCE_DIR;
    if (fixture && evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      for (const [source, name] of [[fixture.info.logPath, "fixture-server.log"], [fixture.fixtureDumpLogPath, "fixture-dumps.jsonl"],
        [join(fixture.info.dataDir, "transcript-slices.json"), "fixture-slices.json"]])
        if (existsSync(source!)) copyFileSync(source!, join(evidenceDir, name!));
    }
    await fixture?.close();
  });
  it("settles a long-thread turn, reports omitted history and runs I/O between reading and checking each window", async () => {
    const ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "transcript-fixture.json"), "utf8"));
    const url = fixture.info.url;
    const env = { MURAGE_DATA_DIR: fixture.info.dataDir };
    const send = await runControlMurage(["send", "--bot", ids.bot, "--text", "hello fixture", "--url", url], { env });
    expect(send).toBeTruthy();
    const settled = await runControlMurage(["wait", "--bot", ids.bot, "--timeout", "30", "--url", url], { env });
    console.log("transcript fixture wait", JSON.stringify(settled));
    expect(settled).toMatchObject({ status: "settled" });
    const transcript = await runControlMurage(["messages", "--bot", ids.bot, "--limit", "5", "--url", url], { env });
    console.log("transcript fixture messages", JSON.stringify(transcript));
    expect(JSON.stringify(transcript)).toContain("hello from fake claude");
    const slices = JSON.parse(readFileSync(join(fixture.info.dataDir, "transcript-slices.json"), "utf8")) as { windows: Array<{limit: number; pulse: boolean}>; renderMax: number };
    expect(slices.windows.map(s => s.limit)).toEqual([80, 160, 320, 640, 1280]);
    expect(slices.windows.every(s => s.limit <= 1280 && s.pulse)).toBe(true);
    expect(slices.renderMax).toBeGreaterThan(0);
    expect(slices.renderMax).toBeLessThanOrEqual(40);
    expect(existsSync(fixture.fixtureDumpLogPath)).toBe(true);
    expect(readFileSync(fixture.fixtureDumpLogPath, "utf8")).toContain("Earlier lines of this conversation are not shown");
    console.log("transcript fixture evidence", JSON.stringify({ info: fixture.info, slices }));
  }, 60_000);
});
