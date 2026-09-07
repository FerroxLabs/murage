import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(),"murage-https-settings-"));
vi.mock("electron",()=>({app:{getPath:()=>dataDir},utilityProcess:{}}));
const {reconcileCompanionHttps,companionRemoteAccessAtRest,companionEnabledAtRest,configureCompanionStorage,rememberCompanionEnabled,stopCompanion} = await import("./companion.mjs");
const settings = join(dataDir,"companion-settings.json");
afterAll(()=>rmSync(dataDir,{recursive:true,force:true}));
beforeEach(()=>{ configureCompanionStorage(null); writeFileSync(settings,JSON.stringify({enabled:true,keepAwake:true,remoteAccess:false})); });

it("restored preferences start off and leave the old enabled profile unchanged", () => {
  const original = readFileSync(settings, "utf8");
  const directory = join(dataDir, "restored", "desktop");
  configureCompanionStorage({ settingsDirectory: directory, stateDirectory: join(dataDir, "restored", "devices") });
  expect(companionEnabledAtRest()).toBe(false);
  expect(companionRemoteAccessAtRest()).toBe(false);
  rememberCompanionEnabled(true);
  expect(companionEnabledAtRest()).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, "companion-settings.json"), "utf8")).enabled).toBe(true);
  expect(readFileSync(settings, "utf8")).toBe(original);
});

it("connection storage cannot change while a lifecycle transition is admitted", async () => {
  const stopped = stopCompanion();
  expect(() => configureCompanionStorage(null)).toThrow("Stop the companion");
  await stopped;
  expect(() => configureCompanionStorage(null)).not.toThrow();
});

it("adopts a conclusively owned proxy even when the remembered flag is off",()=>{
  const messages=[];
  reconcileCompanionHttps({on:true,host:"box.tail1234.ts.net",reason:null},message=>messages.push(message));
  expect(companionRemoteAccessAtRest()).toBe(true);
  expect(JSON.parse(readFileSync(settings,"utf8"))).toEqual({enabled:true,keepAwake:true,remoteAccess:true});
  expect(messages.join(" ")).toContain("remembered off state was stale");
});

it.each(["conflict","failed","missing"])("does not adopt unowned or unverifiable state (%s)",reason=>{
  const before=readFileSync(settings,"utf8");
  reconcileCompanionHttps({on:false,host:null,reason});
  expect(readFileSync(settings,"utf8")).toBe(before);
});

it("the real desktop startup observes Serve even when the remembered setting is off",async()=>{
  const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  const start=source.indexOf("async function startDesktopCompanion(");
  const body=source.slice(start,source.indexOf("/** Re-probe Tailscale",start));
  let observations=0;
  const run=new Function("companionRemoteAccessAtRest","refreshRemoteAccessObservation",`
    let companionDesiredThisLaunch=false,companionLaunchGeneration=0;
    const companionStarts=new Set(),assertDesktopStartupActive=()=>{};
    const companionLaunchOptions=()=>({}),startCompanion=async()=>({enabled:false});
    const desktopCompanionState=async()=>({enabled:false});
    ${body};return startDesktopCompanion();
  `);
  await run(()=>false,async()=>{observations++;});
  expect(observations).toBe(1);
});

it("public HTTPS status requires the actual listener to advertise the matching observed front",()=>{
  const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  const start=source.indexOf("function publicRemoteAccessState()");
  const end=source.indexOf("/** Look at what Tailscale",start);
  const state=new Function("companionRemoteAccessOrigin","remoteAccessObserved","companionRemoteAccessAtRest",
    `${source.slice(start,end)};return publicRemoteAccessState();`);
  const ours={on:true,host:"box.tail1234.ts.net",available:true};
  expect(state(()=>"https://box.tail1234.ts.net",ours,()=>true)).toMatchObject({on:true,url:"https://box.tail1234.ts.net"});
  expect(state(()=>null,ours,()=>true)).toMatchObject({on:false,url:null,reason:"listener"});
  expect(state(()=>"https://stale.tail1234.ts.net",ours,()=>true)).toMatchObject({on:false,url:null,reason:"listener"});
  expect(state(()=>"https://box.tail1234.ts.net",{...ours,on:false,reason:"conflict",message:"unowned routes"},()=>true))
    .toMatchObject({on:false,url:null,reason:"conflict",problem:"unowned routes"});
});
