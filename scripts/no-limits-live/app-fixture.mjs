import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessRoleBinding } from '../../server/bot-access-role.ts';
// Only called while the runner's own isolated server is stopped. This is a
// persisted-state fixture, not a new product endpoint or a connected account.
export function writeAppDenial(dataDir,botId,source) {
  if(!['request-denied','grant-revoked'].includes(source))throw Error('Unknown fixture denial');
  const path=join(dataDir,'bots.json'),bots=JSON.parse(readFileSync(path,'utf8'));
  const bot=bots.find(b=>b.id===botId);if(!bot)throw Error('Fixture bot missing');
  bot.composio=true;
  bot.connectedAppAccess={revision:1,roleBinding:accessRoleBinding(bot),mode:'restricted',allowWrites:false,grants:[],requests:[],
    denials:[{id:'fixture-denial',toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL'],ops:['write'],source,at:Date.now(),revision:1}]};
  writeFileSync(path,JSON.stringify(bots)+'\n',{mode:0o600});
}
