// SPDX-License-Identifier: AGPL-3.0-or-later
// Run in the network-none test container. Archive and manifest are prepared by:
// python3 server/decision/prepare-starting-tree.py
// git archive alone omits export-ignored blobs; the preparer includes every blob.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,mkdtempSync,symlinkSync,copyFileSync,readlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
export const STARTING_COMMIT='68ee615aba094f9209bbc482a1a21cd62d024367';
export function verifyStartingTree(root,manifest){
 let checked=0;
 for(const line of manifest.trim().split('\n')){
  const match=/^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);if(!match)throw new Error('invalid-starting-manifest');
  const [,mode,expected,path]=match;const filename=join(root,path);
  const body=mode==='120000'?Buffer.from(readlinkSync(filename)):readFileSync(filename);
  const actual=createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
  if(actual!==expected)throw new Error('starting-tree-mismatch: '+path);
  checked++;
 }
 return checked;
}
export function runStartingRed(){
 const dir=resolve(process.env.DECISION_EVIDENCE||'.afix-evidence');mkdirSync(dir,{recursive:true});
 const root=mkdtempSync(join(tmpdir(),'decision-s0-red-'));
 const manifest=readFileSync('.afix-evidence/s0-exact.manifest','utf8');
 const unpack=spawnSync('tar',['-xf',resolve('.afix-evidence/s0-exact.tar'),'-C',root],{encoding:'utf8'});if(unpack.status!==0)throw new Error(unpack.stderr);
 const verified=verifyStartingTree(root,manifest);
 symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
 // Only test files and the test host are overlaid. Every product source, parser,
 // schema and guard is the exact starting tree (including absent S1 modules).
 const tests=readdirSync('server/decision').filter(n=>n.endsWith('.test.ts')&&n!=='contract.test.ts'&&n!=='starting-tree.test.ts');
 for(const name of [...tests,'fixture.ts'])copyFileSync('server/decision/'+name,join(root,'server/decision',name));
 copyFileSync('server/decision/starting-baseline.probe.ts',join(root,'server/decision/starting-baseline.test.ts'));
 const reportPath=dir+'/s0-results.json';
 const command=['run',...tests.map(n=>'server/decision/'+n),'server/decision/starting-baseline.test.ts','--reporter=default','--reporter=json','--outputFile='+reportPath];
 const r=spawnSync(resolve('node_modules/.bin/vitest'),command,{cwd:root,encoding:'utf8',timeout:240000});
 writeFileSync(dir+'/complete-s0-red.log',`COMMIT ${STARTING_COMMIT}\nVERIFIED BLOBS ${verified}\nFIXTURE ${root}\nCOMMAND vitest ${command.join(' ')}\n${r.stdout??''}${r.stderr??''}\nSTATUS ${r.status}\n`);
 writeFileSync(dir+'/s0-tree-proof.json',JSON.stringify({commit:STARTING_COMMIT,verified,root,archiveSHA256:createHash('sha256').update(readFileSync('.afix-evidence/s0-exact.tar')).digest('hex'),status:r.status},null,2));
 const report=JSON.parse(readFileSync(reportPath,'utf8'));
 const probes=report.testResults.flatMap(t=>t.assertionResults).filter(t=>t.fullName.startsWith('S0 RED the real starting'));
 if(probes.length!==2||probes.some(t=>t.status!=='failed'||!t.failureMessages.some(m=>m.includes('AssertionError'))))throw new Error('starting-schema-parser-red-unproved');
 console.log('Actual starting-tree RED',r.status,'verified blobs',verified);
 if(r.status===null||r.status===0)throw new Error('starting-tree-did-not-go-red');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runStartingRed();
