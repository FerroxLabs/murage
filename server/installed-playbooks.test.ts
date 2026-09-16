import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { sep } from "node:path";
import { parseBotPackage } from "./bot-package.ts";
import { starterProfileContents } from "./starter-profiles.ts";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { B08_CASES } from "../src/e2e/b08-template-behavior-fixture.ts";

import { installedPlaybookInstructions, selectInstalledPlaybooks } from "./installed-playbooks.ts";

const playbooks = [
  {
    key: "brief",
    name: "Decision Brief",
    summary: "Make a decision",
    triggers: ["decision brief", "should we respond"],
    instructions: "Separate facts from hypotheses.",
  },
  {
    key: "outreach",
    name: "Safe Outreach",
    summary: "Write a reply",
    triggers: ["draft reply"],
    instructions: "Never send automatically.",
  },
];

it("delivers corrected template roles on follow-ups and selects detailed guidance only for relevant requests", async () => {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
  try {
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).secret };
    const instance = (await api("GET", "/api/instances")).instances.find((row: any) => row.instanceId === "verification");
    const catalog = (await api("GET", "/api/team-library/catalog")).teams;
    for (const [slug, query] of [["researcher", "Update this comparison using these excerpts."], ["explainer", "I am new to percentages. Give me a practice question."], ["excel-creator", "Summarize these expenses and save a CSV."]]) {
      const profile = parseBotPackage(JSON.parse(readFileSync(new URL(`../bot-library/builtins/${slug}.json`, import.meta.url), "utf8"))).package;
      const bot = (await api("POST", "/api/bots", { name: `Delivery ${slug}`, modelSelection: { instanceId: "verification", model: instance.models.options[0].id } })).bot;
      await api("POST", `/api/bots/${bot.id}/assistant-profile`, { slug, rename: false, profileReviewHash: catalog.find((row: any) => row.slug === slug).profileReviewHash });
      const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Template delivery" })).task;
      await api("POST", `/api/bots/${bot.id}/tasks/${task.threadId}?messages=0`);
      for (const [text, selected] of [[query, true], ["Continue from my previous answer.", false]] as const) {
        const previous = JSON.stringify(dump());
        await api("POST", `/api/bots/${bot.id}/messages`, { threadId: task.threadId, text });
        await expect.poll(() => JSON.stringify(dump()) !== previous, { timeout: 10000 }).toBe(true);
        const wire = dump();
        expect(JSON.stringify(wire.prompt)).toContain(text);
        expect(wire.systemPrompt).toContain(profile.agents[0]!.description);
        expect(wire.systemPrompt.includes(profile.playbooks![0]!.instructions)).toBe(selected);
        await expect.poll(async () => Boolean((await api("GET", "/api/bots?messages=0")).bots.find((row: any) => row.id === bot.id).busy), { timeout: 10000 }).toBe(false);
      }
    }
  } finally { await fixture.close(); }
}, 60000);

describe("installed package playbooks", () => {
  it("selects only process guidance triggered by the current job", () => {
    expect(selectInstalledPlaybooks("Please make a competitor decision brief", playbooks).map((item) => item.key))
      .toEqual(["brief"]);
    expect(selectInstalledPlaybooks("Summarize this page", playbooks)).toEqual([]);
  });

  it("renders package guidance inside an explicit non-authority boundary", () => {
    const rendered = installedPlaybookInstructions("Draft reply", playbooks);
    expect(rendered).toContain("<installed_package_playbooks>");
    expect(rendered).toContain("Never send automatically.");
    expect(rendered).toContain("do not grant tools");
    expect(rendered).not.toContain("Separate facts from hypotheses.");
  });
});

const homePlan = () => starterProfileContents("starter-personal-home").manifest.definition.package.playbooks![0]!;
const personalCaseTurns = B08_CASES.filter(row=>row.template==="personal-assistant").flatMap(row=>row.turns.map((text,turnIndex)=>({caseId:row.id,turnIndex,text,selected:row.scenario!=="unrelated-request"})));
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
it("activates the personal playbook for ordinary day planning, not unrelated word fragments", () => {
  const book=homePlan();
  expect(personalCaseTurns).toHaveLength(8);
  for(const row of personalCaseTurns)expect(selectInstalledPlaybooks(row.text,[book]).map(item=>item.key),row.caseId+":"+row.turnIndex).toEqual(row.selected?["home-plan"]:[]);
  for(const text of ["Resume my plan from last week.","Continue the plan we discussed.","Continue yesterday’s plan.","Move my appointment to the afternoon.","Calendar access was denied."])expect(selectInstalledPlaybooks(text,[book]).map(row=>row.key),text).toEqual(["home-plan"]);
  for(const text of [...weekdays.map(day=>`Please plan ${day} around these commitments.`),"Help me plan my day.","Plan today from my notes.","Could you plan tomorrow?","Plan my week.","Organize these home tasks."])
    expect(selectInstalledPlaybooks(text,[book]).map(row=>row.key),text).toEqual(["home-plan"]);
  for(const text of ['Rewrite this more warmly: "Meeting moved to Friday."',"Explain what a planet is.","Explain a plan.","What does tentative mean?","Resume the novel.","Continue this sentence."])
    expect(installedPlaybookInstructions(text,[book]),text).toBe("");
});

it("delivers the imported personal playbook in real server dispatch and omits it for unrelated requests", async () => {
  const fixture=await launchVerificationServer({},undefined,{instrumentationSource:"process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';"});
  let headers:Record<string,string>={},complete=false;const observations:Record<string,unknown>[]=[];
  const api=async(method:string,path:string,body?:unknown)=>{
    const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const value=await response.json() as any;expect(response.ok,JSON.stringify(value)).toBe(true);return value;
  };
  const dump=()=>{try{return JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8")) as {prompt:unknown;systemPrompt:string|null};}catch{return null;}};
  const strings=(value:unknown):string=>typeof value==="string"?value:Array.isArray(value)?value.map(strings).join("\n"):value&&typeof value==="object"?Object.values(value).map(strings).join("\n"):"";
  try{
    const secret=(await api("GET","/api/desktop-secret")).secret;headers={"x-murage-surface":"desktop","x-murage-surface-secret":secret};
    const instance=(await api("GET","/api/instances")).instances.find((row:any)=>row.instanceId==="verification"),model=instance.models.options[0].id;
    const selection={agents:["home-planner"],skills:[],routines:[],instructions:[]};
    const preview=await api("POST","/api/starter-profiles",{profileId:"starter-personal-home",action:"preview",selection});
    const before=new Set((await api("GET","/api/bots?messages=0")).bots.map((bot:any)=>bot.id));
    await api("POST","/api/starter-profiles",{profileId:"starter-personal-home",action:"import",selection,archiveSha256:preview.archiveSha256,reviewHash:preview.reviewHash,modelSelection:{instanceId:"verification",model}});
    const imported=(await api("GET","/api/bots?messages=0")).bots.filter((bot:any)=>!before.has(bot.id));expect(imported).toHaveLength(1);const bot=imported[0],book=homePlan();
    const cases=[...personalCaseTurns,{caseId:"natural-day",turnIndex:0,text:"Please plan my day from these notes.",selected:true},{caseId:"natural-tomorrow",turnIndex:0,text:"Help me plan tomorrow around my appointments.",selected:true},{caseId:"unrelated-planet",turnIndex:0,text:"Explain what a planet is.",selected:false}];
    const threads=new Map<string,string>();
    for(const row of cases){
      const group=row.caseId==="personal-assistant/second-turn"?"personal-assistant/supplied-data":row.caseId;
      let threadId=threads.get(group);const reusedThread=Boolean(threadId);
      if(!threadId){threadId=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Playbook delivery"})).task.threadId;threads.set(group,threadId!);}
      const restarted=row.caseId==="personal-assistant/interruption-restart"&&row.turnIndex===1;
      if(restarted){await fixture.restart();headers={};const proof=(await api("GET","/api/desktop-secret")).secret;headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof};}
      const task={threadId};
      await api("POST",`/api/bots/${bot.id}/tasks/${task.threadId}?messages=0`);
      await api("POST",`/api/bots/${bot.id}/messages`,{threadId:task.threadId,text:row.text});
      await expect.poll(()=>strings(dump()?.prompt).includes(row.text),{timeout:10000}).toBe(true);
      const wire=dump()!,system=wire.systemPrompt??"",mounted=system.includes(book.instructions);
      observations.push({caseId:row.caseId,turnIndex:row.turnIndex,reusedThread,restarted,query:row.text,expectedMounted:row.selected,actualMounted:mounted,playbookSha256:createHash("sha256").update(book.instructions).digest("hex"),systemPromptSha256:createHash("sha256").update(system).digest("hex"),systemPrompt:system,threadId:task.threadId});
      expect(mounted,row.text).toBe(row.selected);
      if(row.selected)expect(system).toContain("<installed_package_playbooks>");else expect(system).not.toContain("<playbook name=\"Plan from my notes\">");
      await expect.poll(async()=>Boolean((await api("GET","/api/bots?messages=0")).bots.find((b:any)=>b.id===bot.id).busy),{timeout:10000}).toBe(false);
    }
    expect(observations.filter(row=>row.restarted)).toHaveLength(1);
    expect(observations.find(row=>row.restarted)?.reusedThread).toBe(true);
    complete=true;
  }finally{
    await fixture.close();
    if(process.env.MURAGE_B08_PLAYBOOK_EVIDENCE_FILE)writeFileSync(process.env.MURAGE_B08_PLAYBOOK_EVIDENCE_FILE,JSON.stringify({status:complete?"PASS":"FAILED",evidenceKind:"actual Murage starter import/pin/dispatch to existing fake Claude CLI; recovery uses same thread after server restart, initial fake turn completed normally; no native interruption/model behavior claim",observations,fixtureClosed:true,paidCalls:0},null,2)+"\n",{mode:0o600,flag:"wx"});
  }
},60000);

const guidePlan = () => parseBotPackage(JSON.parse(readFileSync(new URL("../bot-library/builtins/concierge.json",import.meta.url),"utf8"))).package.playbooks![0]!;
it("activates Guide guidance for setup, refresh, phone and restart language without generic fragments",()=>{
  const book=guidePlan();
  for(const text of ["How do I connect a model provider in Murage and know it is ready?","Walk me through connecting a model provider.","Refresh models reports401 Unauthorized.","The Models section is missing on my phone. Where do I add my API key?","Connection setup was interrupted. Did it save?","Help with Murage settings.","Explain Murage setup.","How do I restart Murage?","Can I use Murage on my phone?"])
    expect(selectInstalledPlaybooks(text,[book]).map(row=>row.key),text).toEqual(["concierge"]);
  for(const text of ["Draft a short thank-you note to my neighbour for watering my plants.","Explain a planet.","Restart the short story.","Help set up my kitchen."])
    expect(installedPlaybookInstructions(text,[book]),text).toBe("");
});

it("delivers imported Guide guidance and its pinned facts through actual server dispatch",async()=>{
  const fixture=await launchVerificationServer({},undefined,{instrumentationSource:"process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';"});
  let headers:Record<string,string>={},complete=false;const observations:Record<string,unknown>[]=[];
  const api=async(method:string,path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const value=await response.json() as any;expect(response.ok,JSON.stringify(value)).toBe(true);return value;};
  const dump=()=>{try{return JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8")) as {prompt:unknown;systemPrompt:string|null};}catch{return null;}};
  const strings=(value:unknown):string=>typeof value==="string"?value:Array.isArray(value)?value.map(strings).join("\n"):value&&typeof value==="object"?Object.values(value).map(strings).join("\n"):"";
  try{
    const secret=(await api("GET","/api/desktop-secret")).secret;headers={"x-murage-surface":"desktop","x-murage-surface-secret":secret};
    const instance=(await api("GET","/api/instances")).instances.find((row:any)=>row.instanceId==="verification"),model=instance.models.options[0].id;
    const entry=(await api("GET","/api/team-library/catalog")).teams.find((row:any)=>row.slug==="concierge");expect(entry.adaptable).toBe(true);
    const bot=(await api("POST","/api/bots",{name:"Guide delivery",modelSelection:{instanceId:"verification",model}})).bot;
    await api("POST",`/api/bots/${bot.id}/assistant-profile`,{slug:"concierge",rename:false,profileReviewHash:entry.profileReviewHash});
    const book=guidePlan(),skill=readFileSync(new URL("../skills-library/concierge/SKILL.md",import.meta.url),"utf8");
    const cases=[{text:"How do I connect a model provider in Murage and know it is ready?",selected:true},{text:'I saved it, but Refresh models reports: "Could not refresh models:401 Unauthorized". What now?',selected:true},{text:"The Models section is missing on my phone. Where do I add my API key?",selected:true},{text:"Walk me through connecting a model provider step by step.",selected:true},{text:"Connection setup was interrupted. Did it save?",selected:true},{text:"How do I restart Murage after updating?",selected:true},{text:"Draft a short thank-you note to my neighbour for watering my plants.",selected:false}];
    for(const row of cases){
      const task=(await api("POST",`/api/bots/${bot.id}/tasks`,{title:"Guide playbook delivery"})).task;
      await api("POST",`/api/bots/${bot.id}/tasks/${task.threadId}?messages=0`);
      await api("POST",`/api/bots/${bot.id}/messages`,{threadId:task.threadId,text:row.text});
      await expect.poll(()=>strings(dump()?.prompt).includes(row.text),{timeout:10000}).toBe(true);
      const system=dump()!.systemPrompt??"",mounted=system.includes(book.instructions),encoded=/^- concierge: .* Read (".*")\.$/m.exec(system)?.[1];
      expect(system,row.text).toContain(parseBotPackage(JSON.parse(readFileSync(new URL("../bot-library/builtins/concierge.json",import.meta.url),"utf8"))).package.agents[0]!.description);
      expect(encoded,"advertised exact pinned Guide skill").toBeTruthy();const skillPath=realpathSync.native(JSON.parse(encoded!));expect(skillPath.startsWith(realpathSync.native(fixture.info.dataDir)+sep)).toBe(true);
      const pinned=readFileSync(skillPath,"utf8");expect(pinned).toBe(skill);
      observations.push({query:row.text,expectedMounted:row.selected,actualMounted:mounted,playbookSha256:createHash("sha256").update(book.instructions).digest("hex"),systemPromptSha256:createHash("sha256").update(system).digest("hex"),systemPrompt:system,pinnedSkillPath:skillPath,pinnedSkillSha256:createHash("sha256").update(pinned).digest("hex"),factsSourceMatches:true,factsInline:system.includes("The Models section is desktop-only."),threadId:task.threadId});
      expect(mounted,row.text).toBe(row.selected);if(!row.selected)expect(system).not.toContain('<playbook name="Concierge">');
      await expect.poll(async()=>Boolean((await api("GET","/api/bots?messages=0")).bots.find((b:any)=>b.id===bot.id).busy),{timeout:10000}).toBe(false);
    }
    complete=true;
  }finally{
    await fixture.close();
    if(process.env.MURAGE_B08_GUIDE_EVIDENCE_FILE)writeFileSync(process.env.MURAGE_B08_GUIDE_EVIDENCE_FILE,JSON.stringify({status:complete?"PASS":"FAILED",evidenceKind:"actual Guide adapt-existing import/pin/serverdispatch to existing fakeCLI; pinnedfactfile verified, modelread not claimed",observations,fixtureClosed:true,paidCalls:0},null,2)+"\n",{mode:0o600,flag:"wx"});
  }
},60000);
