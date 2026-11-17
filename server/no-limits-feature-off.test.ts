// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {fixture,d} from './decision/fixture.ts';
import {awaitHostComputerConsent,cancelHostComputerConsentForThread,hostConsentRefusal} from './host-computer-consent.ts';
it.each(['ask','auto','full','unlimited'] as const)('08:05 declined Auto host capability stays off at %s without opening a consent card',async level=>{
 const f=fixture(level),bot=f.store.createBot({name:'Off host fixture'},{seedMessages:false});
 bot.hostComputerConsent='declined';
 const bus={store:f.store,broadcast:()=>{},authorityFor:()=>({claim:f.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}})};
 try {
  expect(await awaitHostComputerConsent(bus,bot,'t',25)).toBe('declined');
  expect(d.openApprovals('t')).toHaveLength(0);expect(f.respond).not.toHaveBeenCalled();
 } finally {cancelHostComputerConsentForThread('t');f.dispose();}
});
it('08:05 disabled host capability gives one plain line naming its settings',()=>{
 const result=hostConsentRefusal('declined','Fixture');
 expect(result.content).toEqual([{type:'text',text:expect.stringMatching(/off.*(?:Settings|settings|Computer panel)/)}]);
 expect(result.content[0]!.text.split('\n')).toHaveLength(1);
});
