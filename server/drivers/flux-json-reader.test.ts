import { expect, it } from 'vitest';
import { inspectFluxResponse } from './flux-busyloop-readers.ts';
import { readFluxJson } from './flux-json-reader.ts';
function splitBody(raw:string,size:number) {
 const data=new TextEncoder().encode(raw);let at=0;
 return new Response(new ReadableStream({pull(controller){if(at===data.length){controller.close();return;}controller.enqueue(data.subarray(at,at+size));at=Math.min(data.length,at+size);}}),{status:429,headers:{'Retry-After':'1'}});
}
it('long and escaped diagnostic strings do not hide later structural terminal codes across chunks',async()=>{
 const raw=JSON.stringify({error:{message:'x'.repeat(64000)+'\\"😀'.repeat(1000),provider_specific_fields:{error:{state:'key_revoked'}}}});
 for(const size of [1,7,65536]) expect((await inspectFluxResponse(splitBody(raw,size),true)).decision).toEqual({reason:'keyRevoked',action:'STOP',wait:'-'});
});
it('retained string escapes stay valid JSON and arbitrary nesting/size never becomes retry',async()=>{
 const raw='{"error":{"message":"'+'x'.repeat(63999)+'\\u0061\\\\\\"'+'x'.repeat(64000)+'","state":"key_revoked"}}';
 const read=await readFluxJson(splitBody(raw,7));
 expect(JSON.parse(read.rawBody).error.state).toBe('key_revoked');
 const deep='['.repeat(65)+'0'+']'.repeat(65);
 expect((await inspectFluxResponse(splitBody(deep,4),true)).decision?.action).toBe('PAUSE');
});
it('case variants and duplicate waits normalize without losing terminal priority',async()=>{
 const headers=new Headers([['X-Flux-Hold-Reason','concurrency'],['x-flux-hold-reason','key_revoked'],['Retry-After','1'],['retry-after','1']]);
 expect((await inspectFluxResponse(new Response('{}',{status:429,headers}),true)).decision).toEqual({reason:'keyRevoked',action:'STOP',wait:'-'});
 expect((await inspectFluxResponse(new Response('{}',{status:429,headers:{'Retry-After':'2, 2'}}),true)).decision?.wait).toBe(2);
 expect((await inspectFluxResponse(new Response('{}',{status:429,headers:{'Retry-After':'1, 60'}}),true)).decision?.wait).toBe(60);
});
it('success JSON stays byte-complete so classification does not truncate assistant output',async()=>{
 const raw=JSON.stringify({choices:[{message:{content:'x'.repeat(128000)}}]});
 const result=await inspectFluxResponse(new Response(raw),true,undefined,true);
 expect(result.rawBody).toBe(raw);expect(result.decision?.action).toBe('PASS');
});
