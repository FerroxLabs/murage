import { expect, it } from 'vitest';
import { browserGuardSet, canMoveAutomatically, resolveBrowserDestination, ownerMoveDisclosure, browserTurnContext, proposeYourChromeRoute } from './browser-mode-policy.ts';
const modes = ['builtin', 'chrome-extension', 'chrome-direct'] as const;
for (const from of modes) for (const to of modes) for (const approval of ['step','task','full'] as const) {
  it(`EP B7 guards ${from} -> ${to} / ${approval}`, () => {
    expect(canMoveAutomatically(from, to)).toBe(from === to);
    expect(browserGuardSet(to).floor).toBe(true);
    expect(browserGuardSet(to).siteScope).toBe(to === 'chrome-extension');
    expect(browserGuardSet(to).askLevels).toBe(to === 'chrome-extension');
    const destination = resolveBrowserDestination({ id:'a', name:'Ava' }, { mode:to });
    const disclosure = ownerMoveDisclosure({ mode:from, revision:0 }, destination, approval);
    expect(disclosure.lines.join(' ')).toContain('From now on');
    if (from === 'chrome-extension' && to !== from) {
      expect(disclosure.lines.join(' ')).toContain("doesn't ask per site");
      if (approval === 'step') expect(disclosure.lines[0]).toBe('Ava will stop asking each step.');
    }
  });
}
for (const choice of [{mode:'builtin'}, {mode:'builtin',profile:'work'}, {mode:'builtin',profile:'guest'}, {mode:'chrome-extension',profile:'personal',browser:'edge'}, {mode:'chrome-direct'}] as const) {
  it(`T5/EP20 owner and turn agree for ${JSON.stringify(choice)}`, () => {
    const destination = resolveBrowserDestination({id:'a',name:'Ava'}, choice, { profiles:[{id:'work',name:'Work'}], bots:[{id:'k',name:'Kai',browserProfile:'work'}] });
    const disclosure = ownerMoveDisclosure({mode:'chrome-extension',revision:3}, destination, 'task');
    const context = browserTurnContext({ ...destination, revision:4, readiness:{kind:'ready'} });
    expect(disclosure.lines.join(' ')).toContain(destination.profileLabel);
    expect(context).toContain(destination.profileLabel);
    expect(context).toContain(destination.mayBeSignedIn ? 'may already be signed in' : 'starts empty');
    expect(disclosure.lines.join(' ')).toContain(destination.mayBeSignedIn ? 'may still be signed in' : 'starts empty');
    expect(destination.presentation).toBe('panel');
    expect(ownerMoveDisclosure({mode:'chrome-extension',revision:4}, destination, 'task').disclosureKey).not.toBe(disclosure.disclosureKey);
  });
}
it('T4/M12 route proposal uses pairing for the chosen browser only', () => {
  expect(proposeYourChromeRoute({browserExtensionBrowser:'edge'}, [{profileId:'chrome',browser:'chrome'}])).toBe('chrome-direct');
  expect(proposeYourChromeRoute({}, [{profileId:'chrome',browser:'chrome'}])).toBe('chrome-extension');
});
it('T5 a window presentation keeps the same profile disclosure and tells the turn it is paused',()=>{
 const destination={...resolveBrowserDestination({id:'a',name:'Ava'},{mode:'builtin',profile:'work'},{profiles:[{id:'work',name:'Work'}]}),presentation:'window' as const};
 expect(ownerMoveDisclosure({mode:'builtin',revision:1},destination).lines.join(' ')).toContain('Work');expect(browserTurnContext({...destination,revision:1,readiness:{kind:'ready'}})).toContain('window; you are paused');
});
it('M12 every proposed direct choice for Ask each step starts with the warning',()=>{
 for(const mode of modes){const destination=resolveBrowserDestination({id:'a',name:'Ava'},{mode:'chrome-direct'});expect(ownerMoveDisclosure({mode,revision:0},destination,'step').lines[0]).toBe('Ava will stop asking each step.');}
});
it('the resolved extension destination names the one paired profile in the chosen browser',()=>{
 const destination=resolveBrowserDestination({id:'a',name:'Ava'},{mode:'chrome-extension',browser:'edge'},{chromeProfiles:[{profileId:'personal',browser:'edge',name:'Personal'},{profileId:'other',browser:'chrome',name:'Other'}]});
 expect(destination).toMatchObject({profile:'personal',profileLabel:'Personal',browser:'edge'});
 expect(browserTurnContext({...destination,revision:1,readiness:{kind:'ready'}})).toContain('Personal');
});
