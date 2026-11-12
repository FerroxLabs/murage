import { it, expect } from 'vitest';
import { browserPopoutBot } from './BrowserPopout';
it('routes only the named surface with a bounded bot id in the desktop bridge', () => {
  expect(browserPopoutBot('?surface=browser-popout&bot=ava', true)).toBe('ava');
  for (const query of ['', '?surface=other&bot=ava','?surface=browser-popout&bot=../ava','?surface=browser-popout']) expect(browserPopoutBot(query, true)).toBeNull();
  expect(browserPopoutBot('?surface=browser-popout&bot=ava', false)).toBeNull();
});
