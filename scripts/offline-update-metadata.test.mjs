import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import writeUpdateFeeds, { writeAppUpdate } from './offline-update-metadata.mjs';
import { assertReleaseUpdateFeed } from './release-guard.mjs';
const temps=[];
afterEach(()=>temps.splice(0).forEach(dir=>removeTempDirSync(dir)));
function fixture() {const dir=mkdtempSync(join(tmpdir(),'offline-updates-'));temps.push(dir);return dir;}
it('writes installed public updater configuration and the verified Windows signer without a publisher', async()=>{
  const resources=fixture();
  const packager={config:{publish:null},appInfo:{updaterCacheDirName:'murage-updater'},isForceCodeSigningVerification:true,
    signingManager:{value:Promise.resolve({computedPublisherName:{value:Promise.resolve(['Ferrox Labs, LLC'])}})}};
  await writeAppUpdate({packager,electronPlatformName:'win32'},resources);
  const text=readFileSync(join(resources,'app-update.yml'),'utf8');
  expect(assertReleaseUpdateFeed(text)).toBe(true);
  expect(parse(text).publisherName).toEqual(['Ferrox Labs, LLC']);
});
it('qualification metadata stays separate from the release feed',async()=>{
  const resources=fixture(), before=process.env.MURAGE_QUALIFICATION_FEED_URL;
  process.env.MURAGE_QUALIFICATION_FEED_URL='https://example.invalid/qualification';
  try {
    await writeAppUpdate({packager:{config:{publish:null,extraMetadata:{murageQualification:true}}}},resources);
    expect(()=>assertReleaseUpdateFeed(readFileSync(join(resources,'app-update.yml'),'utf8'))).toThrow('qualification');
  } finally {if(before===undefined)delete process.env.MURAGE_QUALIFICATION_FEED_URL;else process.env.MURAGE_QUALIFICATION_FEED_URL=before;}
});
it('emits all platform feeds with exact final-byte hashes and updater payload fallbacks',()=>{
  const outDir=fixture();
  const names=['Murage-1.0.19-arm64.dmg','Murage-1.0.19-arm64.zip','Murage-1.0.19-x64.dmg','Murage-1.0.19-x64.zip',
    'Murage-1.0.19-setup.exe','Murage-1.0.19-amd64.deb','Murage-1.0.19-x86_64.AppImage','Murage-1.0.19-setup.exe.blockmap'];
  const artifactPaths=names.map(name=>{const file=join(outDir,name);writeFileSync(file,name);return file;});
  expect(writeUpdateFeeds({outDir,artifactPaths})).toBeUndefined();
  for(const [feed,count,extension] of [['latest-mac.yml',4,'.zip'],['latest.yml',1,'.exe'],['latest-linux.yml',2,'.AppImage']]) {
    const result=parse(readFileSync(join(outDir,feed),'utf8'));
    expect(result.version).toBe('1.0.19');expect(result.files).toHaveLength(count);expect(result.path.endsWith(extension)).toBe(true);
    for(const file of result.files) {expect(file.size).toBe(Buffer.byteLength(file.url));expect(file.sha512).toBe(createHash('sha512').update(file.url).digest('base64'));}
    expect(result.sha512).toBe(result.files[0].sha512);
  }
});
