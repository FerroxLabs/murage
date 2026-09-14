import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,realpathSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {stageBackupRestic} from "./prepare-backup-restic.mjs";
import {trustedBackupResticExecutable,signedResticOwnedByCurrentApp} from "../electron/backup-restic-attestation.mjs";
const archive=process.env.MURAGE_RESTIC_TEST_ARCHIVE;
function fixture(t){const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-restic-stage-test-")));t.after(()=>safeWipeSync(root));mkdirSync(path.join(root,"third_party","restic"),{recursive:true});copyFileSync(new URL("../third_party/restic/LICENSE",import.meta.url),path.join(root,"third_party","restic","LICENSE"));return root;}
test("stages pinned local archive without running tool and preserves matching resource",{skip:!archive},async t=>{
 const root=fixture(t),file=await stageBackupRestic({root,target:"darwin-arm64",archive});assert.equal(file,path.join(root,"dist-native","backup-restic","arm64","restic"));
 if(process.platform==="darwin"&&process.arch==="arm64")assert.equal(trustedBackupResticExecutable(file),true);
 assert.equal(await stageBackupRestic({root,target:"darwin-arm64",archive}),file);writeFileSync(file,"tampered");await assert.rejects(stageBackupRestic({root,target:"darwin-arm64",archive}),/PAYLOAD_MISMATCH/);
});
test("unsupported or corrupt archive never stages an executable",async t=>{
 const root=fixture(t),bad=path.join(root,"bad.bz2");writeFileSync(bad,"not an archive");await assert.rejects(stageBackupRestic({root,target:"win32-x64",archive:bad}),/UNSUPPORTED/);await assert.rejects(stageBackupRestic({root,target:"darwin-arm64",archive:bad}),/ARCHIVE_MISMATCH/);assert.equal(existsSync(path.join(root,"dist-native","backup-restic","arm64","restic")),false);
});
test("signed policy requires exact payload, owning app and same Apple team",{skip:!archive},async t=>{
 const root=fixture(t),raw=await stageBackupRestic({root,target:"darwin-arm64",archive}),bytes=readFileSync(raw),app=path.join(root,"Fixture.app"),directory=path.join(app,"Contents","Resources","backup-tools","arm64"),exe=path.join(app,"Contents","MacOS","Murage"),tool=path.join(directory,"restic");mkdirSync(directory,{recursive:true});mkdirSync(path.dirname(exe));writeFileSync(exe,"fixture");copyFileSync(raw,tool);
 const calls=[];const run=args=>{calls.push(args);return{status:args.includes("-R")&&!args[args.indexOf("-R")+1].startsWith("=anchor apple generic")?1:0,stderr:"TeamIdentifier=ABCDEFGHIJ\n"};};assert.equal(signedResticOwnedByCurrentApp(tool,bytes,{currentExecutable:exe,run}),true);assert.equal(calls.length,4);
 assert.equal(signedResticOwnedByCurrentApp(tool,bytes,{currentExecutable:raw,run}),false);
 assert.equal(signedResticOwnedByCurrentApp(tool,bytes,{currentExecutable:exe,run:args=>({status:0,stderr:`TeamIdentifier=${args.at(-1)===tool?"ZZZZZZZZZZ":"ABCDEFGHIJ"}\n`})}),false);
 assert.equal(signedResticOwnedByCurrentApp(tool,bytes,{currentExecutable:exe,run:()=>({status:1})}),false);
 const changed=Buffer.from(bytes);changed[4096]^=1;const prior=calls.length;assert.equal(signedResticOwnedByCurrentApp(tool,changed,{currentExecutable:exe,run}),false);assert.equal(calls.length,prior);
});
