// Adapted from OpenMausBot #960, fef5542f462ca95843524f279936b9f4d13f615c (Apache-2.0).
// Named native accounts are provider instances. Claude owns their credentials.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename,dirname,isAbsolute,join,normalize } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfig,InstanceConfigMap } from "./contracts.ts";
import { resolveCli } from "./procs.ts";

export const CLAUDE_ACCOUNT_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_OAUTH_REFRESH_TOKEN","CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR","CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL","ANTHROPIC_CUSTOM_HEADERS","ANTHROPIC_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","CLAUDE_CODE_USE_FOUNDRY",
] as const;

export function resolveClaudeConfigDir(configDir?:string,env:NodeJS.ProcessEnv=process.env):string {
  const home=env.HOME||env.USERPROFILE||homedir();
  const chosen=configDir?.trim()||env.CLAUDE_CONFIG_DIR||join(home,".claude");
  const expanded=chosen==="~"?home:chosen.startsWith("~/")?join(home,chosen.slice(2)):chosen;
  if(!isAbsolute(expanded)||expanded.length>4096||/[\p{Cc}\p{Cf}]/u.test(expanded))throw new Error("Use an absolute Claude configuration directory or a path beginning with ~/.");
  return normalize(expanded);
}

/** No explicit named root means no change to the default login namespace,
 * including the exact inherited CLAUDE_CONFIG_DIR string and Claude-Mem hooks. */
export function claudeAccountEnvironment(source:NodeJS.ProcessEnv,configDir?:string):NodeJS.ProcessEnv {
  const env={...source};if(!configDir?.trim())return env;
  for(const key of Object.keys(env))if(key.toUpperCase()==="CLAUDE_CONFIG_DIR"||(CLAUDE_ACCOUNT_ENV_KEYS as readonly string[]).includes(key.toUpperCase())||key.toUpperCase().startsWith("CLAUDE_CODE_OAUTH_"))delete env[key];
  env.CLAUDE_CONFIG_DIR=resolveClaudeConfigDir(configDir,source);
  return env;
}

const text=z.string().trim().max(4096).refine(value=>!/[\p{Cc}\p{Cf}]/u.test(value),"Control characters are not allowed");
export const createClaudeAccountSchema=z.object({displayName:text.min(1).max(80),configDir:text.optional()}).strict();
export const claudeAccountSettingsSchema=z.object({displayName:text.min(1).max(80).optional(),configDir:text.optional()}).strict().refine(value=>Object.keys(value).length>0,"No settings supplied");
function rawConfig(entry:InstanceConfig):Record<string,unknown>{return entry.config&&typeof entry.config==="object"&&!Array.isArray(entry.config)?entry.config as Record<string,unknown>:{};}
export function accountDirectory(entry:InstanceConfig):string {
  const value=rawConfig(entry).configDir;if(value!==undefined&&typeof value!=="string")throw new Error("Invalid saved Claude configuration directory.");
  return resolveClaudeConfigDir(value as string|undefined,{...process.env,...entry.environment});
}
function directoryIdentity(path:string):string {
  // Login may not have created the leaf yet. Resolve its existing parent so
  // symlink aliases cannot reserve two names for one future credential root.
  const missing:string[]=[];let current=path;
  for(;;){
    try{const canonical=join(realpathSync.native(current),...missing.reverse());return process.platform==="win32"?canonical.toLowerCase():canonical;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("Claude configuration directory cannot be resolved safely.");const parent=dirname(current);if(parent===current)throw new Error("Claude configuration directory cannot be resolved safely.");missing.push(basename(current));current=parent;}
  }
}
export function assertSeparateClaudeAccount(instances:InstanceConfigMap,id:string,entry:InstanceConfig):void {
  const directory=directoryIdentity(accountDirectory(entry));
  const defaultDirectory=directoryIdentity(resolveClaudeConfigDir());
  if(directory===defaultDirectory)throw Object.assign(new Error("Use the existing default Claude account or choose a separate configuration directory."),{status:409});
  for(const [otherId,other] of Object.entries(instances)){
    if(otherId===id||other.driver!=="claudeAgent")continue;
    let otherDirectory:string;try{otherDirectory=directoryIdentity(accountDirectory(other));}catch{continue;}
    if(otherDirectory===directory)throw Object.assign(new Error("That Claude directory is already configured. Select its existing account."),{status:409});
  }
}

/** The caller supplies a persistable map, never runtime-injected credentials. */
export function newClaudeAccount(instances:InstanceConfigMap,body:unknown,dataDir=DATA_DIR){
  const input=createClaudeAccountSchema.parse(body),next=structuredClone(instances),instanceId=`claude-${randomUUID()}`;
  const installed=Object.values(next).find(entry=>entry.driver==="claudeAgent");
  const cli=installed?rawConfig(installed).cli:undefined;
  const entry:InstanceConfig={driver:"claudeAgent",displayName:input.displayName,config:{...(typeof cli==="string"&&cli?{cli}:{}),configDir:resolveClaudeConfigDir(input.configDir||join(dataDir,"providers",instanceId))}};
  assertSeparateClaudeAccount(next,instanceId,entry);next[instanceId]=entry;return {instanceId,instances:next};
}

/** A user-pasted native login command. No credential values appear in argv;
 * the subshell/process block restores the user's shell environment on exit. */
export function claudeSignInCommand(cli:string,directory:string,platform:NodeJS.Platform=process.platform):string {
  const resolved=resolveCli(cli,directory?["auth","login"]:[]);
  if(platform==="win32"){
    const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
    const command=`& ${[resolved.command,...resolved.args].map(quote).join(" ")}`;
    if(!directory)return command;
    const keys=[...CLAUDE_ACCOUNT_ENV_KEYS,"CLAUDE_CONFIG_DIR"];
    return `& { $murageAccountKeys = ${keys.map(quote).join(",")}; $murageAccountSaved = @{}; foreach ($key in $murageAccountKeys) { $murageAccountSaved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $null, 'Process') }; try { $env:CLAUDE_CONFIG_DIR = ${quote(directory)}; ${command} } finally { foreach ($key in $murageAccountKeys) { [Environment]::SetEnvironmentVariable($key, $murageAccountSaved[$key], 'Process') } } }`;
  }
  const quote=(value:string)=>`'${value.replaceAll("'",`'"'"'`)}'`;
  const command=[resolved.command,...resolved.args].map(quote).join(" ");
  return directory?`(unset ${CLAUDE_ACCOUNT_ENV_KEYS.join(" ")}; export CLAUDE_CONFIG_DIR=${quote(directory)}; ${command})`:command;
}

export function claudeAccountInfo(instanceId:string,entry:InstanceConfig,cli:string){
  const raw=rawConfig(entry).configDir;
  if(raw!==undefined&&typeof raw!=="string")throw new Error("Invalid saved Claude configuration directory.");
  const configDir=typeof raw==="string"&&raw.trim()?accountDirectory(entry):"";
  return {configDir,managed:!!configDir,isDefault:instanceId==="claude",signInCommand:claudeSignInCommand(cli,configDir),signInShell:process.platform==="win32"?"powershell" as const:"sh" as const};
}
