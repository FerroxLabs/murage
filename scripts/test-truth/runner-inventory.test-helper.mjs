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

// Runners present at a69c9bfbd6 and unmodified through the merged train5 tip, except the re-frozen groups below (each names its reason): path -> git blob sha1.
export const LEGACY={
 'scripts/check-toolid-r121-mutants.mjs':'d088709f7346348df21c335bdfbc0913c343324c',
 'scripts/check-toolid-r13a-mutants.mjs':'fdf94d7cc3f03e1b80b1db381d8daf434b5d94d9',
 'scripts/check-toolid-r13b-mutants.mjs':'4ff765e7d7d82eb6f544cb0393c1e6dd9e045b27',
 'scripts/mutants-toolid-r13.mjs':'820afadbf2e2a96a30fba6e45b94bca5fe5e2374',
 'scripts/no-limits-live/qualify-bindings-mutants.mjs':'e87fcdbc9f0b18576b7fa854d1bdf611c18d749e',
 'scripts/no-limits-live/qualify-ci-mutants.mjs':'9d1cc90f37ade6366f6299bb31de3d9cef436a3d',
 'scripts/no-limits-live/qualify-mutants.mjs':'31b487a4642b10ce79b343fdeeb16a3a69eb5b6d',
 'scripts/no-limits-live/qualify-source-product-mutants.mjs':'dc4f00519a8fd043d6ec131fff57ad446620930f',
 'scripts/probes/native-deny/profile-mutants.mjs':'160ea4b0a0ea834815190a337edae36ec8f05dc6',
 'scripts/probes/native-deny/s0-mutants.mjs':'f47dc63a4e6f6544896bb7df1ec3bbfccf7ac280',
 'scripts/routine-bounded-mutants.mjs':'b4c3ee1c6f51fe0cfb374965a95258b26b4710d6',
 'scripts/test-truth-mutants.test.mjs':'fc1e851daad43a2fdadd69d6b6234ca1bd84ee21',
 'scripts/test-truth/mutant-reporter.mjs':'9da4b1fde446a082417a7e7c6b37ea183588fae4',
 'scripts/test-truth/mutant-verdict.mjs':'16f58d36532b39e6329f11415691b417022bcb66',
 'scripts/verification/sc-safety/run-mutant-shards.mjs':'b02960f6afbc5565d96af9ad6dcd23f3757a00e0',
 'scripts/verification/sc-safety/run-mutants.mjs':'7ec0425d13b7e77427a4910eb6c68e7db55a0606',
 'scripts/verify-afix-gnl-r5-mutants.mjs':'fe710ff469a19b4f9790ad86c301ac49a5a7c4cb',
 'scripts/verify-browser-no-limits-1019-mutants.mjs':'72e4f31c8d53f3eda442a59303d89da3a49f039c',
 'scripts/verify-gnl-email-r2-mutants.mjs':'66f9d68cfd8c70cdeba0cb8319a01dcd13c33ab1',
 'scripts/verify-gnl-product-mutants.mjs':'3716444e2fd2ab4b814bd22f0ce2907c9b043e79',
 'scripts/verify-gnl-r3-mutants.mjs':'de4e033410fcd69a4acd601e86c0dc5c28bbd2dd',
 'scripts/verify-gnl-r5-mutants.mjs':'9d1fcdac55dcbd555186100a1bd01a56e3dcd53e',
 'scripts/verify-gnl-service-origin-mutants.mjs':'d8c2e71589ffd2ea434cc83f719bc6f2209dae39',
 'scripts/verify-no-limits-collection-mutants.mjs':'55ba2ee3f532755e47110fbca21c2e4eeaf2b0b4',
 'scripts/verify-no-limits-full-mutant.mjs':'e48ca4ef585eb12202530187bcb65ba655630186',
 'scripts/verify-no-limits-merge-mutants.mjs':'930fc44abd6c6b38c3cbe84a53c46c8de66b0251',
 'scripts/verify-no-limits-owner-mutants.mjs':'1056a213e41f4a3a3a376a7b5eaf0857ab96c40d',
 'scripts/verify-no-limits-sql-afix-mutants.mjs':'a6543d46833b35c809c9ee09f7b30fcc67758352',
 'scripts/verify-no-limits-sql-mutants.mjs':'6ec695b73f321dfc9061116dcef605c2f776e29e',
 'scripts/verify-no-limits-sql-r3-mutant.mjs':'9e498a660d32932cb9986974115f99e401aee080',
 'scripts/verify-no-limits-stage-mutant.mjs':'6b259de2d23a4fc6227750060aea3d1c11d28497',
 'scripts/verify-no-limits-taint-mutants.mjs':'053c31b37fcad5af5729881b034e7d8adb40add9',
 'scripts/verify-no-limits-uncovered-mutants.mjs':'0b2fba0cab32f01b476c09f90f57a27e5efbadab',
 'scripts/verify-production-wiring-mutants.mjs':'1867e17fd2effa0334ba38da759259917e1a552c',
 'scripts/verify-release-guard-gnl-mutants.mjs':'5183cbc7556cabecedce7b84dc3d7ec3a71d68e9',
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
 'server/decision-wiring/review-mutants.mjs':'7fcb5ca1c2909128b7f08e1ee3ae0b59827e6054',
 'server/decision/verify-block-mutants.mjs':'263801907f08b4350348a16f539cd9b8f78886f5',
 'server/decision/verify-mutants.mjs':'09c650d1d6cacf5e02c7fe880b3373f6fb01c269',
 'server/drivers/claude-no-limits-settings-mutants-1019.mjs':'20da6cd24cf89c42bbb95e7ce62ec8e1ac9692ab',
 'server/memory/field-replay/mutants.mjs':'0a3a005b0cdec92fda98e24246db767385f0e441',
 'server/memory/field-replay/review-mutants.mjs':'33af10dac04a5e2db894dca27a6a84e936a55deb',
 'server/native-deny/fix-mutants.mjs':'573b9ce0aeb1d16675e7488410b524bb8666cabd',
 'server/testing/gnl-apps-mutants.mjs':'0cf76f70c81d350edd8a9e4407a255fb2111290d',
 'server/testing/gnl-apps-r2-mutants.mjs':'7424a60f474c8d3fc1824e518073a6c2408daa3c',
 'server/wipe-proof/mutants.mjs':'2bf7d03e505e32414a4d6ceed07c7757512a750b',
 'server/wipe/mutants.mjs':'2f51fcba0b479801e14a5be9f05d22b400f7ddab',
 // Re-frozen (train repair, row 43 R2): 2026-11-17 qualifier edits; verdict lines byte-same
 'scripts/no-limits-live/qualify-afix-mutants.mjs':'ec7ef10d4003bc39dddbb2a1e798b60f5b63a194',
 'scripts/no-limits-live/qualify-native-mutant.mjs':'9a9f4507ddf296771c94f240603fda83cefebbb0',
 'scripts/no-limits-live/qualify-product-mutant.mjs':'846aaebb32db0f917d462128f66e1ecffaae8f48',
 // Admitted once by MAIN-RULING row43 R2 c1 (2026-11-21); it counts any failed case as a kill (legacy class), so routing it is a follow-up
 'scripts/windows-sac-mutants.mjs':'bf58f6bda10e4b971e3e0297396e0334d424812a'
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
