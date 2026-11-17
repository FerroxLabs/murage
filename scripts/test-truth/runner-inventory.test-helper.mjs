// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: MAIN owns the frozen legacy list L and the legacy defect class inside it (L can only shrink);
// tafix-r4a owns discovery, adapters and the witnesses that read this file.
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

// Runners routed through intendedAssertionKilled (verifyDecisionMutant or verify-mutants.mjs).
export const ADAPTERS=[
 'scripts/verification/mem-r04-mutants.mjs',
 'scripts/test-truth/decision-mutant.test-helper.mjs',
 'scripts/test-truth/verify-mutants.mjs',
 'server/decision-wiring/fix-round2-mutants.mjs',
 'server/decision-wiring/fix-round3-mutants.mjs',
 'server/decision-wiring/history-index-mutants.mjs',
 'server/decision-wiring/r17-mutants.mjs',
 'server/decision-wiring/sable-server-mutant.mjs',
 'server/testing/tafix-r4b-mutants.mjs',
];

// Runners present at a69c9bfbd6 and unmodified through the merged train5 tip: path -> git blob sha1.
export const LEGACY={
 'scripts/check-toolid-r121-mutants.mjs':'869f69f16839c2fd4554cb9e9ab365eb4e03abda',
 'scripts/check-toolid-r13a-mutants.mjs':'800acfe3d25e798ac7f5157fe549fa162711ba31',
 'scripts/check-toolid-r13b-mutants.mjs':'dd0129a3e175b5ea502b14c7ca9a9c31ae1a600d',
 'scripts/highlevel-f02-array-mutant.mjs':'9bc2f50f9fbe63ae4d2f5221d873fdfc6b318438',
 'scripts/highlevel-hlf2-array-mutant.mjs':'b38a65d0c98eca736cc3c5bc68a2386df11766c7',
 'scripts/highlevel-hlf7-mutants.mjs':'fee2c608eb4942abf674881a4e44902f3d28bc7b',
 'scripts/highlevel-s0-mutants.mjs':'7c6e97a82bcb3017688c776ed9afc9a06bc9d15c',
 'scripts/highlevel-userscreate-mutants.mjs':'876d1d0658b266de614b8916b35ef0777eb56c70',
 'scripts/mutants-toolid-r13.mjs':'bb7b333beb8eb816973eb2b2ff2dd84796ebf63a',
 'scripts/no-limits-live/qualify-afix-mutants.mjs':'f8dcb61fb5bbd2fb6c0efb20af9cfc2e1eec30e9',
 'scripts/no-limits-live/qualify-bindings-mutants.mjs':'e87fcdbc9f0b18576b7fa854d1bdf611c18d749e',
 'scripts/no-limits-live/qualify-ci-mutants.mjs':'9d1cc90f37ade6366f6299bb31de3d9cef436a3d',
 'scripts/no-limits-live/qualify-mutants.mjs':'3ec16bf3df534be2e053c2838818c91bedd12e34',
 'scripts/no-limits-live/qualify-native-mutant.mjs':'870f5bca588836234d2099a9f614cf7a12b3b5c3',
 'scripts/no-limits-live/qualify-product-mutant.mjs':'2f73d85effc891a9592834e9e6842dd446cfe793',
 'scripts/no-limits-live/qualify-source-product-mutants.mjs':'dc4f00519a8fd043d6ec131fff57ad446620930f',
 'scripts/probes/native-deny/profile-mutants.mjs':'160ea4b0a0ea834815190a337edae36ec8f05dc6',
 'scripts/probes/native-deny/s0-mutants.mjs':'f47dc63a4e6f6544896bb7df1ec3bbfccf7ac280',
 'scripts/routine-bounded-mutants.mjs':'b4c3ee1c6f51fe0cfb374965a95258b26b4710d6',
 'scripts/test-truth-mutants.test.mjs':'fc1e851daad43a2fdadd69d6b6234ca1bd84ee21',
 'scripts/test-truth/mutant-reporter.mjs':'9da4b1fde446a082417a7e7c6b37ea183588fae4',
 'scripts/test-truth/mutant-verdict.mjs':'16f58d36532b39e6329f11415691b417022bcb66',
 'scripts/verification/sc-safety/run-mutant-shards.mjs':'b02960f6afbc5565d96af9ad6dcd23f3757a00e0',
 'scripts/verification/sc-safety/run-mutants.mjs':'7ec0425d13b7e77427a4910eb6c68e7db55a0606',
 'scripts/verify-afix-gnl-r5-mutants.mjs':'c4c8d2fc7fd7aa1a8abcf49766c4571e2142f3ae',
 'scripts/verify-browser-no-limits-1019-mutants.mjs':'72e4f31c8d53f3eda442a59303d89da3a49f039c',
 'scripts/verify-gnl-email-r2-mutants.mjs':'66f9d68cfd8c70cdeba0cb8319a01dcd13c33ab1',
 'scripts/verify-gnl-product-mutants.mjs':'709d5aa1b991b269282a29b1424f20c7ba766ffe',
 'scripts/verify-gnl-r3-mutants.mjs':'ac126a2e5f5b1768eb2f4d4daa0efd48c9c5d585',
 'scripts/verify-gnl-r5-mutants.mjs':'0378d9d00eab302de7af30a2a50ff291888e2c02',
 'scripts/verify-gnl-service-origin-mutants.mjs':'2efad821bac96ec8f3558c63df593f5d557b0caa',
 'scripts/verify-highlevel-no-limits-mutants.mjs':'3954b7ce5acd7d26b3fd4c635cb9bd86adab884c',
 'scripts/verify-highlevel-review-mutants.mjs':'4f9a49bef0adcd4936987b69270a25cc24ad9006',
 'scripts/verify-highlevel-turn-level-mutants.mjs':'0f81f8e899c3549bb5978a640e98e5f198df90b6',
 'scripts/verify-no-limits-collection-mutants.mjs':'8ab376a68c111312128485d9543ff51ad8693563',
 'scripts/verify-no-limits-full-mutant.mjs':'f5674a4b4a22e21dd9ed4bf959192666c056efa0',
 'scripts/verify-no-limits-merge-mutants.mjs':'cce80b66bc503f8c72b86853632d475394e0ac04',
 'scripts/verify-no-limits-owner-mutants.mjs':'632a4e48a4fbc0474fdc531b3edc85fec1a90f06',
 'scripts/verify-no-limits-sql-afix-mutants.mjs':'a45eeb6ed432609afb66572a8af8f7fd661c26f7',
 'scripts/verify-no-limits-sql-mutants.mjs':'315f093b5daf1a1d270874df532d25d3ad182bcf',
 'scripts/verify-no-limits-sql-r3-mutant.mjs':'34ef13f26d37fecc95fa75e45f96c99d3abf667a',
 'scripts/verify-no-limits-stage-mutant.mjs':'407ac4527929b73a744606bb11e7bccd210b4625',
 'scripts/verify-no-limits-taint-mutants.mjs':'253184fa48f6a1f1117a3def9e467ff4504f6a52',
 'scripts/verify-no-limits-uncovered-mutants.mjs':'b32e47f1808235a9d9b89c38170c5dfe2ea85a52',
 'scripts/verify-production-wiring-mutants.mjs':'ce9fc0dd9cf4966e7360917e9570fd19e3ccf841',
 'scripts/verify-release-guard-gnl-mutants.mjs':'e50ab283a54f37f0f00be1a848c028f0dc01287f',
 'scripts/verify-release-guard-r2-mutants.mjs':'17085688f5e23fc1ceed82e242eaca691c8448d0',
 'scripts/verify-release-guard-r3-mutants.mjs':'f4132f9781dadfcabc92d6cffc9066754a7b0376',
 'scripts/verify-release-guard-r4-mutants.mjs':'0c2189c2c4806ea6cd7f9c23def424d0db3cfb73',
 'scripts/verify-release-guard-r5-mutants.mjs':'b0b53e7fe5b0721592e09f1016ef1bb672c24e12',
 'scripts/verify-routine-owner-no-limits-mutants.mjs':'376b6a23ee5859694017615555821a42281db552',
 'scripts/verify-w1sec-mutants.mjs':'1c84393b1c41db9fb232b8d8f55f81b775a6823b',
 'scripts/verify-w1sec-mutants.test.mjs':'2414d906a1153c64d82ddfc87c909a54886a114b',
 'scripts/web-read-replay/afix-round3-mutants.mjs':'0e461d92dea59858968d5b9e07cc64928cde95d6',
 'scripts/web-read-replay/mutants.mjs':'3278232120faeb7c09f9a6809e8cd1f8489be4f5',
 'scripts/web-read-replay/round3-mutants.mjs':'0b3c203069a0813a7a02f63925f06a57e24d70ce',
 'server/decision-producers/mutants.mjs':'06dd2e77839d10903d3f62ad95f61170e638545e',
 'server/decision-wiring/mutants.mjs':'068324a34c011e281d06ce457443c5a6dc735cba',
 'server/decision-wiring/review-mutants.mjs':'98debeb92098202a9c752c583fb6326937a8852f',
 'server/decision/verify-block-mutants.mjs':'263801907f08b4350348a16f539cd9b8f78886f5',
 'server/decision/verify-mutants.mjs':'09c650d1d6cacf5e02c7fe880b3373f6fb01c269',
 'server/drivers/claude-no-limits-settings-mutants-1019.mjs':'20da6cd24cf89c42bbb95e7ce62ec8e1ac9692ab',
 'server/highlevel/returned-identities.mutants.mjs':'6d19151821d35fce085bee254ec50f0fd453398e',
 'server/memory/field-replay/mutants.mjs':'0a3a005b0cdec92fda98e24246db767385f0e441',
 'server/memory/field-replay/review-mutants.mjs':'33af10dac04a5e2db894dca27a6a84e936a55deb',
 'server/native-deny/fix-mutants.mjs':'573b9ce0aeb1d16675e7488410b524bb8666cabd',
 'server/testing/gnl-apps-mutants.mjs':'0b96bcbdf8b52aaf988c73ad483e94ffd0fbbb22',
 'server/testing/gnl-apps-r2-mutants.mjs':'d6ce43587a3131be0d4ff3c9c8b72856acd33b51',
 'server/wipe-proof/mutants.mjs':'2bf7d03e505e32414a4d6ceed07c7757512a750b',
 'server/wipe/mutants.mjs':'2f51fcba0b479801e14a5be9f05d22b400f7ddab'
};

export const gitBlobSha1=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');

const SKIP=new Set(['node_modules','.git','dist','build','coverage','target']);
export function discoverRunners(root){
 const found=[];
 const walk=dir=>{
  for(const entry of readdirSync(join(root,dir),{withFileTypes:true})){
   const path=dir+'/'+entry.name;
   if(entry.isDirectory()){if(!SKIP.has(entry.name))walk(path);}
   else if(entry.isFile()&&/mutant.*\.mjs$/.test(entry.name))found.push(path);
  }
 };
 for(const dir of ['server','scripts'])if(existsSync(join(root,dir)))walk(dir);
 return found.sort();
}

// unrouted: discovered but neither an adapter nor legacy; missing: adapter or legacy file not discovered;
// changed: legacy file whose bytes no longer match its frozen hash.
export function inventory(root){
 const discovered=discoverRunners(root),known=new Set([...ADAPTERS,...Object.keys(LEGACY)]);
 return {
  unrouted:discovered.filter(path=>!known.has(path)),
  missing:[...known].filter(path=>!discovered.includes(path)),
  changed:Object.entries(LEGACY).filter(([path,hash])=>discovered.includes(path)&&gitBlobSha1(readFileSync(join(root,path)))!==hash).map(([path])=>path),
 };
}
