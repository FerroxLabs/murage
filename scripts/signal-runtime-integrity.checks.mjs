import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digest, normalizedDigest, machoTeamIdentifiers } from '../server/channels/signal/binary-digest.mjs';
import { verifyRuntimeTree, canonicalRuntimeRows } from '../server/channels/signal/runtime-integrity.mjs';
import { pinSyntheticTree } from './fixtures/signal-runtime-tree.mjs';
import { assertModuleSubset } from './normalize-signal-runtime.mjs';
const put=(root,path,bytes)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);};
function fixture(target, executable) {
  const root=mkdtempSync(join(tmpdir(),'signal-integrity-synthetic-'));
  put(root,'signal-cli.jar','synthetic CLI');put(root,'lib/signal-network-2.15.3_unofficial_157.jar','synthetic network');
  put(root,'jre/release','JAVA_RUNTIME_VERSION="25.0.1+1"\nIMPLEMENTOR="Eclipse Adoptium"\n');
  put(root,'jre/bin/'+(target==='win32-x64'?'java.exe':'java'),executable);
  const signal=target==='win32-x64'?'signal_jni.dll':target==='darwin-arm64'?'libsignal_jni.dylib':'libsignal_jni.so';
  const sqlite=target==='win32-x64'?'sqlitejdbc.dll':target==='darwin-arm64'?'libsqlitejdbc.dylib':'libsqlitejdbc.so';
  put(root,'native/'+signal,'synthetic JNI');put(root,'native/'+sqlite,'synthetic sqlite');
  const record=pinSyntheticTree(root,target);
  return {root,target,pin:{targets:{[target]:record},signalNetwork:{version:'2.15.3_unofficial_157',sha256:digest('synthetic network')}},record};
}
test('T-JDEPS-SUBSET accepts included modules, rejects an absent module',()=>{
  assert.doesNotThrow(()=>assertModuleSubset('java.base,java.sql','MODULES="java.base java.sql"'));
  assert.throws(()=>assertModuleSubset('java.base,jdk.missing','MODULES="java.base java.sql"'),/subset/);
});
test('I18 exact upstream accepted, extra/missing/changed bytes and directories rejected',async()=>{
  const f=fixture('linux-x64',Buffer.from([0x7f,69,76,70,1]));
  try {
    assert.equal((await verifyRuntimeTree(f)).nativeDir,join(f.root,'native'));
    const omitted=f.record.jars.pop();await assert.rejects(()=>verifyRuntimeTree(f),/jar inventory/);f.record.jars.push(omitted);
    put(f.root,'extra','unexpected');await assert.rejects(()=>verifyRuntimeTree(f),/file set/);rmSync(join(f.root,'extra'));
    mkdirSync(join(f.root,'extra-dir'));await assert.rejects(()=>verifyRuntimeTree(f),/directory set/);safeWipeSync(join(f.root,'extra-dir'));
    put(f.root,'native/libsqlitejdbc.so','changed');await assert.rejects(()=>verifyRuntimeTree(f),/unlisted/);
    rmSync(join(f.root,'native/libsqlitejdbc.so'));await assert.rejects(()=>verifyRuntimeTree(f),/file set/);
  } finally {safeWipeSync(f.root);}
});
const signedRoot=process.env.SIGNAL_SIGNING_FIXTURES;
for (const [target,ext,codeOffset] of [['darwin-arm64','macho',4096],['win32-x64','exe',512]]) {
  test.skipIf(!signedRoot)(`T-NORMALIZER ${target}: real signing preserves digest, code mutation changes it`,()=>{
    const original=readFileSync(join(signedRoot,'original.'+ext)),signed=readFileSync(join(signedRoot,'signed.'+ext));
    if (target==='darwin-arm64') assert.deepEqual([...new Set(machoTeamIdentifiers(signed))],['SYNTHETIC1']);
    assert.notEqual(digest(original),digest(signed));assert.equal(normalizedDigest(original),normalizedDigest(signed));
    const bad=Buffer.from(signed);bad[codeOffset]^=1;assert.notEqual(normalizedDigest(bad),normalizedDigest(original));
  });
  test.skipIf(!signedRoot)(`T-INTEGRITY-RESIGNED ${target}: injected trust probe, canonical lengths and signer rejection`,async()=>{
    const original=readFileSync(join(signedRoot,'original.'+ext)),signed=readFileSync(join(signedRoot,'signed.'+ext));
    const f=fixture(target,original),path='jre/bin/'+(target==='win32-x64'?'java.exe':'java');
    const identity=target==='win32-x64'?{subject:'CN=Murage synthetic signature test'}:{teamId:'SYNTHETIC1'};
    try {
      const before=await canonicalRuntimeRows(f);
      put(f.root,path,signed);await assert.rejects(()=>verifyRuntimeTree(f),/unlisted/);
      f.record.integrity.resigned={paths:[path],identity};
      let calls=0;
      const probe=input=>{calls++;assert.deepEqual(input.identity,identity);assert.deepEqual(input.paths,[join(f.root,path)]);return true;};
      assert.deepEqual(await canonicalRuntimeRows({...f,probe}),before);assert.equal(calls,1);
      assert.equal((await verifyRuntimeTree({...f,probe})).java,join(f.root,path));
      await assert.rejects(()=>verifyRuntimeTree({...f,probe:()=>false}),/signature/);
      await assert.rejects(()=>verifyRuntimeTree(f),/signature/); // self-signed/ad-hoc is NOT production trust.
      const bad=Buffer.from(signed);bad[codeOffset]^=1;put(f.root,path,bad);
      await assert.rejects(()=>verifyRuntimeTree({...f,probe}),/code changed/);
    } finally {safeWipeSync(f.root);}
  });
}
