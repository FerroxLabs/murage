// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {mcpSchemaWipeHints,recordMcpWipeHints} from './no-limits-wipe-mcp.ts';
for(const [metadata,input,card]of [
 [{name:'perform',annotations:{title:'Delete all owner records'}},{},true],
 [{name:'perform',annotations:{destructiveHint:true}},{scope:'all'},false],
 [{name:'perform',annotations:{destructiveHint:true}},{id:'one'},false],
 [{name:'perform',annotations:{title:'Delete one record'}},{id:'one'},false],
 [{name:'perform',annotations:{readOnlyHint:true}},{scope:'all'},false],
 [{name:'update_all_records',annotations:{destructiveHint:true}},{},false],
 [{name:'perform',annotations:{title:'Update all owner records',destructiveHint:true}},{scope:'all'},false],
 [{name:'perform',annotations:{title:'Read status of a bulk delete'}},{},false],
] as const)it(`W6 schema annotation ${JSON.stringify(metadata)} ${card}`,()=>{
 const f=fixture(),server='annotated',tool=`mcp__annotated__${metadata.name}`;
 expect(recordMcpWipeHints('t',server,mcpSchemaWipeHints([metadata]),true)).toBe(true);
 const extra={tool,toolCall:{name:tool,input},toolEngine:'claude',mcpMounts:[{engineName:server,mountId:'custom:annotated',provenance:'custom'}]};
 expect(d.decide(f.open('metadata',input,extra),baseRun).kind).toBe(card?'card':'run');f.dispose();
});
it('W6 annotations cannot name another thread or a replaced catalog',()=>{
 const hints=mcpSchemaWipeHints([{name:'perform',annotations:{title:'Purge all records'}}]);
 recordMcpWipeHints('other','annotated',hints,true);recordMcpWipeHints('t','annotated',hints,true);recordMcpWipeHints('t','annotated',[],true);
 const f=fixture(),input={},tool='mcp__annotated__perform';
 expect(d.decide(f.open('metadata',input,{tool,toolCall:{name:tool,input},toolEngine:'claude',mcpMounts:[{engineName:'annotated',mountId:'custom:annotated',provenance:'custom'}]}),baseRun).kind).toBe('run');f.dispose();
});
