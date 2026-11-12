import {expect,it} from 'vitest';
import {noLimitsWipe} from './no-limits-wipe.ts';
it('EARLY-WIPE a guarded variable assigned the home directory remains a named home wipe',()=>{
 expect(noLimitsWipe('nolim_wipe=~; rm -rf "${nolim_wipe:?}"',{cwd:'/fixture/work',home:'/fixture/home'})?.rule).toBe('delete-home');
});
it.each(['rm -rf "$UNKNOWN"','rm -rf "${UNKNOWN:?}"','find "$UNKNOWN" -delete'])('EARLY-UNKNOWN unresolved deletion runs without named catastrophe: %s',command=>{
 expect(noLimitsWipe(command,{cwd:'/fixture/work',home:'/fixture/home'})).toBeNull();
});
