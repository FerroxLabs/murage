import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeDriver } from "./claude.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";

let scratch="";
const instances:ProviderInstance[]=[];
// removeTempDir, not a bare rmSync: dispose() has signalled the fake CLIs but
// a just-killed child lets go of its cwd a beat later (on Windows an rmSync
// in that beat is EPERM on the directory itself).
afterEach(async()=>{for(const instance of instances.splice(0))await instance.dispose();vi.unstubAllEnvs();if(scratch)await removeTempDir(scratch);});

it("isolates native account catalog/auth/turn/review subprocesses and sessions",async()=>{
  scratch=mkdtempSync(join(tmpdir(),"murage-account-driver-"));
  vi.stubEnv("HOME",scratch);vi.stubEnv("USERPROFILE",scratch);vi.stubEnv("CLAUDE_CONFIG_DIR",join(scratch,"inherited"));vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN","synthetic-inherited");
  const fake=fileURLToPath(new URL("../testing/fake-claude-cli.ts",import.meta.url));
  const wrapper=join(scratch,"account-fixture.mjs");
  // auth status is the native protocol; every other operation uses the existing
  // stream-json fake. Dump only synthetic env keys, not the owner's environment.
  writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const root=process.env.CLAUDE_CONFIG_DIR;
if(process.argv.includes('auth')){writeFileSync(join(root,'auth-seen.json'),JSON.stringify({root,token:process.env.CLAUDE_CODE_OAUTH_TOKEN}));process.stdout.write(readFileSync(join(root,'auth-result.json'),'utf8'));}
else { for(const key of Object.keys(process.env))if(!['HOME','USERPROFILE','PATH','CLAUDE_CONFIG_DIR','CLAUDE_CODE_OAUTH_TOKEN','FAKE_CLAUDE_DUMP'].includes(key))delete process.env[key]; await import(${JSON.stringify(new URL(`file://${fake}`).href)}); }`);
  for(const [index,name] of ["work","personal"].entries()){
    const root=join(scratch,name);mkdirSync(root);
    writeFileSync(join(root,"settings.json"),JSON.stringify({customModels:[`account-${name}`]}));
    writeFileSync(join(root,"auth-result.json"),JSON.stringify({loggedIn:index===0}));
    instances.push(await ClaudeDriver.create({instanceId:name,displayName:name,enabled:true,config:{cli:`${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`,permissionMode:"acceptEdits",configDir:root},environment:{FAKE_CLAUDE_DUMP:join(root,"dump.json")}}));
  }
  for(const [index,instance] of instances.entries()){
    const name=index===0?"work":"personal",root=join(scratch,name),snapshot=await instance.snapshot();
    expect(snapshot.authenticated).toBe(index===0);
    expect(JSON.stringify(instance.models)).toContain(`account-${name}`);
    expect(JSON.stringify(instance.models)).not.toContain(`account-${index===0?"personal":"work"}`);
    expect(JSON.parse(readFileSync(join(root,"auth-seen.json"),"utf8"))).toEqual({root});
  }
  const recordings=instances.map(instance=>recordEvents(instance.adapter));
  await Promise.all(instances.map((instance,index)=>instance.adapter.sendTurn({threadId:`account-${index}`,text:"synthetic isolation turn"})));
  await Promise.all(recordings.map(recorder=>recorder.until(event=>event.type==="turn.completed")));
  const seen=instances.map((_,index)=>JSON.parse(readFileSync(join(scratch,index===0?"work":"personal","dump.json"),"utf8")));
  expect(seen[0].pid).not.toBe(seen[1].pid);
  for(const [index,instance] of instances.entries()){
    const root=join(scratch,index===0?"work":"personal");
    expect(seen[index].env.CLAUDE_CONFIG_DIR).toBe(root);expect(seen[index].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    await expect(instance.reviewPermission?.("synthetic review")).resolves.toBe("fake generated text");
    const review=JSON.parse(readFileSync(join(root,"dump.json"),"utf8"));expect(review.env.CLAUDE_CONFIG_DIR).toBe(root);expect(review.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  }
},20000);
