import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function legacyRecord(profile) {
  const copy=structuredClone(profile);delete copy.permissionExplicit;
  for(const task of copy.tasks??[])delete task.permissionExplicit;
  return copy;
}
// Caller must stop its owned fixture server first. Never used on a live app.
export function writeLegacyBot(dataDir,botId) {
  const file=join(dataDir,'bots.json'),bots=JSON.parse(readFileSync(file,'utf8'));
  if(!Array.isArray(bots)||bots.filter(b=>b.id===botId).length!==1)throw Error('Legacy fixture bot not found');
  writeFileSync(file,JSON.stringify(bots.map(b=>b.id===botId?legacyRecord(b):b))+'\n',{mode:0o600});
}
