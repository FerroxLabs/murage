// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { win32 } from 'node:path';
import { restrictArguments } from '../../sentinel/win-acl.ts';
import { defaultSecurityRunner, type SecurityRunner } from './windows-security-runner.ts';
import { WindowsSecurityTimeoutError } from './windows-security-timeout.ts';
import { isWindowsSecuritySessionRunner, registerWindowsSecurityScript } from './windows-security-session.ts';

// Paths and SID are data, never interpolated into executable PowerShell.
// Use separate file/directory descriptors: file grants must not be inherit-only.
export const PROTECT_SCRIPT=String.raw`& {
  $ErrorActionPreference = 'Stop'
  $entries = @(($env:MURAGE_SIGNAL_NEW | ConvertFrom-Json) | ForEach-Object { $_ })
  foreach ($entry in $entries) {
    $item = Get-Item -LiteralPath $entry.path -Force
    if (([int]$item.Attributes -band 1024) -ne 0 -or $item.PSIsContainer -ne $entry.directory) { throw 'Changed entry' }
    $flags = ''; if ($entry.directory) { $flags = 'OICI' }
    $sddl = 'D:P(A;' + $flags + ';FA;;;' + $env:MURAGE_SIGNAL_SID + ')(A;' + $flags + ';FA;;;SY)'
    $acl = Get-Acl -LiteralPath $entry.path
    $acl.SetSecurityDescriptorSddlForm($sddl, [System.Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $entry.path -AclObject $acl
  }
  'MURAGE_SIGNAL_PROTECTED'
}

`;
registerWindowsSecurityScript(PROTECT_SCRIPT);

/** Only entries this operation created inside a verified private directory.
 * Its inheritable user/SYSTEM grants protect content until the batch barrier.
 * Never use this adapter to repair existing storage or a failed ACL verdict. */
function protectBatch(entries:readonly {path:string;directory:boolean}[],sid:string,deadline:number,run:SecurityRunner=defaultSecurityRunner,env:NodeJS.ProcessEnv=process.env):boolean {
  if(!entries.length)return true;
  if(!/^S-1-(?:\d+-){1,14}\d+$/.test(sid))return false;
  const root=env.SystemRoot??env.SYSTEMROOT??'C:\\Windows';if(!win32.isAbsolute(root))return false;
  const remaining=deadline-Date.now();if(remaining<=0)throw new WindowsSecurityTimeoutError();
  try{
    // Singletons use the same resident interpreter as batches. Starting an
    // icacls child for each control/journal save dominated replacement parks.
    // Standalone/injected one-shot runners retain their cheaper singleton path.
    if(entries.length===1&&!isWindowsSecuritySessionRunner(run)){
      const entry=entries[0]!;
      run(win32.join(root,'System32','icacls.exe'),restrictArguments(entry.path,sid,entry.directory),{env,timeout:remaining});return true;
    }
    const output=run(win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','-'],{
      input:PROTECT_SCRIPT,env:{...env,MURAGE_SIGNAL_NEW:JSON.stringify(entries),MURAGE_SIGNAL_SID:sid},timeout:remaining,
    });
    return output.trim()==='MURAGE_SIGNAL_PROTECTED';
  }catch(error){if((error as NodeJS.ErrnoException)?.code==='ETIMEDOUT')throw new WindowsSecurityTimeoutError();return false;}
}

/** Bound every native environment value, including first-use migration trees. */
export function protectWindowsParkEntries(entries:readonly {path:string;directory:boolean}[],sid:string,deadline:number,run:SecurityRunner=defaultSecurityRunner,env:NodeJS.ProcessEnv=process.env):boolean {
  let batch:Array<{path:string;directory:boolean}>=[],units=2;
  const flush=()=>{const ok=protectBatch(batch,sid,deadline,run,env);batch=[];units=2;return ok;};
  for(const entry of entries){
    const size=JSON.stringify(entry).length+1;
    if(size+2>30_000)return false;
    if(units+size>30_000&&!flush())return false;
    batch.push(entry);units+=size;
  }
  return flush();
}
