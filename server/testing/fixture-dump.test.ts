// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
it.each(["fake-claude-cli.ts", "fake-codex-app-server.ts", "fake-agy-cli.ts", "../drivers/acp/fuigo.test.ts"])("%s never dumps the inherited environment", file => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  expect(/env:\s*process\.env/.test(source)).toBe(false);
});

import { fixtureDumpEnvironment, fixtureCredentialFingerprint } from "./fixture-dump.ts";
afterEach(()=>vi.unstubAllEnvs());
it("excludes unlisted fields and fingerprints asserted credentials",()=>{
 vi.stubEnv("PF_UNLISTED_SECRET","fixture-canary");
 vi.stubEnv("ANTHROPIC_AUTH_TOKEN","synthetic-provider-secret");
 const dump=fixtureDumpEnvironment();
 expect(Object.hasOwn(dump,"PF_UNLISTED_SECRET")).toBe(false);
 expect(dump.ANTHROPIC_AUTH_TOKEN===fixtureCredentialFingerprint("synthetic-provider-secret")).toBe(true);
 expect(Object.values(dump).some(value=>value==="synthetic-provider-secret" || value==="fixture-canary")).toBe(false);
});
it("the ACP fake fingerprints credentials and keeps unlisted fields out of its dump",()=>{
 const dir=mkdtempSync(join(tmpdir(),"murage-acp-dump-")),dump=join(dir,"dump.json");
 try{
  execFileSync(process.execPath,[new URL("./fake-acp-cli.ts",import.meta.url).pathname,"--version"],{encoding:"utf8",timeout:5_000,
   env:{PATH:process.env.PATH,HOME:dir,FAKE_ACP_DUMP:dump,OPENAI_API_KEY:"synthetic-openai-secret",MY_AGENT_TOKEN:"synthetic-agent-secret",PF_UNLISTED_SECRET:"fixture-canary"}});
  const text=readFileSync(dump,"utf8"),env=JSON.parse(text).env;
  expect(text.includes("synthetic-openai-secret")||text.includes("synthetic-agent-secret")||text.includes("fixture-canary")).toBe(false);
  expect(env.OPENAI_API_KEY===fixtureCredentialFingerprint("synthetic-openai-secret")).toBe(true);
  expect(env.MY_AGENT_TOKEN===fixtureCredentialFingerprint("synthetic-agent-secret")).toBe(true);
  expect(env.HOME).toBe(dir);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("the ACP fake fingerprints credential-named MCP env in its dump, its mcp file and its RPC log",()=>{
 const dir=mkdtempSync(join(tmpdir(),"murage-acp-mcp-dump-")),dump=join(dir,"dump.json"),log=join(dir,"rpc.jsonl");
 const servers=(token:string)=>[{name:"agents",command:"agents-proxy",args:[],env:[{name:"MURAGE_HARNESS_URL",value:"http://127.0.0.1:1"},{name:"MURAGE_COMMS_TOKEN",value:token}]},
  {name:"notes",command:"notes-mcp",args:[],env:[{name:"NOTES_API_KEY",value:"synthetic-notes-secret"}]}];
 const input=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:dir,mcpServers:servers("synthetic-comms-one")}},
  {jsonrpc:"2.0",id:3,method:"session/load",params:{sessionId:"fake-acp-session",cwd:dir,mcpServers:servers("synthetic-comms-two")}}].map(line=>JSON.stringify(line)).join("\n")+"\n";
 try{
  spawnSync(process.execPath,[new URL("./fake-acp-cli.ts",import.meta.url).pathname],{input,encoding:"utf8",timeout:5_000,
   env:{PATH:process.env.PATH,HOME:dir,FAKE_ACP_DUMP:dump,FAKE_ACP_RPC_LOG:log}});
  const texts=[readFileSync(dump,"utf8"),readFileSync(`${dump}.mcp.json`,"utf8"),readFileSync(log,"utf8")];
  for(const text of texts)expect(["synthetic-comms-one","synthetic-comms-two","synthetic-notes-secret"].some(secret=>text.includes(secret))).toBe(false);
  const env=(list:any[],name:string)=>Object.fromEntries(list.find(server=>server.name===name).env.map((row:any)=>[row.name,row.value]));
  const dumped=JSON.parse(texts[0]).mcpServers;
  expect(env(dumped,"agents").MURAGE_COMMS_TOKEN===fixtureCredentialFingerprint("synthetic-comms-one")).toBe(true);
  expect(env(dumped,"agents").MURAGE_HARNESS_URL).toBe("http://127.0.0.1:1");
  expect(env(dumped,"notes").NOTES_API_KEY===fixtureCredentialFingerprint("synthetic-notes-secret")).toBe(true);
  expect(env(JSON.parse(texts[1]),"agents").MURAGE_COMMS_TOKEN===fixtureCredentialFingerprint("synthetic-comms-two")).toBe(true);
  const load=texts[2].split("\n").filter(Boolean).map(line=>JSON.parse(line)).find(entry=>entry.method==="session/load");
  expect(load.agentsToken===fixtureCredentialFingerprint("synthetic-comms-two")).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("the 0152 candidate script keeps an allowlist of the server environment, never all of it",()=>{
 const source=readFileSync(new URL("../../scripts/qualify-0152-candidate.ts",import.meta.url),"utf8");
 expect(/JSON\.stringify\(process\.env\)/.test(source)).toBe(false);
});
it("the Claude accounts fixture records an OAuth token only as a fingerprint",()=>{
 const source=readFileSync(new URL("../drivers/claude-accounts.test.ts",import.meta.url),"utf8");
 expect(/token:\s*process\.env\.CLAUDE_CODE_OAUTH_TOKEN/.test(source)).toBe(false);
 expect(source).toContain("fixtureCredentialFingerprint");
});
