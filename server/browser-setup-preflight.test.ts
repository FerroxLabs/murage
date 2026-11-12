import {expect,it,vi} from 'vitest';
import {browserSetupPreflight} from './browser-setup-preflight.ts';
for(const browser of ['chrome','edge','brave'] as const)for(const route of ['chrome-extension','chrome-direct'] as const){
 it(`preflight checks chosen ${browser} for ${route}`,async()=>{
  const command=vi.fn(async(_file:string,_args:string[])=>route==='chrome-extension'?'150.0.1.2':'143.0.1.2');
  const result=await browserSetupPreflight({browser,route,platform:'darwin',command});
  expect(result).toMatchObject({browser,minimum:route==='chrome-extension'?151:144,status:'update_required'});
  expect(command.mock.calls[0]?.[1]).toContain(`/Applications/${browser==='chrome'?'Google Chrome':browser==='edge'?'Microsoft Edge':'Brave Browser'}.app/Contents/Info.plist`);
 });
}
it('a supported version is ready, and an unreadable version never pretends checked',async()=>{
 expect(await browserSetupPreflight({browser:'chrome',route:'chrome-direct',platform:'linux',command:async()=> 'Google Chrome 144.0.1.2'})).toMatchObject({status:'supported',major:144});
 expect(await browserSetupPreflight({browser:'chrome',route:'chrome-extension',platform:'linux',command:async()=>{throw new Error('missing');}})).toMatchObject({status:'unknown'});
});
it('a Cloud home cannot check the owner computer and never probes its own installed browser',async()=>{
 const command=vi.fn(async(_file:string,_args:string[])=> '151.0.1.2');expect(await browserSetupPreflight({browser:'chrome',route:'chrome-extension',cloudHome:true,command})).toMatchObject({status:'unknown'});expect(command).not.toHaveBeenCalled();
});
it('Windows reads only the chosen browser version registry and accepts a supported value',async()=>{
 const command=vi.fn(async(_file:string,_args:string[])=> 'version REG_SZ 151.0.1.2');expect(await browserSetupPreflight({browser:'edge',route:'chrome-extension',platform:'win32',command})).toMatchObject({status:'supported',major:151});expect(command.mock.calls[0]?.[1]).toContain('HKCU\\Software\\Microsoft\\Edge\\BLBeacon');
});
