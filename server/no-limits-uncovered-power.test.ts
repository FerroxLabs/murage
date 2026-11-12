// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {hostPowerDeps,hostPowerProbeDeps,planHostPower,SEATBELT_POWER_PROFILE} from './host-power.ts';
afterEach(()=>vi.restoreAllMocks());
it('D2 No limits AppleEvents run while lower levels retain the current profile',()=>{
 vi.spyOn(hostPowerDeps,'platform').mockReturnValue('darwin');
 vi.spyOn(hostPowerProbeDeps,'runSync').mockReturnValue({code:0,stderr:''} as any);
 // No actual Mac command is run: only inspect the launch plan.
 const old=hostPowerDeps.sandboxExec;hostPowerDeps.sandboxExec=process.execPath;
 let plan;try{plan=planHostPower('/usr/bin/fixture',[],{PATH:'/usr/bin'},process.cwd(),{});}finally{hostPowerDeps.sandboxExec=old;}
 expect(plan.kind).toBe('seatbelt');
 if(plan.kind==='seatbelt')expect(plan.args[1]).not.toContain('(deny appleevent-send');
 expect(SEATBELT_POWER_PROFILE).toContain('(deny appleevent-send');
});
