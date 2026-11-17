// SPDX-License-Identifier: AGPL-3.0-or-later
// Build packaged-layout fixtures from the exact comparison snapshot, never the outer checkout.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,symlinkSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const side=process.argv[2];if(!['base','head'].includes(side))throw Error('side');
const root=mkdtempSync(join(tmpdir(),'truth-runtime-build-'));
const run=(args)=>{const r=spawnSync(args[0],args.slice(1),{cwd:root,env:process.env,stdio:'inherit'});if(r.status!==0)throw Error(args.join(' ')+' exit '+r.status);};
try {
 run(['tar','-xzf',`/work/.test-tmp/truth/${side}.tar.gz`,'-C',root]);
 run(['git','diff','--exit-code','HEAD','--']);
 mkdirSync(join(root,'node_modules'));
 for(const name of readdirSync('/work/node_modules'))if(!['.vite','.vite-temp','.cache'].includes(name))symlinkSync('/work/node_modules/'+name,join(root,'node_modules',name));
 run(['node','node_modules/typescript/bin/tsc','-p','tsconfig.server.build.json']);
 run(['node','scripts/bundle-server.mjs']);
 const artifact=join(root,`${side}-build.tar.gz`),receipt=join(root,`${side}-build.finished`);
 run(['tar','-czf',artifact,'dist-server']);
 const sha=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
 const archiveSha256=createHash('sha256').update(readFileSync(artifact)).digest('hex');
 writeFileSync(receipt,JSON.stringify({sha,archiveSha256,finished:new Date().toISOString()}));
 // Never publish into /work while another dispatch can rsync --delete there.
 // The host verifies and atomically installs this private, immutable result.
 const result=spawnSync('tar',['-cf','-','-C',root,`${side}-build.tar.gz`,`${side}-build.finished`],{maxBuffer:512*1024**2});
 if(result.status!==0)throw Error('Runtime result packing failed');
 process.stdout._handle?.setBlocking(true);
 writeFileSync(1,`BEGIN_RUNTIME ${side}\n`+result.stdout.toString('base64')+`\nEND_RUNTIME ${side}\n`);
} finally {rmSync(root,{recursive:true,force:true});}
