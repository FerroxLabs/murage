// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {noLimitsProtectedWrite} from './no-limits-protected.ts';
it('explicitly invalid cwd cannot fall back to a protected supplied folder for an ordinary suffix',()=>{
 expect(noLimitsProtectedWrite('tee ./notes',{commandCwd:'/etc',workFolder:'/etc',commandCwdInvalid:true})).toBeNull();
 expect(noLimitsProtectedWrite('tee .ssh/config',{commandCwd:'/etc',workFolder:'/etc',commandCwdInvalid:true})).toMatchObject({rule:'protected-path',classification:'deny'});
});
