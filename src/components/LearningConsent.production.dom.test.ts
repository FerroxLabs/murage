// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer } from "../../scripts/control-murage.ts";

it("LEARNING-CONSENT production broadcast and SSE reach StoreProvider and a mounted memory surface once", async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const extractUrl = pathToFileURL(join(process.cwd(), "server/memory/extract.ts")).href;
  const gateUrl = pathToFileURL(join(process.cwd(), "server/testing/open-learning-gate.ts")).href;
  // Only the upstream provider is replaced. The server's listener registration,
  // broadcast, visibility filter, SSE writer and renderer subscription run as shipped.
  const fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 120_000, instrumentationSource: `
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {requestMemoryExtraction} from ${JSON.stringify(extractUrl)};
    import {openLearningGate} from ${JSON.stringify(gateUrl)};
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(url,init)=>String(url).startsWith('https://api.fluxrouter.ai/')
      ? Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'[]'}}]})))
      : originalFetch(url,init);
    const trigger=join(process.env.MURAGE_DATA_DIR,'learning-test-trigger');
    let sent=0,busy=false;
    setInterval(async()=>{
      if(busy||!existsSync(trigger))return;
      const requested=Number(readFileSync(trigger,'utf8'));if(requested<=sent)return;
      busy=true;
      try{await requestMemoryExtraction({url:'https://api.fluxrouter.ai/v1/chat/completions',apiKey:'fixture-key',model:'flux-fast'},'Owner prefers daily reports.',100,new AbortController().signal,undefined,openLearningGate());sent=requested;writeFileSync(trigger+'.done',String(sent));}
      finally{busy=false;}
    },10).unref();
  ` });
  const realFetch = globalThis.fetch;
  const sources: BrowserEventSource[] = [];
  const frames: Array<{kind: string}> = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  // Browser transport adapter only: pass real HTTP SSE data to native-shaped callbacks.
  class BrowserEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    controller = new AbortController();
    constructor(url: string) { sources.push(this); void this.read(url); }
    async read(url: string) {
      try {
        const response = await realFetch(new URL(url, fixture.info.url), {signal: this.controller.signal});
        expect(response.status).toBe(200);
        this.onopen?.();
        const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
        for (;;) {
          const chunk = await reader.read(); if(chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream:true});
          let end: number;
          while((end=buffer.indexOf("\n\n"))>=0) {
            const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
            for(const line of block.split("\n")) if(line.startsWith("data: ")) {
              const data=line.slice(6);frames.push(JSON.parse(data));this.onmessage?.({data});
            }
          }
        }
      } catch(error) { if(!this.controller.signal.aborted) { this.onerror?.(); throw error; } }
    }
    close() { this.controller.abort(); }
  }
  try {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => realFetch(typeof input === "string" ? new URL(input,fixture.info.url) : input,init));
    vi.stubGlobal("EventSource", BrowserEventSource);
    const { StoreProvider, useStore } = await import("../state/store");
    const { MemorySectionContent } = await import("./MemorySection");
    let hydrated = false;
    function Surface() {
      const {state} = useStore(); hydrated = state.hydrated === true;
      return createElement(MemorySectionContent, {
        status: {mode:"active",configuration:{extractorInstanceId:null},extractors:[]},
        bots:[],events:[],cursor:null,filter:"",busy:false,historyBusy:false,refusals:{},workspace:null,
        onAction:vi.fn(),onFilter:vi.fn(),onMore:vi.fn(),onOpen:vi.fn(),onRefresh:vi.fn(),
      });
    }
    const until = async (check: () => boolean) => {
      const deadline = Date.now()+15_000;
      while(!check()) { if(Date.now()>deadline) throw Error("Production delivery timed out"); await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));}); }
    };
    await act(async()=>root.render(createElement(StoreProvider,null,createElement(Surface))));
    await until(()=>hydrated && frames.some(frame=>frame.kind==="caught-up"));
    expect(host.querySelectorAll("[data-learning-notice]")).toHaveLength(0);
    writeFileSync(join(fixture.info.dataDir,"learning-test-trigger"),"1");
    await until(()=>frames.some(frame=>frame.kind==="learning.flux-sent"));
    await until(()=>host.querySelectorAll("[data-learning-notice]").length===1);
    expect(host.querySelector("[data-learning-notice]")?.textContent).toBe("Murage learns from your chats using Flux. You can change this in Settings.");
    writeFileSync(join(fixture.info.dataDir,"learning-test-trigger"),"2");
    await until(()=>frames.filter(frame=>frame.kind==="learning.flux-sent").length===2);
    await until(()=>host.querySelectorAll("[data-learning-notice]").length===0);
    expect(frames.filter(frame=>frame.kind==="learning.flux-sent")).toHaveLength(2);
  } finally {
    await act(async()=>root.unmount()); host.remove(); sources.forEach(source=>source.close());
    if(process.env.LEARNING_CONSENT_LOG) copyFileSync(fixture.info.logPath, process.env.LEARNING_CONSENT_LOG);
    await fixture.close(); vi.unstubAllGlobals();
  }
}, 180_000);
