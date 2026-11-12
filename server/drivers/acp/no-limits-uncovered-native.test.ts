// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture the real driver's launch hooks; no CLI is installed or executed.
import {expect,it,vi} from 'vitest';
vi.mock('./core.ts',()=>({createAcpDriver:(support:unknown)=>support}));
import {GrokAgentDriver} from './grok.ts';
import {CopilotAgentDriver} from './copilot.ts';
import {DroidAgentDriver} from './droid.ts';
import {QwenAgentDriver} from './qwen.ts';
import {openCodeTurnPermission} from './opencode-go.ts';
const turn={threadId:'fixture',text:'fixture',noLimits:true,integrations:{agents:{command:'node',args:[]}}};
for(const [name,driver,flag]of [['Grok',GrokAgentDriver,'WebFetch'],['Copilot',CopilotAgentDriver,'--excluded-tools=web_fetch'],['Droid',DroidAgentDriver,'FetchUrl'],['Qwen',QwenAgentDriver,'--exclude-tools=web_fetch']]as const){
 it(`B4 B10 ${name} No limits never silently excludes native web fetching; lower levels retain policy`,()=>{
  const support=driver as any,ctx={env:{},cliVersion:name==='Grok'?'1.0.62':'1.0.0',mcpServerNames:[]};
  const nl=support.spawnArgs({fullAuto:false},turn,ctx);
  expect(nl).not.toContain(flag);
  const lower=support.spawnArgs({fullAuto:false},{...turn,noLimits:false},ctx);
  expect(lower).toContain(flag);
 });
}
it('B10 OpenCode routes native webfetch through the broker at No limits and keeps lower-level substitution',()=>{
 expect((openCodeTurnPermission as any)(true).webfetch).toBe('ask');
 expect(openCodeTurnPermission().webfetch).toBe('deny');
});
