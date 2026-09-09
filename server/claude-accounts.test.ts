import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountDirectory, assertSeparateClaudeAccount, claudeAccountEnvironment, claudeSignInCommand, newClaudeAccount } from "./claude-accounts.ts";
import { persistableClaudeInstances, replaceClaudeAccountInstances, restoreClaudeAccountInstances } from "./claude-account-config.ts";
import type { AppConfig } from "./config.ts";

let scratch:string;
beforeEach(()=>{scratch=mkdtempSync(join(tmpdir(),"murage-accounts-"));vi.stubEnv("HOME",scratch);vi.stubEnv("USERPROFILE",scratch);vi.stubEnv("CLAUDE_CONFIG_DIR","");});
afterEach(()=>{vi.unstubAllEnvs();rmSync(scratch,{recursive:true,force:true});});
describe("native Claude account boundaries",()=>{
  it("leaves the default environment byte-for-byte and isolates explicit accounts",()=>{
    const source={HOME:scratch,CLAUDE_CONFIG_DIR:`${scratch}/default/`,CLAUDE_CODE_OAUTH_TOKEN:"synthetic-only",claude_code_oauth_future:"fake",CLAUDE_SECURESTORAGE_CONFIG_DIR:"wrong",ANTHROPIC_PROFILE:"other",KEEP:"yes"};
    expect(claudeAccountEnvironment(source)).toEqual(source);
    expect(claudeAccountEnvironment(source,join(scratch,"work"))).toEqual({HOME:scratch,CLAUDE_CONFIG_DIR:join(scratch,"work"),KEEP:"yes"});
    expect(source.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-only");
  });
  it("creates distinct metadata without directories or inherited credentials",()=>{
    const prior={claude:{driver:"claudeAgent",config:{cli:"claude",configDir:join(scratch,"old")},environment:{CLAUDE_CODE_OAUTH_TOKEN:"synthetic-only"}}};
    const a=newClaudeAccount(prior,{displayName:"Work"},scratch),b=newClaudeAccount(a.instances,{displayName:"Personal"},scratch);
    expect(a.instanceId).not.toBe(b.instanceId);expect(b.instances.claude).toEqual(prior.claude);
    expect(b.instances[b.instanceId].environment).toBeUndefined();
    expect(existsSync(accountDirectory(b.instances[b.instanceId]))).toBe(false);
    expect(()=>newClaudeAccount(prior,{displayName:"Default",configDir:join(scratch,".claude")},scratch)).toThrow(/default/);
  });
  it("rejects aliases of a not-yet-created account directory",()=>{
    mkdirSync(join(scratch,"real"));symlinkSync(join(scratch,"real"),join(scratch,"alias"),"dir");
    expect(()=>assertSeparateClaudeAccount({a:{driver:"claudeAgent",config:{configDir:join(scratch,"real","future")}}},"b",{driver:"claudeAgent",config:{configDir:join(scratch,"alias","future")}})).toThrow(/already configured/);
  });
  it.runIf(process.platform!=="win32")("executes a quoted native login recipe in an isolated subshell",()=>{
    const cli=join(scratch,"fake cli's.mjs"),dir=join(scratch,"account's root");
    writeFileSync(cli,"process.stdout.write(JSON.stringify({args:process.argv.slice(2),dir:process.env.CLAUDE_CONFIG_DIR,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,home:process.env.HOME}));");
    const command=claudeSignInCommand(`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`,dir);
    const result=JSON.parse(execFileSync("/bin/sh",["-c",command],{env:{HOME:scratch,CLAUDE_CODE_OAUTH_TOKEN:"synthetic-only"},encoding:"utf8"}));
    expect(result).toEqual({args:["auth","login"],dir,home:scratch});expect(command).not.toContain("synthetic-only");
  });
  it("PowerShell recipe quotes paths and restores process environment in finally",()=>{
    const command=claudeSignInCommand("claude","C:\\Account's root","win32");
    expect(command).toContain("C:\\Account''s root");expect(command).toContain("finally");expect(command).toContain("$murageAccountSaved[$key]");
    expect(claudeSignInCommand("claude","","win32")).toBe("& 'claude'");
  });
});
describe("account-only persistence",()=>{
  it("never writes runtime or inherited credential canaries, preserves explicit env and discovery",()=>{
    vi.stubEnv("ANTHROPIC_API_KEY","inherited-secret-canary");
    const cfg={engineDiscovery:"explicit",instances:{claude:{driver:"claudeAgent",environment:{KEEP:"explicit"}},other:{driver:"openai-compat"}},openaiCompat:{key:"workspace-secret-canary",url:"https://synthetic.invalid"}} as AppConfig;
    const map=persistableClaudeInstances(cfg);
    expect(Object.keys(map)).toEqual(["claude","other"]);expect(map.claude.environment).toEqual({KEEP:"explicit"});expect(map.other.environment).toBeUndefined();expect(map.other.config).toBeUndefined();
    const path=join(scratch,"config.json");replaceClaudeAccountInstances(map,path);
    expect(readFileSync(path,"utf8")).not.toContain("secret-canary");expect(cfg.instances?.claude.environment).toEqual({KEEP:"explicit"});
    expect(persistableClaudeInstances({} as AppConfig).claude.driver).toBe("claudeAgent");
  });
  it("replaces the map, retains unrelated raw fields, and confirms exact rollback",()=>{
    const path=join(scratch,"config.json"),original=JSON.stringify({unknown:{keep:1},xai:{key:"synthetic-secret"},instances:{claude:{driver:"claudeAgent",futureField:7},remove:{driver:"claudeAgent"}}});writeFileSync(path,original);
    const receipt=replaceClaudeAccountInstances({claude:{driver:"claudeAgent"},work:{driver:"claudeAgent",config:{configDir:join(scratch,"work")}}},path);
    expect(JSON.parse(readFileSync(path,"utf8"))).toEqual({unknown:{keep:1},xai:{key:"synthetic-secret"},instances:{claude:{driver:"claudeAgent",futureField:7},work:{driver:"claudeAgent",config:{configDir:join(scratch,"work")}}}});
    restoreClaudeAccountInstances(receipt);expect(readFileSync(path,"utf8")).toBe(original);
  });
  it("fails before writing corrupt config and refuses rollback over a later writer",()=>{
    const path=join(scratch,"config.json");writeFileSync(path,"invalid");expect(()=>replaceClaudeAccountInstances({},path)).toThrow();expect(readFileSync(path,"utf8")).toBe("invalid");
    writeFileSync(path,"{}");const receipt=replaceClaudeAccountInstances({},path);writeFileSync(path,'{"other":true}');expect(()=>restoreClaudeAccountInstances(receipt)).toThrow(/changed/);expect(readFileSync(path,"utf8")).toBe('{"other":true}');
  });
});
