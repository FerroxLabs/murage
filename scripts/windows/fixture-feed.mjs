import { verifyStagedPackage } from './package-identity.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
const digest=(bytes,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(bytes).digest(encoding);
export function fixtureVersion(version) {
 assert.match(version,/^1\.0\.[1-9]\d*$/,'fixture requires a numeric patch version');
 const patch=Number(version.split('.')[2]);assert(patch>19&&patch<=65535,'fixture patch must be higher and fit Windows version fields');
 return version;
}
export function validateFeed(directory,executable,commit) {
 const stage=JSON.parse(readFileSync(join(dirname(executable),'..','stage.json'),'utf8').replace(/^\uFEFF/,''));
 const identity=verifyStagedPackage(dirname(executable),stage);
 assert.equal(identity.commit,commit,'caller commit must match packaged provenance');
 const manifest=JSON.parse(readFileSync(join(directory,'fixture-update.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(manifest.commit,commit);assert.match(commit,/^[a-f0-9]{40}$/i);
 assert.equal(manifest.candidateVersion,'1.0.19');assert.equal(manifest.published,false);
 assert.equal(manifest.candidateSha256.toLowerCase(),digest(readFileSync(executable)));
 fixtureVersion(manifest.version);assert.equal(manifest.feedUrl,'http://127.0.0.1:18919/');
 assert.match(manifest.installer,/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.exe$/);
 const bytes=readFileSync(join(directory,manifest.installer));assert.equal(manifest.updateSha256,digest(bytes));
 const metadata=parse(readFileSync(join(directory,'latest.yml'),'utf8'));
 assert.equal(metadata.version,manifest.version);assert.equal(metadata.path,manifest.installer);
 assert.equal(metadata.sha512,digest(bytes,'sha512','base64'));
 assert.equal(metadata.files.length,1,'one local installer only');
 assert.equal(metadata.files[0].url,manifest.installer);assert.equal(metadata.files[0].size,bytes.length);
 assert.equal(metadata.files[0].sha512,metadata.sha512);
 // macOS/Linux package URLs and an alternate release asset cannot enter this local-only Windows gate.
 assert(!metadata.packages&&!metadata.releaseNotesFile&&!metadata.url,'unexpected remote asset metadata');
 return {...manifest,identity};
}
export {fixtureEngineEntry} from './native-launcher.mjs';
