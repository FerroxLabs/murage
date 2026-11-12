import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserModeStorage } from './browser-mode-storage.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))removeTempDirSync(d);});
const directory=()=>{const d=mkdtempSync(join(tmpdir(),'murage-choices-'));dirs.push(d);return join(d,'modes.json');};
it('EP migration keeps offline paired, unfinished, named and Guest; only first direct survives',()=>{
 const file=directory(), bots:any[]=[{id:'paired',name:'A',useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:'offline',browserExtensionBrowser:'edge',browserApproval:'step'},{id:'setup',name:'B',useMyChrome:true,browserTransport:'extension'}, {id:'direct1',name:'C',useMyChrome:true},{id:'direct2',name:'D',useMyChrome:true,browserProfile:'work'},{id:'own',name:'E'},{id:'named',name:'F',browserProfile:'work'},{id:'guest',name:'G',browserProfile:'guest'},{id:'ambiguous',name:'H',useMyChrome:true,browserTransport:'mystery',browserExtensionProfileId:'keep'}];
 const before=structuredClone(bots[7]);const store=new BrowserModeStorage(file);store.load(bots);
 expect(bots.map(b=>b.browserMode)).toEqual(['chrome-extension','chrome-extension','chrome-direct','builtin','builtin','builtin','builtin',undefined]);
 expect(bots[0]).toMatchObject({browserExtensionProfileId:'offline',browserExtensionBrowser:'edge',browserApproval:'step'});expect(bots[7]).toEqual(before);expect(bots[3].browserProfile).toBe('work');
 expect(store.reservation).toEqual({botId:'direct1',revision:0,state:'held'});
 const saved=readFileSync(file,'utf8');new BrowserModeStorage(file).load(bots);expect(readFileSync(file,'utf8')).toBe(saved);
});
it('EP migration save failure publishes no field or done marker',()=>{
 const file=directory(),bots:any[]=[{id:'a',name:'A',useMyChrome:true,browserTransport:'extension'}],before=structuredClone(bots),write=vi.fn(()=>{throw new Error('disk');});
 expect(()=>new BrowserModeStorage(file,write).load(bots)).toThrow('disk');expect(bots).toEqual(before);expect(write).toHaveBeenCalledTimes(1);
});
it('T2/T3 restart after C restores selection, release and releasing reservation in one write',()=>{
 const file=directory(),bots:any[]=[{id:'a',name:'A',useMyChrome:true}],store=new BrowserModeStorage(file);store.load(bots);
 store.commit(bots[0],{browserMode:'builtin',useMyChrome:undefined,selectionRevision:1,browserSelectionRevision:1,browserRelease:{mode:'chrome-direct',revision:0,key:'direct-a'}},{botId:'a',revision:0,state:'releasing'});
 const restarted:any[]=[{id:'a',name:'A',useMyChrome:true}],loaded=new BrowserModeStorage(file);loaded.load(restarted);
 expect(restarted[0]).toMatchObject({browserMode:'builtin',selectionRevision:1,browserRelease:{mode:'chrome-direct'}});expect(restarted[0].useMyChrome).toBeUndefined();expect(loaded.reservation?.state).toBe('releasing');
});
it('a deleted bot releases its durable direct reservation and cannot reappear on restart',()=>{
 const file=directory(),bots:any[]=[{id:'a',name:'A',useMyChrome:true}],store=new BrowserModeStorage(file);store.load(bots);store.remove('a');expect(store.reservation).toBeUndefined();
 const fresh:any[]=[{id:'b',name:'B',useMyChrome:true}],restart=new BrowserModeStorage(file);restart.load(fresh);expect(restart.reservation?.botId).toBe('b');
});
