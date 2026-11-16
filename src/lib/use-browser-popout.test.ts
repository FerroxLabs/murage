import { afterEach, expect, it, vi } from 'vitest';
import { browserPopoutBot, popoutBridge } from './use-browser-popout';
afterEach(()=>vi.unstubAllGlobals());
it('routes a pop-out with only the Cloud bridge and uses that same bridge',()=>{
  const bridge={close:vi.fn(),currentState:vi.fn()};
  vi.stubGlobal('window',{muragecloud:{browserPopout:bridge}});
  expect(popoutBridge()).toBe(bridge);
  expect(browserPopoutBot('?surface=browser-popout&bot=ava',Boolean(window.muragebox)||Boolean(window.muragecloud?.browserPopout))).toBe('ava');
});
