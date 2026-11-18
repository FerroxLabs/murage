// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { withHideInherit } from '../../../shared/win-hide-child-process.mjs';
import { isReusableWindowsSecurityScript, markWindowsSecuritySessionRunner, runWindowsSecuritySession } from './windows-security-session.ts';

export interface SecurityRunOptions { input?:string;env:NodeJS.ProcessEnv;timeout:number }
export type SecurityRunner=(file:string,args:readonly string[],options:SecurityRunOptions)=>string;
/** Windows PowerShell 5.1 loads Get-Acl/Set-Acl from PSModulePath. A parent pwsh 7
 * prepends its own module folders, which 5.1 cannot load, so every read fails and
 * storage blocks. Pin the interpreter's own system module folder instead. */
export function windowsPowerShellOptions(file:string,options:SecurityRunOptions):SecurityRunOptions {
  if(!/(?:^|[\\/])powershell[.]exe$/i.test(file))return options;
  const env:NodeJS.ProcessEnv={};
  for(const [name,value] of Object.entries(options.env))if(name.toLowerCase()!=='psmodulepath')env[name]=value;
  env.PSModulePath=win32.join(win32.dirname(file),'Modules');
  return {...options,env};
}
export const defaultSecurityRunner:SecurityRunner=(file,args,options)=>{
  options=windowsPowerShellOptions(file,options);
  return process.platform==='win32'&&/powershell[.]exe$/i.test(file)&&isReusableWindowsSecurityScript(options.input)
    ?runWindowsSecuritySession(file,args,options)
    :execFileSync(file,[...args],withHideInherit({...options,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}));
};
markWindowsSecuritySessionRunner(defaultSecurityRunner);

export type AsyncSecurityRunner = (file: string, args: readonly string[], options:SecurityRunOptions) => Promise<string>;
/** One-shot startup repair only: no synchronous resident-session transport. */
export const defaultAsyncSecurityRunner: AsyncSecurityRunner = (file, args, options) => new Promise((resolve, reject) => {
  options = windowsPowerShellOptions(file, options);
  const child = execFile(file, [...args], withHideInherit({env:options.env, encoding:'utf8', windowsHide:true,
    timeout:options.timeout, killSignal:'SIGKILL', maxBuffer:1024 * 1024}), (error, stdout) => {
    clearTimeout(timer);
    if (error) reject(error); else resolve(String(stdout));
  });
  // Settle even if a native process fails to deliver its close callback.
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(Object.assign(new Error('Windows ACL child timed out'), {code:'ETIMEDOUT'}));
  }, options.timeout);
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input);
});
