import { expect, it } from 'vitest';
import { BUILT_IN_DRIVERS } from './drivers/builtIn.ts';
import { WEB_READ_ROUTING, webReadRoutingNotice } from './web-read-routing.ts';
it('every shipped engine has an explicit routing contract or a visible failure', () => {
  expect(Object.keys(WEB_READ_ROUTING).sort()).toEqual(BUILT_IN_DRIVERS.map(d => d.driverKind).sort());
  for (const [driver, row] of Object.entries(WEB_READ_ROUTING)) {
    expect(row.route).toBeTruthy();
    if (row.limitation) expect(webReadRoutingNotice(driver)).toContain(row.limitation);
    else expect(webReadRoutingNotice(driver)).toBeUndefined();
  }
  expect(webReadRoutingNotice('future-engine')).toContain('not enforced');
});
