import {readFileSync} from 'node:fs';
import {expect,test} from 'vitest';
test('AFIX L1 consolidated English inventory includes shared copy, CLI, renderer and startup diagnostics',()=>{
 const inventory=readFileSync(new URL('../../../docs/verification/signal-park-english.md',import.meta.url),'utf8');
 for(const name of ['shared/signal-kept-copy.ts','server/channels/signal/park-downgrade.ts']){
  const source=readFileSync(new URL('../../../'+name,import.meta.url),'utf8');
  const strings=[...source.matchAll(/(['"])([^'"\n]+)\1/g)].map(m=>m[2]).filter(s=>s.includes(' ')&&/^(?:Murage|Signal|Your|The|No) /.test(s));
  for(const text of strings)expect(inventory,`${name}: ${text}`).toContain(text);
 }
 for(const text of ['Keep both and link again','Murage paused Signal to preserve your connection.','Murage also kept an earlier Signal link in your data folder. In Signal on your phone, open Settings, Linked devices and remove the older Murage entry.','Murage kept the earlier Signal files in your data folder. To use Signal here, link it again. Then remove the older Murage entry under Linked devices in Signal on your phone.','Murage also kept earlier Signal files in your data folder.','Signal files are kept. This disk cannot confirm directory updates after power loss.','Signal files are kept','Signal hold is unavailable','Signal authority is held','Signal authority save is held'])expect(inventory).toContain(text);
});
