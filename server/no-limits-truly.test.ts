// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean ruling 2026-11-12 02:05Z: keep only the wipe check. Sanitized log shapes;
// command strings are permission data, never executed.
import { describe, expect, it, vi } from 'vitest';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
const NL = { autoApprove:true, fullAccess:true, noLimits:true, fullAccessChannelMessages:true };
const FULL = { ...NL, noLimits:false };
const origins: Record<string, Partial<AutoContext>> = {
 owner:{fullAccessOrigin:'owner',ownerStarted:true},
 channel:{fullAccessOrigin:'owner-channel',channelOwner:true,automated:true,unattended:true},
 routine:{fullAccessOrigin:'routine',routineLevel:true,channelOwner:false,automated:true,unattended:true},
};
function ctx(command?:string, extra:Partial<AutoContext>={}):AutoContext {
 return {commandText:command,commandCwd:'/tmp/fixture',workFolder:'/tmp/fixture',stopLine:null,
  outsideRead:null,promptFacts:{cwd:'/tmp/fixture',home:'/home/fixture'},unseen:{platform:'posix'},...origins.owner,...extra};
}
function verdict(command:string, extra:Partial<AutoContext>={}, bot=NL){return autoVerdict(bot,'Bash',command,ctx(command,extra));}
// W3 (2026-11-12): only a final unresolved eval cards; compound unread work remains the frozen r3 behavior.
export const replayRows: Array<{id:string;command:string;context?:Partial<AutoContext>}> = [
 {id:'F1 outside-turn',command:'touch notes.md',context:{outsideRead:['web page']}},
 {id:'F2 unread unmodeled',command:'eval "$UNMODELED"; echo ok'},
 {id:'F2 unread reader-failed',command:'python3 -c "import ctypes; ctypes.CDLL(None)"'},
 {id:'F2 unread tokenizer',command:'echo "unterminated'},
 {id:'F3 key-row',command:'printf x > ~/.ssh/id_ed25519'},
 {id:'F3 protected-path',command:'touch /etc/fixture-policy'},
 {id:'F3 sensitive-guard',command:'cat .env.production'},
 {id:'F3 home-glob',command:'ls ~/*'},
 {id:'F4 truncated',command:'printf ok',context:{inputTruncated:true}},
 {id:'F4 U19',command:'PAGER=less git log'},
 {id:'F4 U20',command:'printf ok',context:{envUnread:'tokenizer'}},
 {id:'F5 refusal',command:'mystery-tool /etc'},
 {id:'F5 stop-line',command:'touch notes.md',context:{stopLine:{kind:'message',what:'new recipient'} as AutoContext['stopLine']}},
 {id:'F6 no-grant',command:'eval "$ROUTINE"; echo ok',context:origins.routine},
];
for(const [origin, flags] of Object.entries(origins)) describe(origin,()=>{
 for(const row of replayRows)it(row.id,()=>expect(verdict(row.command,{...flags,...row.context}).approve).toBeTruthy());
 for(const command of ['printf x > ~/.ssh/id_ed25519','touch /etc/fixture-policy'])it(`F1 tainted protected write ${command} runs`,()=>expect(verdict(command,{...flags,outsideRead:['web page']}).approve).toBeTruthy());
 for(const command of ['rm -rf ~','rm -rf /','rm -rf /tmp/fixture','mkfs.ext4 /dev/fixture','git push --force origin HEAD:main',"psql -c 'DROP TABLE fixture'",'sqlite3 fixture.db "TRUNCATE TABLE fixture"','rm -rf ~/backups'])
 for(const state of ['plain','tainted','unreadable'] as const)it(`F8 wipe ${state} ${command}`,()=>{
  const extra:Partial<AutoContext>=state==='tainted'?{outsideRead:['web page']}:state==='unreadable'?{inputTruncated:true}:{};
  const text=state==='unreadable'?`eval "$OPAQUE"; ${command}`:command;
  expect(verdict(text,{...flags,...extra}).approve).toBeNull();
 });
});
it('F2 thrown reader still checks visible text',()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 try {for(const command of ['printf ok','printf x > ~/.ssh/id_ed25519','rm -rf ~']) {
  const context=ctx(undefined);
  Object.defineProperty(context,'commandText',{get(){throw Error('synthetic reader');}});
  expect(autoVerdict(NL,'Bash',command,context).approve===null,command).toBe(command==='rm -rf ~');
 }}finally{vi.restoreAllMocks();}
});
it('F5 own-tool without grant runs',()=>expect(autoVerdict(NL,'mcp__murage__publish_site','Publish site',ctx()).approve).toBeTruthy());
it('G-NL Full access twins remain unchanged',()=>{
 expect(replayRows.map(row=>({id:row.id,verdict:verdict(row.command,row.context,FULL)}))).toMatchSnapshot();
});
