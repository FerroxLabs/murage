// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, execFile } from 'node:child_process';
import { withHideInherit } from '../../../shared/win-hide-child-process.mjs';
import { isReusableWindowsSecurityScript, markWindowsSecuritySessionRunner, runWindowsSecuritySession } from './windows-security-session.ts';

export interface SecurityRunOptions { input?:string;env:NodeJS.ProcessEnv;timeout:number }
export type SecurityRunner=(file:string,args:readonly string[],options:SecurityRunOptions)=>string;
export const defaultSecurityRunner:SecurityRunner=(file,args,options)=>process.platform==='win32'&&/powershell[.]exe$/i.test(file)&&isReusableWindowsSecurityScript(options.input)
  ?runWindowsSecuritySession(file,args,options)
  :execFileSync(file,[...args],withHideInherit({...options,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}));
markWindowsSecuritySessionRunner(defaultSecurityRunner);

export type AsyncSecurityRunner = (file: string, args: readonly string[], options:SecurityRunOptions) => Promise<string>;
/** One-shot startup repair only: no synchronous resident-session transport. */
export const defaultAsyncSecurityRunner: AsyncSecurityRunner = (file, args, options) => new Promise((resolve, reject) => {
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
