import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyStartingTree} from './verify-red.mjs';
it('B8 baseline proof detects a built parser or schema overlaid on the starting tree',()=>{
 const root=mkdtempSync(join(tmpdir(),'starting-tree-proof-'));
 const blob=(body:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
 const sources:Record<string,string>={'implementation.ts':'stub','shell.ts':'starting parser','schema.ts':'starting schema'};
 const manifest=Object.entries(sources).map(([name,body])=>`100644 blob ${blob(body)}\t${name}`).join('\n');
 try{
  for(const [name,body] of Object.entries(sources))writeFileSync(join(root,name),body);
  expect(verifyStartingTree(root,manifest)).toBe(3);
  for(const name of ['shell.ts','schema.ts']){writeFileSync(join(root,name),'built source');expect(()=>verifyStartingTree(root,manifest)).toThrow('starting-tree-mismatch');writeFileSync(join(root,name),sources[name]);}
 }finally{if(!root.startsWith(join(tmpdir(),'starting-tree-proof-')))throw new Error('unsafe fixture');rmSync(root,{recursive:true,force:true});}
});
