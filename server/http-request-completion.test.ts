// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { completeHttpRequest } from './http-request-completion.ts';
import { consumingFixture, consumingResponseRecorder } from './testing/consuming-fixture.ts';
import { consumingHttpWriter, declareNoStoredResponse, registerConsumingDescriptor } from './consuming-turn-response.ts';

it('a refused final HTTP write ends once and the isolated server serves the next request', async () => {
  const f=consumingFixture();
  const server=createServer((request,response)=>completeHttpRequest((async()=>{
    if(request.url==='/health'){response.end('ready');return;}
    const writer=consumingHttpWriter(response,f.binding,{
      headers:registerConsumingDescriptor('outer:response:headers','headers'),
      body:registerConsumingDescriptor('outer:response:body','body'),
      chunk:registerConsumingDescriptor('outer:response:chunk','chunk'),
    });
    declareNoStoredResponse(writer,500);
    f.replace();
    writer.end('unreleased fixture bytes');
  })(),response));
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const port=(server.address() as {port:number}).port;
    const refused=await fetch(`http://127.0.0.1:${port}/refuse`);
    expect(refused.status).toBe(409);
    expect(refused.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(await refused.text()).toBe('I stopped this turn because some of its context is no longer available.');
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe('ready');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
it('closes an unfinished refused response and preserves unrelated failures',async()=>{
  const sink=consumingResponseRecorder();
  await completeHttpRequest(Promise.reject(Object.assign(new Error('refused'),{code:'MEMORY_CONTEXT_REVOKED'})),sink.raw);
  expect(sink.raw.destroyed).toBe(true);
  const failure=new Error('fixture native failure');
  await expect(completeHttpRequest(Promise.reject(failure),sink.raw)).rejects.toBe(failure);
});
