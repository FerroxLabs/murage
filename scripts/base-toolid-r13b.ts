import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The container extracts the ENTIRE pinned server/shared tree; using current
// dependencies with only a pinned auto-approve.ts would not prove base parity.
const baseRoot = process.env.TOOLID_BASE_ROOT;
if (!baseRoot) throw new Error('TOOLID_BASE_ROOT must name the isolated 1.0.18 source tree');
const sourceSha256 = createHash('sha256').update(readFileSync(resolve(baseRoot,'server/auto-approve.ts'))).digest('hex');
assert.equal(sourceSha256, '7663ae7a06a84b14e6336ec1d03ccdeaecfeccee07c283cadb9624bde7ee352b', 'base policy pin');
assert.equal(JSON.parse(readFileSync(resolve(baseRoot,'package.json'),'utf8')).version, '1.0.18');
const { autoVerdict } = await import(pathToFileURL(resolve(baseRoot, 'server/auto-approve.ts')).href);
const contexts = {
 delegatedOwnerOrigin: { fullAccessOrigin:'owner', ownerStarted:false, outsideRead:null, commandCwd:'/w' },
 manualRoutine: { fullAccessOrigin:'routine', ownerStarted:false, automated:true, routineLevel:true, outsideRead:null, commandCwd:'/w' },
 scheduledRoutine: { fullAccessOrigin:'routine', ownerStarted:false, automated:true, routineLevel:true, outsideRead:null, commandCwd:'/w' },
 ownerLowerLevels: {fullAccessOrigin:'owner', ownerStarted:true, outsideRead:null, commandCwd:'/w'},
 routineKnownCwd: { automated: true, routineLevel: true, stopLine: null, commandCwd:'/w' },
 routineStop: { automated: true, routineLevel: true, stopLine: {kind:'delete',place:'/Users/ada/Documents',what:'Delete 1 item outside its folder: ~/Documents/x'} },
 routine: { automated: true, routineLevel: true, stopLine: null },
 channel: { fullAccessOrigin: 'owner-channel', channelOwner: true, unattended: true },
 webhook: { fullAccessOrigin: 'other', unattended: true },
 delegated: { fullAccessOrigin: 'other', automated: true },
 other: { fullAccessOrigin: 'other' },
 unproven: {},
};
const levels = [{}, {autoApprove:true}, {autoApprove:true, fullAccess:true}, {autoApprove:true, fullAccess:true, noLimits:true}];
const commands = ['printf ready', 'rm -rf build', 'rm -rf ~/Documents/x', "open('/w/README.md').read()", 'rm -rf /', 'cat ~/.ssh/id_rsa'];
const rows = [];
for (const [origin, context] of Object.entries(contexts)) for (const bot of levels) for (const command of commands) {
 if(origin==='ownerLowerLevels' && bot.noLimits) continue;
 const input = {bot, tool:'Bash', summary:command, context};
 rows.push({id:`${origin}-${rows.length}`, ...input, expected:autoVerdict(bot, input.tool, command, context as any)});
}
// The code-reader's Python whitespace rule must not change legacy callers.
for (const [origin, context] of Object.entries(contexts)) for (const bot of levels) {
 if(origin==='ownerLowerLevels' && bot.noLimits) continue;
 for (const blank of ['\u001c','\u0085','\ufeff']) {
  const row = {bot, tool:'Bash', summary:'neutral', context:{...context,call:{toolCall:{name:'Bash',input:{command:blank,cmd:'rm -rf /',cwd:'/w'}}}}};
  rows.push({id:`${origin}-whitespace-${rows.length}`,...row,expected:autoVerdict(bot,row.tool,row.summary,row.context as any)});
 }
}
writeFileSync('server/testing/fixtures/no-limits-r13b-base.json', JSON.stringify({commit:'292df98d80a1c55db3e6f232166fc05162b632ab', sourceSha256, rows}, null, 2)+'\n');
