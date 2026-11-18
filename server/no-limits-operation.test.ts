// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { extractInspectedOperation, exactInputHash, issuedOperationHash } from './no-limits-operation.ts';
import type { ServiceCall, RequestSnapshot } from './decision/types.ts';
import { inspectNativeEffects } from './no-limits-fs.ts';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './testing/cleanup.ts';
import type { InspectedOperation } from './no-limits-fs.ts';
const extract=(tool:string,input:unknown)=>extractInspectedOperation({tool,input});
function operation(result:ReturnType<typeof extractInspectedOperation>):InspectedOperation{
  expect(result.kind).toBe('operation');if(result.kind!=='operation')throw new Error('missing-operation');return result.exactOperation;
}
const patch=(...lines:string[])=>['*** Begin Patch',...lines,'*** End Patch'].join('\n');

describe('C6 exact operation extraction',()=>{
  it('retains every patch effect, both move names and path 300 beyond display caps',()=>{
    const text=patch('*** Delete File: gone','*** Update File: old','*** Move to: renamed','@@','-a','+b',...Array.from({length:300},(_,i)=>[`*** Add File: out/${i}`,'+x']).flat());
    const result=operation(extract('apply_patch',{input:text,cwd:'/work'}));
    expect(result.kind).toBe('native');if(result.kind!=='native')return;
    expect(result.effects).toHaveLength(304);
    expect(result.effects.slice(0,4)).toMatchObject([
      {path:'gone',op:'delete',followFinal:false},{path:'old',op:'delete',followFinal:false},
      {path:'renamed',source:'old',op:'rename',followFinal:false},{path:'renamed',op:'edit',followFinal:true},
    ]);
    expect(result.effects.at(-1)).toMatchObject({path:'out/299',op:'write',followFinal:true});
    expect(result.cwd).toBe('/work');
  });
  it.each(['input','patch','command'])('reads original No limits apply_patch %s input',field=>{
    const result=operation(extract('apply_patch',{[field]:patch('*** Add File: notes','+x')}));
    expect(result).toMatchObject({kind:'native',effects:[{path:'notes',op:'write'}]});
  });
  it('does not parse prose or accept an invalid patch plus a plausible display path',()=>{
    expect(extract('apply_patch',{input:'*** Delete File: /etc/hosts',paths:['ordinary']})).toEqual({kind:'incomplete',reason:'unreadable-patch'});
    expect(operation(extract('opaque',{content:'write /etc/hosts'}))).toMatchObject({kind:'native',effects:[]});
    expect(operation(extract('read_file',{path:'/etc/hosts'}))).toMatchObject({kind:'native',effects:[]});
    expect(operation(extract('str_replace_editor',{command:'view',path:'/etc/hosts'}))).toMatchObject({kind:'native',effects:[]});
  });
  it('retains nested multi-file endpoints without turning file content into paths',()=>{
    const result=operation(extract('write_files',{files:Array.from({length:300},(_,i)=>({path:`out/${i}`,content:'/etc/hosts'}))}));
    expect(result.kind).toBe('native');if(result.kind!=='native')return;
    expect(result.effects).toHaveLength(300);expect(result.effects.at(-1)?.path).toBe('out/299');
    expect(result.effects.every(effect=>effect.path.startsWith('out/'))).toBe(true);
    expect(operation(extract('MultiEdit',{file_path:'one',edits:[{old_string:'a',new_string:'b'}]}))).toMatchObject({effects:[{path:'one',op:'edit'}]});
    expect(operation(extract('edit_files',{edits:[{filePath:'one',new_string:'a'},{path:'two',new_string:'b'}]}))).toMatchObject({effects:[{path:'one'},{path:'two'}]});
    expect(extract('write_files',{files:[{path:'one'},{}]}).kind).toBe('incomplete');
  });
  it.each(['edits','entries','changes'])('BLOCK 2 traverses nested %s even with an inherited parent path',field=>{
    for(const destination of ['/etc/hosts','ordinary-child']){
      const result=operation(extract('MultiEdit',{path:'ordinary-parent',[field]:[{files:[{path:destination}]}]}));
      expect(result).toMatchObject({kind:'native',effects:[{path:'ordinary-parent'},{path:destination}]});
      if(result.kind==='native')expect(inspectNativeEffects(result.effects,{cwd:'/fixture'}).verdict).toBe(destination.startsWith('/etc/')?'hold':'run');
    }
    expect(extract('MultiEdit',{path:'ordinary-parent',[field]:[{files:[{}]}]}).kind).toBe('incomplete');
    expect(operation(extract('MultiEdit',{path:'ordinary-parent',[field]:[{old_string:'a',new_string:'b'}]}))).toMatchObject({effects:[{path:'ordinary-parent'}]});
  });
  it('BLOCK 3 merges displayed locations without changing removed endpoint roles',()=>{
    const source={tool:'edit',input:{paths:['old','new'],removed:['old']},event:{tool:'edit',toolKind:'edit',filePaths:['old','new','extra'],toolCall:{name:'edit',input:{paths:['old','new'],removed:['old']}}}} as unknown as RequestSnapshot;
    const result=operation(extractInspectedOperation(source));
    expect(result.kind).toBe('native');if(result.kind!=='native')return;
    expect(result.effects.filter(effect=>effect.path==='old')).toEqual([expect.objectContaining({op:'delete',followFinal:false})]);
    expect(result.effects.filter(effect=>effect.path==='new')).toHaveLength(1);
    expect(result.effects).toContainEqual(expect.objectContaining({path:'extra',op:'edit',followFinal:true}));
  });
  it('BLOCK 3 unlink of an ordinary symlink remains RUN when locations repeat it',async()=>{
    const scratch=mkdtempSync(join(tmpdir(),'nlsym-unlink-'));
    try{
      const path=join(scratch,'old');symlinkSync('/etc/hosts',path);
      const input={paths:[path],removed:[path]};
      const result=operation(extractInspectedOperation({tool:'edit',input,event:{tool:'edit',toolKind:'edit',filePaths:[path],toolCall:{name:'edit',input}}} as unknown as RequestSnapshot));
      expect(result.kind).toBe('native');if(result.kind!=='native')return;
      expect(inspectNativeEffects(result.effects).verdict).toBe('run');
    }finally{await removeTempDir(scratch);}
  });
  it('BLOCK 3 Codex resolved display paths never replace exact unlink endpoints',async()=>{
    const scratch=mkdtempSync(join(tmpdir(),'nlsym-unlink-'));
    try{
      symlinkSync('/etc/hosts',join(scratch,'old'));
      const input={paths:['old'],removed:['old'],cwd:scratch};
      // codexNativeEditCall emits original paths and a placed display list.
      const result=operation(extractInspectedOperation({tool:'edit',input,event:{toolEngine:'codex',tool:'edit',filePaths:['/etc/hosts'],toolCall:{name:'edit',input}}} as unknown as RequestSnapshot));
      expect(result).toMatchObject({kind:'native',effects:[{path:'old',op:'delete',followFinal:false}]});
      if(result.kind==='native'){
        expect(result.effects).toHaveLength(1);
        expect(inspectNativeEffects(result.effects,{cwd:scratch}).verdict).toBe('run');
      }
    }finally{await removeTempDir(scratch);}
  });
  it('binds native content changes, kind and input tails even when effects match',()=>{
    const a=extract('write_file',{path:'one',content:'a'.repeat(200000)+'x'}),b=extract('write_file',{path:'one',content:'a'.repeat(200000)+'y'});
    expect(a.kind).toBe('operation');expect(b.kind).toBe('operation');
    if(a.kind!=='operation'||b.kind!=='operation')return;
    expect(a.exactOperation).toEqual(b.exactOperation);expect(a.operationHash).not.toBe(b.operationHash);
    expect(issuedOperationHash(a.exactOperation)).toBe(a.operationHash);
    expect(issuedOperationHash({...a.exactOperation})).toBeUndefined();
    expect(Object.isFrozen(a.exactOperation)).toBe(true);
  });
  it('never substitutes Python/JS code with a fictitious shell command',()=>{
    expect(extract('python',{code:"open('/etc/hosts','w')"})).toMatchObject({kind:'code',lang:'py',text:"open('/etc/hosts','w')"});
    expect(extract('node',{code:"fs.writeFileSync('/etc/hosts','x')"})).toMatchObject({kind:'code',lang:'js'});
  });
  it('retains exact dialect, argv, final cwd and invalid-cwd provenance',()=>{
    const source:ServiceCall={tool:'exec_command',input:{cmd:['printf','a b'],workdir:'/input'}};
    expect(operation(extractInspectedOperation(source,{cwd:'/actual',dialect:'cmd'}))).toEqual({kind:'exec',dialect:'cmd',text:"printf 'a b'",cwd:'/actual',cwdInvalid:false});
    expect(operation(extractInspectedOperation(source,{cwd:'/actual',cwdInvalid:true}))).toMatchObject({kind:'exec',cwdInvalid:true});
    expect(operation(extractInspectedOperation(source,{cwdInvalid:true}))).not.toHaveProperty('cwd');
  });
  it('does not silently check a known native operation from displayed locations alone',()=>{
    const source={tool:'edit',input:{},event:{tool:'edit',toolKind:'edit',filePaths:['one'],toolCall:{name:'edit',input:{}}}} as unknown as RequestSnapshot;
    expect(extractInspectedOperation(source)).toEqual({kind:'incomplete',reason:'missing-native-path'});
  });
  it('keeps native unlink separate from copy, relocation and hard-link source roles',()=>{
    expect(operation(extract('edit',{paths:['old','new'],removed:['old']}))).toMatchObject({effects:[{path:'new',op:'edit',followFinal:true},{path:'old',op:'delete',followFinal:false}]});
    expect(operation(extract('delete_file',{path:'link'}))).toMatchObject({effects:[{path:'link',op:'delete',followFinal:false}]});
    expect(operation(extract('move_file',{source:'old',destination:'new'}))).toMatchObject({effects:[{path:'old',op:'delete',followFinal:false},{path:'new',source:'old',op:'rename',followFinal:false}]});
    expect(operation(extract('hardlink',{source:'old',destination:'new'}))).toMatchObject({effects:[{path:'new',source:'old',op:'link',linkKind:'hard',followFinal:false}]});
    expect(operation(extract('link',{source:'old',destination:'new'}))).toMatchObject({effects:[{source:'old',op:'link',linkKind:'hard'}]});
    expect(operation(extract('copy_file',{source:'old',destination:'new',recursive:true}))).toMatchObject({effects:[{path:'new',source:'old',op:'copy',followFinal:true,recursive:true}]});
  });
  it('retains every native file-change kind and move destination',()=>{
    expect(operation(extract('edit',{fileChanges:[{path:'one',kind:'add'},{path:'two',kind:'delete'},{path:'old',kind:{type:'update',move_path:'new'}}]}))).toMatchObject({effects:[{path:'one',op:'write'},{path:'two',op:'delete'},{path:'old',op:'delete'},{path:'new',op:'rename',source:'old'},{path:'new',op:'edit'}]});
    expect(operation(extract('edit',{fileChanges:{one:{type:'add'}},grantRoot:'/etc'}))).toMatchObject({effects:[{path:'one'},{path:'/etc',operandId:'native:grant-root'}]});
  });
  it('exact input hash is canonical, distinguishes types and rejects cycles/accessors',()=>{
    expect(exactInputHash({b:1,a:'x'})).toBe(exactInputHash({a:'x',b:1}));
    expect(exactInputHash(['1'])).not.toBe(exactInputHash([1]));
    const cycle:unknown[]=[];cycle.push(cycle);expect(()=>exactInputHash(cycle)).toThrow('operation-input-integrity');
    expect(()=>exactInputHash({get path(){throw new Error('never evaluate getters');}})).toThrow('operation-input-integrity');
  });
});
