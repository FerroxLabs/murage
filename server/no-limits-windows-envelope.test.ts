// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {inspectNoLimits} from './no-limits-taint.ts';
import type {NoLimitsDisk} from './no-limits-fs.ts';
const missing=()=>{throw Object.assign(new Error('fixture absent'),{code:'ENOENT'});};
function disk(protectedTarget:boolean):NoLimitsDisk {
 const directories=new Set(['C:/','C:/work','C:/work/a','C:/Windows']);
 const files=new Set(['C:/Windows/named','C:/work/plain']);
 const link='C:/work/a/h';
 const stat=(path:string)=>{
  path=path.replace(/\/$/,'')||'/';if(path==='C:')path='C:/';
  if(!directories.has(path)&&!files.has(path)&&path!==link)return missing();
  return {dev:1n,ino:BigInt([...path].reduce((n,c)=>n+c.charCodeAt(0),0)),nlink:1n,isDirectory:()=>directories.has(path),isFile:()=>files.has(path),isSymbolicLink:()=>path===link};
 };
 return {lstat:stat,stat,readlink:path=>path===link?protectedTarget?'C:/Windows/named':'C:/work/plain':missing(),readdir:path=>path==='C:/work/a'?['h']:[]};
}
it.each([true,false])('Windows relative subtree retains its per-dialect resolver context protected=%s',held=>{
 const text='rmdir .\\unused & move .\\a .\\b & echo x > .\\b\\h';
 const result=inspectNoLimits({kind:'exec',dialect:'sh',cwd:'C:/work',cwdInvalid:false,text},{disk:disk(held)});
 if(held)expect(result.decisions.some(d=>d.reason==='alias-taint'&&d.op==='write'&&d.lexical.toLowerCase()==='c:/work/b/h')).toBe(true);
 else expect(result.decisions).toEqual([]);
});
