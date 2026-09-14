import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGE_PAYLOAD_SHA256,normalizedAgePayloadHash,signedAgeOwnedByCurrentApp,trustedBackupAgeExecutable } from "./backup-age-attestation.mjs";
const qualified=process.platform==="darwin"&&process.arch==="arm64";
const original=()=>readFileSync(new URL("../dist-native/backup-age/arm64/age",import.meta.url));
test("malformed or non-arm64 MachO is never a normalized age payload",()=>{
  for(const value of [Buffer.alloc(0),Buffer.alloc(32),Buffer.from("not executable")])assert.equal(normalizedAgePayloadHash(value),null);
});
test("actual ad-hoc resign keeps the pinned payload but is not production trust",{skip:!qualified},()=>{
  const root=mkdtempSync(path.join(tmpdir(),"murage-age-attestation-test-"));
  try{
    const signed=path.join(root,"age");copyFileSync(new URL("../dist-native/backup-age/arm64/age",import.meta.url),signed);
    execFileSync("/usr/bin/codesign",["--force","--sign","-",signed],{stdio:"pipe",timeout:10000});
    assert.equal(normalizedAgePayloadHash(original()),AGE_PAYLOAD_SHA256);
    assert.equal(normalizedAgePayloadHash(readFileSync(signed)),AGE_PAYLOAD_SHA256);
    assert.equal(trustedBackupAgeExecutable(signed),false);
    assert.throws(()=>execFileSync("/usr/bin/codesign",["--verify","--strict","-R","anchor apple generic",signed],{stdio:"pipe",timeout:10000}));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("code tampering, load-command bounds, overlapping segments and undeclared tail fail",{skip:!qualified},()=>{
  const base=original();
  const changed=Buffer.from(base);changed[4096]^=1;assert.notEqual(normalizedAgePayloadHash(changed),AGE_PAYLOAD_SHA256);
  const bounds=Buffer.from(base);bounds.writeUInt32LE(0xffffffff,20);assert.equal(normalizedAgePayloadHash(bounds),null);
  assert.equal(normalizedAgePayloadHash(Buffer.concat([base,Buffer.from([0])])),null);
  const overlap=Buffer.from(base);let cursor=32,first=false;
  for(let i=0;i<overlap.readUInt32LE(16);i++){const cmd=overlap.readUInt32LE(cursor),size=overlap.readUInt32LE(cursor+4);if(cmd===0x19&&overlap.readBigUInt64LE(cursor+48)>0n){if(first){overlap.writeBigUInt64LE(0n,cursor+40);break;}first=true;}cursor+=size;}
  assert.equal(normalizedAgePayloadHash(overlap),null);
});
test("mock Developer-ID verification also requires current app, same team and payload pin",{skip:!qualified},()=>{
  const root=mkdtempSync(path.join(tmpdir(),"murage-age-owner-test-"));
  try{
    const app=path.join(root,"Murage.app"),resource=path.join(app,"Contents","Resources","backup-tools","arm64"),macos=path.join(app,"Contents","MacOS");mkdirSync(resource,{recursive:true});mkdirSync(macos,{recursive:true});
    const file=path.join(resource,"age"),currentExecutable=path.join(macos,"Murage");writeFileSync(file,original());writeFileSync(currentExecutable,"mock app executable, never run");
    const run=args=>({status:0,stderr:args.includes("--display")?"TeamIdentifier=ABCDEFGHIJ\n":""});
    assert.equal(signedAgeOwnedByCurrentApp(file,original(),{currentExecutable,run}),true);
    assert.equal(signedAgeOwnedByCurrentApp(file,original(),{currentExecutable,run:args=>args.at(-1)===realpathSync(file)?{status:0,stderr:"TeamIdentifier=OTHERTEAM1\n"}:run(args)}),false);
    assert.equal(signedAgeOwnedByCurrentApp(file,original(),{currentExecutable,run:()=>({status:1,stderr:"untrusted"})}),false);
    assert.equal(signedAgeOwnedByCurrentApp(file,original(),{currentExecutable:process.execPath,run}),false);
    const corrupt=original();corrupt[4096]^=1;assert.equal(signedAgeOwnedByCurrentApp(file,corrupt,{currentExecutable,run}),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
