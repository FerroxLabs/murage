import {expect,it} from 'vitest';
import {directReadiness} from './browser-direct-readiness.ts';
// Every observation is independent: a stale endpoint does not prove Chrome is open.
for(const running of [false,true,'unknown'] as const)for(const listening of [false,true])for(const connection of ['absent','waiting','allowed','closed'] as const){
 it(`direct readiness running=${running} listening=${listening} connection=${connection}`,()=>{
  const result=directReadiness({running,listening,connection});
  expect(result).toBe(connection==='allowed'&&listening?'ready':running===false?'chrome_closed':!listening?running===true?'debugging_off':'chrome_status_unknown':'allow_not_given');
 });
}
import {directConnectionState,chromeRunning} from './browser-direct-readiness.ts';
it('Chrome restart discards Allow evidence from the old endpoint',()=>{
 const proxy={chromeEndpoint:'old',state:'allowed'};
 expect(directConnectionState(proxy,'old')).toBe('allowed');
 expect(directConnectionState(proxy,'new')).toBe('absent');
 expect(directConnectionState(proxy,null)).toBe('absent');
});
it.each(['linux','darwin','win32'] as const)('%s unreadable process evidence stays unknown',async platform=>{
 expect(await chromeRunning(platform,async()=>{throw new Error('unreadable');})).toBe('unknown');
});
