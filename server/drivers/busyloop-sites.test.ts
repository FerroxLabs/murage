import { expect, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inventory } from '../../scripts/busyloop-sites.mjs';
import { fluxRouteFor } from '../../shared/flux-route.ts';

function evidence(name: string, killed: string[]) {
  if(!process.env.BUSYLOOP_EVIDENCE_DIR)return;
  const dir=join(process.env.BUSYLOOP_EVIDENCE_DIR,'structural-mutants');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,name+'.json'),JSON.stringify({result:'RED',count:killed.length,killed},null,2));
}

it('every driver response site is classified before response decisions', () => {
  const result=inventory();
  expect(result.errors, JSON.stringify(result.sites,null,2)).toEqual([]);
  expect(result.sites.filter(s=>s.kind==='payload').length).toBeGreaterThanOrEqual(14);
}, 30000);

it('removing the entry at every HTTP or payload site makes the inventory RED', () => {
  const result=inventory();expect(result.errors).toEqual([]);const killed:string[]=[];
  for(const site of result.sites.filter(s=>s.kind==='payload')) {
    const file=site.key.split(':')[0],source=readFileSync(file,'utf8');
    const changed=source.slice(0,site.start)+'removedClassifier'+source.slice(site.start+site.entry.length);
    expect(inventory(new Map([[file,changed]])).errors.some(e=>e.startsWith('UNCLASSIFIED '+file)),site.key).toBe(true);killed.push(site.key);
  }
  const files=new Set(result.sites.filter(s=>s.kind==='Flux-capable HTTP').map(s=>s.key.split(':')[0]));
  for(const file of files){
    const source=readFileSync(file,'utf8');
    for(const call of source.matchAll(/\binspectFluxResponse\(/g)) {
      const at=call.index!;
      const changed=source.slice(0,at)+'removedClassifier('+source.slice(at+'inspectFluxResponse('.length);
      expect(inventory(new Map([[file,changed]])).errors.some(e=>e.startsWith('UNCLASSIFIED '+file)),file+':'+at).toBe(true);killed.push(file+':'+at);
    }
  }
  evidence('classifier-entry',killed);
}, 120000);

it('a newly added or renamed Flux socket cannot silently escape the inventory', () => {
  const file='server/drivers/openai-chat.ts',source=readFileSync(file,'utf8');
  const added=source+"\nasync function newSite(){const providerFetch=fetch;const response=await providerFetch('https://api.fluxrouter.ai/v1/responses');return response;}";
  expect(inventory(new Map([[file,added]])).errors.some(e=>e.startsWith('UNROUTED '+file+':providerFetch'))).toBe(true);
});
it('R1 a same-named local function cannot replace the shared route decision', () => {
  const file='server/drivers/openai-chat.ts',source=readFileSync(file,'utf8');
  const changed=source.replace(', fluxRouteFor }', ' }').replace('import { fluxRouteFor }', 'import { fluxRouteFor as unusedRoute }')+'\nfunction fluxRouteFor(requestUrl: string) { return {requestUrl,routed:true}; }';
  expect(inventory(new Map([[file,changed]])).errors).toContain('UNROUTED '+file+':not the shared fluxRouteFor');
});
it('R1 a new native HTTP request alias cannot bypass the URL decision', () => {
  const file='shared/new-model-socket.ts';
  const source="import {request as modelRequest} from 'node:https'; export function send() { return modelRequest('https://api.fluxrouter.ai/v1/responses'); }";
  expect(inventory(new Map([[file,source]])).errors.some(e=>e.startsWith('UNROUTED '+file))).toBe(true);
});
it('R1 inventories request routing across server and shared', () => {
  const result=inventory();expect(result.errors).toEqual([]);
  for(const file of ['codex.ts','claude.ts','openai-chat.ts','http-text-only.ts','headless-text-only.ts','acp/core.ts']) {
    expect(result.sites.some(s=>s.key.startsWith('server/drivers/'+file+':')&&s.kind==='request-route'),file).toBe(true);
  }
  for(const file of ['server/decider/flux.ts','server/voice/voice-host.ts','server/model-gateway.ts']) {
    expect(result.sites.some(s=>s.key.startsWith(file+':')&&s.kind==='request-route'),file).toBe(true);
  }
});
it('R1 bypassing fluxRouteFor at any request construction makes the inventory RED', () => {
  const result=inventory();const killed:string[]=[];
  for(const site of result.sites.filter(s=>s.kind==='request-route')) {
    const file=site.key.split(':')[0],source=readFileSync(file,'utf8'),call=source.slice(site.start,site.end);
    expect(call).toContain('fluxRouteFor(');
    const changed=source.slice(0,site.start)+call.replace('fluxRouteFor(', 'bypassFluxRoute(')+source.slice(site.end);
    expect(inventory(new Map([[file,changed]])).errors.some(e=>e.startsWith('UNROUTED '+file)),site.key).toBe(true);killed.push(site.key);
  }
  evidence('request-route',killed);
}, 120000);
it('R2 discovers payload markers without a hand list, and rejects every deleted marker', () => {
  expect(readFileSync('scripts/busyloop-sites.mjs','utf8')).not.toContain('const payloads=[');
  const killed:string[]=[];
  const files=new Set(inventory().sites.filter(s=>s.kind==='payload'||s.kind==='payload-read').map(s=>s.key.split(':')[0]));
  for(const file of files) {
    const source=readFileSync(file,'utf8');
    for(const match of source.matchAll(/\bregisterBusyloopPayloadSite\(/g)) {
      const at=match.index!;
      const changed=source.slice(0,at)+'unmarkedPayload('+source.slice(at+'registerBusyloopPayloadSite('.length);
      expect(inventory(new Map([[file,changed]])).errors.some(e=>e.startsWith('UNCLASSIFIED '+file)||e.startsWith('UNMARKED PAYLOAD '+file)),file+':'+at).toBe(true);killed.push(file+':'+at);
    }
  }
  evidence('payload-marker',killed);
}, 120000);
it('R2 adding an unmarked payload read is RED', () => {
  for(const file of ['server/drivers/openai-chat.ts','server/drivers/codex.ts','shared/flux-route.ts']) {
    const source=readFileSync(file,'utf8');
    const added=source+'\nfunction addedPayload(line: string) { const payload=JSON.parse(line); return payload.error; }';
    expect(inventory(new Map([[file,added]])).errors.some(e=>e.startsWith('UNMARKED PAYLOAD '+file))).toBe(true);
  }
});
it('R2 a new source file cannot add an unmarked model payload reader', () => {
  expect(inventory(new Map([['shared/new-model-reader.ts', 'export const read = (text: string) => JSON.parse(text);']])).errors.some(e=>e.startsWith('UNMARKED PAYLOAD shared/new-model-reader.ts'))).toBe(true);
});
it('R1 URL alone decides Flux scope, including custom presets and bare apex', () => {
  const request=new Request('https://api.fluxrouter.ai/v1/responses',{method:'POST',body:'fixture'});
  expect(fluxRouteFor(request)).toEqual({requestUrl:request,routed:true});expect(request.bodyUsed).toBe(false);
  for(const url of ['https://api.fluxrouter.ai/v1','https://fluxrouter.ai/v1','https://API.FLUXROUTER.AI./anthropic'])expect(fluxRouteFor(url).routed,url).toBe(true);
  for(const url of ['https://api.openai.com/v1','https://api.anthropic.com','https://generativelanguage.googleapis.com','https://fluxrouter.ai.evil.invalid','https://other.invalid/fluxrouter.ai','file://api.fluxrouter.ai/v1',undefined])expect(fluxRouteFor(url).routed,String(url)).toBe(false);
});

it('R3 every transport sink has a route decision or a typed reason', async () => {
  const { sinkInventory } = await import('../../scripts/busyloop-sinks.mjs');
  const result = sinkInventory();
  expect(result.errors).toEqual([]);
  for (const file of ['antigravity.ts', 'pi.ts']) {
    expect(result.sinks.some(s => s.file === 'server/drivers/' + file && s.kind === 'model-request' && s.guarded)).toBe(true);
  }
  if (process.env.BUSYLOOP_EVIDENCE_DIR) {
    mkdirSync(process.env.BUSYLOOP_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.BUSYLOOP_EVIDENCE_DIR, 'transport-sinks.json'), JSON.stringify(result, null, 2));
  }
}, 60000);

it('R3 adding an unmarked byte sink in ANY driver is RED', async () => {
  const { sinkInventory } = await import('../../scripts/busyloop-sinks.mjs');
  const control = sinkInventory();
  expect(control.errors).toEqual([]);
  const files = Object.keys(control.drivers);
  const changes = new Map(files.map(file => [file, readFileSync(file, 'utf8') + '\nfunction r3UnmarkedSink(child: import("node:child_process").ChildProcessWithoutNullStreams) { child.stdin.write(`opaque serialized bytes`); }\n']));
  const mutant = sinkInventory(changes);
  for (const file of files) expect(mutant.errors.some(e => e.startsWith('UNROUTED SINK ' + file + ':')), file).toBe(true);
  evidence('r3-added-sink-every-driver', files);
}, 120000);

it('R3 marker-typed receivers, SDK and HTTP aliases cannot escape sink discovery', async () => {
  const { sinkInventory } = await import('../../scripts/busyloop-sinks.mjs');
  const file = 'server/drivers/r3-new-transport.ts';
  const source = `
import type { EngineTransport } from '../../shared/engine-transport.ts';
import { request as wireRequest } from 'node:https';
import * as native from 'node:http';
import { fetch as wireFetch } from 'undici';
import OpenAI from 'openai';
interface RenamedTransport extends EngineTransport { send(bytes: string): void; write(bytes: string): void }
export function added(transport: RenamedTransport, sdk: OpenAI, socket: WebSocket, legacy: any) {
 const alias = transport;
 alias.send('opaque'); alias.write('opaque'); alias['send']('opaque');
 const boundSend = alias.send.bind(alias); boundSend('opaque');
 wireRequest('https://api.fluxrouter.ai/v1/responses');
 native.get('http://provider.invalid'); socket.send('opaque'); legacy.send('opaque');
 wireFetch('https://api.fluxrouter.ai/v1/responses');
 sdk.responses.create({model:'fixture', input:'hi'});
}
class UnmarkedTransport { send(bytes: string) { void bytes; } }
`;
  const result = sinkInventory(new Map([[file, source]]));
  for (const entry of ['alias.send', 'alias.write', "alias['send']", 'boundSend', 'wireRequest', 'native.get', 'socket.send', 'legacy.send', 'wireFetch', 'sdk.responses.create']) {
    expect(result.sinks.some(s => s.file === file && s.entry === entry && !s.guarded), entry).toBe(true);
  }
  expect(result.errors).toContain('UNMARKED TRANSPORT '+file+':UnmarkedTransport');
}, 60000);

it('R3 deleting Antigravity or Pi route decisions makes their sinks RED', async () => {
  const { sinkInventory } = await import('../../scripts/busyloop-sinks.mjs');
  for (const driver of ['antigravity', 'pi']) {
    const file = 'server/drivers/' + driver + '.ts';
    const source = readFileSync(file, 'utf8').replaceAll('fluxRouteFor(', 'bypassFluxRoute(');
    const result = sinkInventory(new Map([[file, source]]));
    expect(result.errors.some(e => e.startsWith('UNROUTED SINK ' + file + ':')), file).toBe(true);
  }
}, 120000);
