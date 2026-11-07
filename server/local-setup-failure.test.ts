import { describe, expect, it } from "vitest";
import { engineConfigInvalid, engineFolderUnavailable, engineUpdateRequired, ScopeUnavailableError } from "./drivers/scoped-cli-home.ts";
import { LocalSetupError, localSetupEngineOf, localSetupFailureOf } from "./local-setup-failure.ts";
import { ProjectFolderLeaseError } from "./project-folder-leases.ts";

describe("local setup failure source", () => {
  it("reads the source from a tagged setup error", () => {
    expect(localSetupFailureOf(new LocalSetupError("computer", "the Local VM is not ready"))).toBe("computer");
    expect(localSetupFailureOf(new LocalSetupError("browser", "agent-browser command timed out"))).toBe("browser");
  });

  it("treats a working-folder lease refusal as the working folder", () => {
    expect(localSetupFailureOf(new ProjectFolderLeaseError("conflict"))).toBe("working-folder");
  });

  it("claims nothing for an untagged failure, whatever its text says", () => {
    expect(localSetupFailureOf(new Error("CUA Driver is not ready for this computer"))).toBeUndefined();
    expect(localSetupFailureOf(Object.assign(new Error("x"), { localFailure: "computer" }))).toBeUndefined();
    expect(localSetupFailureOf("agent-browser command timed out")).toBeUndefined();
  });

  it("reads an engine folder failure from its structured code and engine, never from its English text", () => {
    expect(localSetupFailureOf(new ScopeUnavailableError("tidied up", true))).toBe("engine-folder-busy");
    expect(localSetupFailureOf(engineFolderUnavailable("Antigravity", new Error("EACCES")))).toBe("engine-folder-unavailable");
    expect(localSetupFailureOf(engineUpdateRequired("Codex", "0.100.0", [0, 2, 0]))).toBe("engine-update-required");
    expect(localSetupEngineOf(engineUpdateRequired("Codex", undefined, [0, 2, 0]))).toBe("Codex");
    expect(localSetupFailureOf(new ScopeUnavailableError("x", false, { code: "symlink-required", engine: "Grok" }))).toBe("engine-symlink-required");
    expect(localSetupFailureOf(new ScopeUnavailableError("x", false, { code: "login-link-lost", engine: "Codex" }))).toBe("engine-login-link-lost");
    expect(localSetupFailureOf(engineConfigInvalid("OpenCode"))).toBe("engine-config-invalid");
    expect(localSetupEngineOf(engineConfigInvalid("OpenCode"))).toBe("OpenCode");
    expect(localSetupFailureOf(new Error("This bot's engine could not be set up in its own folder"))).toBeUndefined();
    expect(localSetupEngineOf(new Error("x"))).toBeUndefined();
  });
});

import { PinnedProceduresError } from "./procedure-bundles.ts";
it("T15 pinned procedure errors use the existing instanceof local failure path",()=>{
 expect(localSetupFailureOf(new PinnedProceduresError())).toBe("pinned-procedures");
 expect(localSetupFailureOf(new Error("PROCEDURE_AUDIENCE_REVOKED"))).toBeUndefined();
});

import { launchVerificationServer } from "../scripts/control-murage.ts";
it("T13 two native turns each append one skill-link-foreign activity through the existing index catch",async()=>{
  // Only the isolated launcher's child sees these fixture links. The production catch is not patched.
  const instrumentationSource=String.raw`
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({load(url,context,next){
 if(!url.endsWith('/procedure-bundles.ts'))return next(url,context);
 let source=readFileSync(new URL(url),'utf8');
 source='import { installSkill as fixtureInstall, setSkillEnabled as fixtureEnable } from "./skills.ts";\nimport * as fixtureFs from "node:fs";\n'+source;
 const pin='  const offered=skillsForAudience(catalogue,audience.ownerTurn,audience.shipped);';
 if(!source.includes(pin))throw new Error('T13 pin fixture anchor moved');
 source=source.replace(pin, '  fixtureInstall(botId,"fixture",[{path:"SKILL.md",content:["---","name: relink-fixture","description: Verify a fixture","---","Check the fixture."].join(String.fromCharCode(10))}]); fixtureEnable(botId,"relink-fixture",true);\n'+pin);
 const anchor='  const unlinked:string[]=[];';
 if(!source.includes(anchor))throw new Error('T13 prepare fixture anchor moved');
 source=source.replace(anchor,'  if(native){const p=join(desk,".claude","skills");fixtureFs.mkdirSync(p,{recursive:true});const link=join(p,"relink-fixture");try{fixtureFs.unlinkSync(link);}catch{}fixtureFs.symlinkSync(join(root,"skills","relink-fixture")+"/../../../../evil",link,"dir");}\n'+anchor);
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
  const fixture=await launchVerificationServer({},undefined,{instrumentationSource});
  try{
    let headers:Record<string,string>={};
    const api=async(method:string,path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});expect(response.ok).toBe(true);return await response.json() as any;};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};
    const model=(await api("GET","/api/instances")).instances.find((i:any)=>i.instanceId==="verification").models.options[0].id;
    const bot=(await api("POST","/api/bots",{name:"Relink catch fixture",modelSelection:{instanceId:"verification",model}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",composio:false,browser:false});
    const errors=async()=>((await api("GET",`/api/threads/${bot.threadId}/messages?limit=200`)).messages as any[]).filter(m=>m.kind==="activity"&&String(m.tool?.name).startsWith("error:"));
    for(let turn=1;turn<=2;turn++){
      await api("POST",`/api/bots/${bot.id}/messages`,{text:`Check ${turn}`,threadId:bot.threadId});
      await expect.poll(async()=> (await errors()).length,{timeout:20_000}).toBe(turn);
      expect((await errors()).map(m=>m.tool?.localFailure)).toEqual(Array(turn).fill("skill-link-foreign"));
      await expect.poll(async()=> (await api("GET","/api/bots?messages=0")).bots.find((b:any)=>b.id===bot.id).tasks.find((t:any)=>t.threadId===bot.threadId)?.busy,{timeout:20_000}).toBe(false);
    }
  }finally{await fixture.close();}
},45_000);
