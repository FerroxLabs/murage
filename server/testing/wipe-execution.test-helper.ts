// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: MAIN owns permission delivery; tafix-r4a owns this disposable consumer.
import {lstatSync,readFileSync,readdirSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** File bytes and directory/link identities, without following a retargeted link. */
export function effectTree(root:string,under=''):Record<string,string>{
 const entries:Record<string,string>={};
 for(const name of readdirSync(join(root,under)).sort()){
  const relative=under?under+'/'+name:name,path=join(root,relative),stat=lstatSync(path);
  entries[relative]=stat.isSymbolicLink()?'link:'+readlinkSync(path):stat.isDirectory()?'directory':'file:'+readFileSync(path).toString('base64');
  if(stat.isDirectory())Object.assign(entries,effectTree(root,relative));
 }
 return entries;
}

/** Execute only the issued, fixture-owned command after the real CLI permission response. */
export function executingPermissionFixture(input:{command:string;cwd:string}):string{
 const cli=pathToFileURL(join(process.cwd(),'server/testing/fake-claude-cli.ts')).href;
 const anchor='      verdict = decision.behavior === "allow" ? "allowed" : "denied";';
 const effect=`if(decision.behavior==='allow'&&tool==='Bash'){
  const judged=decision.updatedInput??input,expected=${JSON.stringify(input)};
  if(judged.command!==expected.command||judged.cwd!==expected.cwd)throw Error('unissued fixture command');
  const {execFileSync}=await import('node:child_process');
  execFileSync('bash',['-c',judged.command],{cwd:judged.cwd,env:{...process.env,PATH:join(judged.cwd,'bin')+':/usr/local/bin:/usr/bin:/bin'}});
  appendFileSync(join(judged.cwd,'effect-log'),JSON.stringify(judged)+'\\n');
 }
 ${anchor}`;
 const wrapper=`#!/usr/bin/env node
 import {readFileSync} from 'node:fs';
 import {registerHooks} from 'node:module';
 registerHooks({load(url,context,next){
  if(url!==${JSON.stringify(cli)})return next(url,context);
  const source=readFileSync(new URL(url),'utf8'),anchor=${JSON.stringify(anchor)};
  if(source.split(anchor).length!==2)throw Error('missing fixture execution anchor');
  return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,${JSON.stringify(effect)})};
 }});
 await import(${JSON.stringify(cli)});
 `;
 return `
  const fs=await import('node:fs'),path=await import('node:path');
  const root=process.env.MURAGE_DATA_DIR,wrapper=path.join(root,'executing-permission.mjs');
  fs.writeFileSync(wrapper,${JSON.stringify(wrapper)},{mode:0o755});
  process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
  process.env.FAKE_CLAUDE_PERM_INPUT=${JSON.stringify(JSON.stringify(input))};
  const file=path.join(root,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
  config.instances.verification.config.cli=wrapper;
  fs.writeFileSync(file,JSON.stringify(config));
 `;
}
