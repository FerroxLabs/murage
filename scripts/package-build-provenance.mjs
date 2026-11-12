import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
// Runs on the signing builder before the ZIP is made. No caller commit label.
export function writePackageBuildProvenance(repository,resources) {
 const git=args=>execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true}).trim();
 const commit=git(['rev-parse','HEAD']);assert.match(commit,/^[a-f0-9]{40}$/);
 const status=git(['status','--porcelain','--untracked-files=normal']);
 assert(status.split('\n').filter(Boolean).every(row=>row.trim().match(/^[AM] package\.json$/)),'uncommitted source or untracked input');
 const changed=git(['diff','HEAD','--name-only']).split('\n').filter(Boolean);
 assert(changed.every(p=>p==='package.json'),'package build requires clean source except version');
 const original=JSON.parse(git(['show','HEAD:package.json']));
 const current=JSON.parse(readFileSync(join(repository,'package.json'),'utf8'));
 assert(/^1\.0\.\d+$/.test(current.version),'numeric candidate version');
 const version=current.version;current.version=original.version;
 assert.deepEqual(current,original,'only package version may differ from build commit');
 const provenance={commit,tree:git(['rev-parse','HEAD^{tree}']),version};
 writeFileSync(join(resources,'build-provenance.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
 return provenance;
}
