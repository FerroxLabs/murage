import {expect,it} from 'vitest';
import {autoHostDeclined} from './host-computer-consent.ts';
// Stored consent is a permission rule; the Computer destination is the capability switch.
it('EARLY-HOST stored Declined cannot remove a No limits host mount',()=>{
 const denied={hostComputerConsent:'declined' as const,autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
 expect(autoHostDeclined(denied,'owner')).toBe(false);
 expect(autoHostDeclined({...denied,noLimits:false},'owner')).toBe(true);
 expect(autoHostDeclined(denied,'unproven')).toBe(true);
 expect(autoHostDeclined({...denied,computer:'off'},'owner')).toBe(false);
});
