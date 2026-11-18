// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared runner for the wipe-check class matrices. Commands are data only: nothing here runs a shell.
// Spellings and expected verdicts in the matrix files are written by hand from the programs' manuals,
// never derived from the checker's own option tables.
import {wipeBreaker} from '../wipe-breaker.ts';
import {corpusContext} from './corpus/v3-context.fixture.ts';
export type Row={e:'C'|'R';d:'sh'|'pwsh'|'cmd';p:'linux'|'darwin'|'win32';cwd?:string;cmd:string;ms?:number;env?:Record<string,string|undefined>};
export const row=(e:Row['e'],cmd:string,d:Row['d']='sh',p:Row['p']='linux',cwd?:string):Row=>({e,d,p,cwd,cmd});
export function runMatrix(name:string,rows:readonly Row[]):string[] {
 const misses:string[]=[];let ok=0;
 for(const r of rows){
  const cwd=r.cwd??(r.p==='win32'?(r.d==='sh'?'/c/work/project/pkg':'C:\\work\\project\\pkg'):'/work/project/pkg');
  const base=corpusContext({platform:r.p,dialect:r.d,cwd}),ctx=r.env?{...base,env:{...base.env,...r.env}}:base;
  let got:string;const started=performance.now();
  try{const hit=wipeBreaker(r.cmd,ctx);got=hit?'CARD:'+hit.rule:'RUN';}catch(error){got='THROW:'+String(error).slice(0,60);}
  const ms=performance.now()-started;
  const good=(r.e==='C'?got.startsWith('CARD')&&got!=='CARD:wipe-check-fault':got==='RUN')&&ms<=(r.ms??1500);
  if(good)ok++;else misses.push(`want=${r.e} got=${got} ${Math.round(ms)}ms [${r.d}/${r.p} ${cwd}] ${r.cmd.length>260?r.cmd.slice(0,120)+' ... '+r.cmd.slice(-120):r.cmd}`);
 }
 console.log(`@@MATRIX ${name} ${ok}/${rows.length}\n`+misses.map(m=>'@@MISS '+m).join('\n'));
 return misses;
}
