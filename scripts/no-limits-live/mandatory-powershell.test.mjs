import { expect, it } from 'vitest';
import { autoVerdict } from '../../server/auto-approve.ts';
import { noLimits, context } from './mandatory-fixture.mjs';
// Replaces No limits fail-closed expectations in powershell-fail-closed-104.
// Lower-level tests stay in the ordinary product suite.
it.each(['Set-Content -LiteralPath .\\fixture.txt -Value fixture', '$opaque = Get-Date; & $opaque', 'cmd /c echo fixture'])('non-wipe PowerShell/cmd runs: %s',command=>{
  const c=context(command,{inputTruncated:true,envUnchecked:{reason:'fixture'},
    call:{engine:'codex',toolCall:{name:'PowerShell',input:{command}}}});
  expect(autoVerdict(noLimits,'PowerShell',command,c).approve).not.toBeNull();
});
