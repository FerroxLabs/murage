import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {callers,scanners} from './testing/provider-secret-callers.ts';
import {corpus} from './testing/provider-secret-corpus.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,16);
it('pins all public release-base outputs and scanner accounting',()=>{
  const base='c08bf7096b'+'915dfff0bc0d46c56dcbf51e791ec5';
  if(process.env.UPMASK_PREPARED_BASE){
    expect(process.env.UPMASK_PREPARED_BASE).toBe(base);
    const outputs=Object.fromEntries(callers.map(c=>[c.id,Object.fromEntries(corpus.map(x=>[x.id,hash(c.mask(x.text))]))]));
    const work=Object.fromEntries(scanners.map(c=>[c.id,Object.fromEntries(corpus.map(x=>[x.id,c.scan(x.text).workUnits]))]));
    console.info('UPMASK_GOLDEN:'+JSON.stringify({base,corpus:hash(JSON.stringify(corpus)),outputs,work}));
  }else{
    const golden=JSON.parse(readFileSync(new URL('./provider-secret-monotone.golden.json',import.meta.url),'utf8'));
    expect(golden.base).toBe(base);expect(golden.corpus).toBe(hash(JSON.stringify(corpus)));
    for(const c of callers)for(const x of corpus)expect(hash(c.base(x.text)),c.id+'/'+x.id).toBe(golden.outputs[c.id][x.id]);
  }
},60_000);
