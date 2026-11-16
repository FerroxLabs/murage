import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {callers,walks,scanners,collectedBase} from './testing/provider-secret-callers.ts';
import {corpus,generated,plainForms,session,vendors,witnesses} from './testing/provider-secret-corpus.ts';
import * as vendor from './provider-secret-mask.mjs';
import * as basic from './basic-auth-mask.ts';
import {maskSecretLabelsToEnd} from './md-secret-label.mjs';
import {ScanMeter} from '../server/redact-stream-release.ts';
import {marker,monotone} from './testing/provider-secret-assertions.ts';
import {redactSecretsForSink} from '../server/redact.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,16);
function noMaterial(out:string,material:string) {
  for(let at=0;at+8<=material.length;at++) expect(out).not.toContain(material.slice(at,at+8));
}
for(const c of callers) describe(c.id,()=>{
  it('fail-first Google composite preserves base-hidden prefix',()=>{
    if(!['chat','home','preview','relay','owner','shared','turn','sink','diagnostic','learning'].includes(c.id)) return;
    expect(c.mask(witnesses.find(x=>x[0]==='google')![1])).not.toContain('B'.repeat(8));
  });
  it('fail-first card preserves every base-hidden digit',()=>{
    // MAIN RULING 1114-UPMASK-V2-AMEND2 B4: preview has no release-base financial rule.
    if(!['chat','sink','diagnostic','relay','owner','turn'].includes(c.id)) return;
    expect(c.mask(witnesses.find(x=>x[0]==='card')![1])).not.toContain('1111');
  });
  it('fail-first repeated folded Perplexity discovers the second extent',()=>{
    noMaterial(c.mask(witnesses.find(x=>x[0]==='repeated')![1]),'Z'.repeat(22));
  });
  it('plain form matrix masks every eight-character material window',()=>{
    // MAIN RULING 1114-UPMASK-V2-AMEND2 B2: base re-application may mask more
    // and emit formatting spaces; compare visible non-whitespace pieces and
    // independently forbid every original credential-material window.
    for(const x of plainForms){const out=c.mask(x.text),again=c.mask(out);noMaterial(out,x.material);monotone(out,again,true);noMaterial(again,x.material);}
  });
  it('pins its in-tree base to real release output and checks actual public output',()=>{
    const golden=JSON.parse(readFileSync(new URL('./provider-secret-monotone.golden.json',import.meta.url),'utf8'));
    expect(golden.base).toBe('c08bf7096b'+'915dfff0bc0d46c56dcbf51e791ec5');
    expect(golden.corpus).toBe(hash(JSON.stringify(corpus)));
    expect(Object.keys(golden.outputs[c.id])).toEqual(corpus.map(x=>x.id));
    for(const x of corpus){
      const before=c.base(x.text),after=c.mask(x.text);
      expect(hash(before),x.id).toBe(golden.outputs[c.id][x.id]);
      monotone(before,after);
      if(!(vendor as any).vendorSecretSpans(x.text).length) expect(after,x.id).toBe(before);
    }
  });
});
for(const c of scanners) describe(c.id+' A4 scanner accounting',()=>{
  it('fail-first budget 625 preserves exhausted output',()=>{
    const x=witnesses.find(x=>x[0]==='a4')![1];
    expect(c.scan(x,{budget:625})).toMatchObject({text:'«redacted»',exhausted:true});
  });
  it('below, at and above base exhaustion with and without a vendor',()=>{
    for(const x of [witnesses.find(x=>x[0]==='a4')![1], 'ordinary '+vendors[4][1], 'ordinary '+'sk'+'-'+'Q'.repeat(16)]) {
      const reference=c.scan(x,{vendor:false} as any),W=reference.workUnits;
      for(const budget of [W-1,W,W+1]){
        const base=c.scan(x,{vendor:false,budget} as any),out=c.scan(x,{budget});
        expect(out.exhausted).toBe(base.exhausted);expect(out.workUnits).toBe(base.workUnits);
        if(base.exhausted) expect(out).toEqual(base);
        else {monotone(base.text,out.text);for(const b of base.spans??[]) expect(out.spans?.some(s=>s.from<=b.from&&s.to>=b.to)).toBe(true);}
        if(!(vendor as any).vendorSecretSpans(x).length) expect(out).toEqual(base);
      }
    }
  });
  it('golden work and ScanMeter decisions remain equal',()=>{
    const golden=JSON.parse(readFileSync(new URL('./provider-secret-monotone.golden.json',import.meta.url),'utf8'));
    for(const x of corpus) {
      expect(c.scan(x.text).workUnits,x.id).toBe(golden.work[c.id][x.id]);
      const W=c.scan(x.text,{vendor:false} as any).workUnits;
      for(const allowance of [W-1,W,W+1]) {
        const outcome=(withVendor:boolean)=>{const m=new ScanMeter(allowance,(s,o)=>c.scan(s,{...o,vendor:withVendor} as any));try{const r=m.check(x.text);return [r.exhausted,m.work];}catch(e){return [(e as any).outcome,m.work];}};
        expect(outcome(true)).toEqual(outcome(false));
      }
    }
  });
});
it('vendor coordinates exclude the retained session label',()=>{
  const text='X-Amz-Security-Token='+session;
  expect((vendor as any).vendorSecretSpans(text)).toEqual([{start:21,end:text.length}]);
});
it('Basic splice forwards a later vendor and preserves original lengths',()=>{
  const x=witnesses.find(x=>x[0]==='basic-splice')![1];
  for(const c of callers.filter(c=>['chat','sink','diagnostic','preview'].includes(c.id))) noMaterial(c.mask(x),vendors[4][1]);
  const carry=[{start:3,end:7,origins:[{id:0,length:4}]}];
  const rule:basic.TrackedRule=(s,e)=>basic.replaceTracked(s,/abc/,()=>'',e);
  const stages=[(basic as any).tracked(rule)];
  expect((basic as any).runStages('abc1234',stages,carry)).toBe('1234');
});
it('collecting edits cannot change any base stage text on vendor inputs',()=>{
  for(let index=0;index<9;index++) for(const x of [...plainForms,...witnesses.map(([id,text])=>({id,text}))]) {
    expect(collectedBase(index,x.text)).toBe(callers[index]!.base(x.text));
  }
});
it('sink label exhaustion reports a complete replacement edit',()=>{
  const text=witnesses.find(x=>x[0]==='sink-exhaustion')![1],edits:basic.Edit[]=[];
  const out=maskSecretLabelsToEnd(text,()=>'',undefined,e=>edits.push(e));
  expect(out).toBe('«redacted»');expect(edits).toEqual([{start:0,end:text.length,length:out.length}]);
});
it('A5 sink exhaustion preserves release-base Basic forwarding without a vendor',()=>{
  const text='Authorization: Basic '+'B'.repeat(24)+'\nx'+' '.repeat(524288);
  expect(redactSecretsForSink(text)).toBe('«redacted»«redacted 24 chars»');
});
it('A5 sink exhaustion drops vendor carry while preserving release-base Basic markers',()=>{
  const text='Authorization: Basic '+'B'.repeat(24)+'\n'+vendors[4][1]+' '.repeat(524288);
  expect(redactSecretsForSink(text)).toBe('«redacted»«redacted 24 chars»');
});
it('visible carry retains local origins across bridging replacements, deletion and insertion',()=>{
  const left={id:0,length:4},right={id:1,length:4};
  const spans=[{start:0,end:4,origins:[left]},{start:6,end:10,origins:[right]}];
  expect(basic.forwardVisibleSpans(spans,[{start:2,end:8,length:3}])).toEqual([
    {start:0,end:2,origins:[left]},{start:5,end:7,origins:[right]},
  ]);
  expect(basic.forwardVisibleSpans(spans,[{start:2,end:8,length:0}])).toEqual([
    {start:0,end:2,origins:[left]},{start:2,end:4,origins:[right]},
  ]);
  expect(basic.forwardVisibleSpans(spans,[{start:0,end:0,length:2},{start:4,end:4,length:3}])).toEqual([
    {start:2,end:6,origins:[left]},{start:11,end:15,origins:[right]},
  ]);
});
it('walks mask every plain form',()=>{
  for(const walk of walks)for(const x of plainForms) noMaterial(JSON.stringify(walk({result:x.text})),x.material);
});
it('detected extents never enter a comparison sort',()=>{
  const sort=Array.prototype.sort;
  for(const c of scanners) {
    const calls:number[]=[];
    Array.prototype.sort=function(compare:any){calls.push(this.length);return sort.call(this,compare);};
    let base:number[],added:number[];
    try {c.scan('ordinary');base=calls.splice(0);c.scan('ordinary '+Array.from({length:40},()=>vendors[4][1]).join(' '));added=calls.splice(0);}
    finally {Array.prototype.sort=sort;}
    expect(added!).toEqual(base!);
  }
});
it('generated corpus includes genuinely completing below-floor composites',()=>{
  for(const c of callers.filter(c=>['chat','shared','turn'].includes(c.id))) {
    const kept=generated.filter(x=>{const outer=c.base(x.outer);return outer===x.outer&&c.base(x.text)!==x.text;});
    expect(kept.length).toBeGreaterThan(100);
  }
});

it('URL readability keeps public continuation whenever the base keeps it',()=>{
  for(const c of callers) for(const x of plainForms.filter(x=>x.id.endsWith('/query'))) {
    if(c.base(x.text).includes('&page=next')) expect(c.mask(x.text)).toContain('&page=next');
  }
});

import {createTurnTextPolicy,type ManifestBatch,type TurnAdmission} from '../server/redact-turn.ts';
it('plain forms at every delta split in assistant and tool streams',()=>{
  for(const x of plainForms)for(const stream of ['assistant','tool'])for(let at=0;at<=x.text.length;at++){
    const policy=createTurnTextPolicy(),admission={} as TurnAdmission;policy.admit(admission);
    const batch=(text:string):ManifestBatch=>({envelope:{eventId:'fixture',instanceId:'fixture',threadId:'fixture',generation:1,intakeOrdinal:1,createdAt:0},variant:'M15',carriers:[{text,stream,path:'text',mode:'delta'}],controls:{}});
    const results=[policy.consume(admission,batch(x.text.slice(0,at))),policy.consume(admission,batch(x.text.slice(at))),policy.finish(admission,'complete')];
    noMaterial(results.flatMap(r=>r.operations).map(o=>o.text).join(''),x.material);
  }
},120_000);

for(const c of callers) it(c.id+' vendor coverage includes every plain material window',()=>{
  for(const x of plainForms) noMaterial(c.mask(x.text),x.material);
});
it('gateway retains a session label the base does not absorb',()=>{
  const text='X-Amz-Security-Token='+session;
  expect(callers.find(c=>c.id==='gateway')!.mask(text)).toBe('X-Amz-Security-Token=[redacted]');
});
it('Basic splice forwards a separate vendor after a quoted payload',()=>{
  const value=vendors[4][1],input=`Authorization: Basic "${'B'.repeat(24)}" result ${value}`;
  const marker=(n:number)=>`«redacted ${n} chars»`;
  const carried=basic.maskBasicAuthCarry(input,[],marker,basic.vendorCarry(input));
  expect(carried.text).toBe(basic.maskBasicAuth(input,[],marker));
  expect(carried.carry).toHaveLength(1);
  expect(carried.carry[0]!.start).toBe(carried.text.indexOf(value));
  expect(carried.carry[0]!.end).toBe(carried.text.indexOf(value)+value.length);
  noMaterial(basic.spliceSpans(carried.text,carried.carry,marker),value);
  for(const c of callers.filter(c=>['chat','sink','diagnostic','preview'].includes(c.id))) noMaterial(c.mask(input),value);
});

for(const c of scanners) it(c.id+' contains every completed base span across the corpus',()=>{
  for(const x of corpus){
    const base=c.scan(x.text,{vendor:false} as any),out=c.scan(x.text);
    expect(out.exhausted,x.id).toBe(base.exhausted);expect(out.workUnits,x.id).toBe(base.workUnits);
    if(base.exhausted){expect(out,x.id).toEqual(base);continue;}
    for(const span of base.spans??[])expect(out.spans?.some(s=>s.from<=span.from&&s.to>=span.to),x.id).toBe(true);
  }
});

for(const c of callers) it(c.id+' B1 preserves every base marker and its count',()=>{
  for(const x of corpus) {
    const before=c.base(x.text),after=c.mask(x.text);
    const retained=after.match(marker)??[];let at=0;
    for(const mark of before.match(marker)??[]) {
      while(at<retained.length&&retained[at]!==mark)at++;
      expect(retained[at],x.id).toBe(mark);at++;
    }
  }
});
it('B1 never absorbs a retained base label or marker, including partial coverage',()=>{
  const value=vendors[4][1],head=value.slice(0,20),tail=value.slice(20);
  const rule:basic.TrackedRule=(s,e)=>basic.replaceTracked(s,new RegExp(head),()=> 'base-label=[removed]',e);
  const stages=[basic.tracked(rule)];
  expect(basic.maskVendorLast(value,stages,()=> '[secret]')).toBe('base-label=[removed][secret]');
  expect(basic.maskVendorLast(value,[basic.tracked((s,e)=>basic.replaceTracked(s,new RegExp(value),()=> 'base-label=[removed]',e))],()=> '[secret]')).toBe('base-label=[removed]');
  expect(tail.length).toBeGreaterThan(8);
});
