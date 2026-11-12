import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const shard=process.argv[2];
if(!/^\d+\/\d+$/.test(shard??''))throw Error('Provide shard n/total');
const selected=/gnl-apps|bot-access|connected-app|connector-|composio|mcp-|host-computer-consent|auto-computer-consent|service-no-limits|no-limits|nolimits|approval|full-access-options|channel-reply|channel-queue|folder-trust|procedure-bundles|skill-library|native-wins/;
const files=['server','shared','src','companion','electron'].flatMap(dir=>readdirSync(dir,{recursive:true}).filter(name=>(name.endsWith('.test.ts')||name.endsWith('.test.mjs'))&&selected.test(name.split('/').at(-1))).map(name=>dir+'/'+name)).sort();
mkdirSync('evidence/gnl-apps-gate',{recursive:true});
writeFileSync('evidence/gnl-apps-gate/files.json',JSON.stringify(files,null,2));
const args=['exec','vitest','run',...files,`--shard=${shard}`,'--reporter=default','--reporter=json',`--outputFile=evidence/gnl-apps-gate/shard-${shard.replace('/','-')}.json`];
console.log('GNL gate:',files.length,'files, shard',shard);
const result=spawnSync('pnpm',args,{stdio:'inherit',env:process.env});
if(result.status!==0)process.exit(result.status??1);
if(shard.startsWith('1/')) {
 const nodeFiles=['electron','shared'].flatMap(dir=>readdirSync(dir,{recursive:true}).filter(name=>name.endsWith('.node-test.mjs')&&/approval/i.test(name)).map(name=>dir+'/'+name));
 const node=spawnSync(process.execPath,['--import','./server/testing/safe-wipe-preload.mjs','--test',...nodeFiles],{stdio:'inherit',env:process.env});
 process.exit(node.status??1);
}
process.exit(0);
