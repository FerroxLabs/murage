import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { testAgeKeys } from "../server/testing/backup-fixture.ts";
import { readBackupIdentity } from "./backup-mode.mjs";
import { ageIdentityRecipient, bech32Decode, bech32Encode, createRecoveryKeyFile, createRecoveryKeyFlow, generateAgeIdentity, recoveryKeyFolderStore, settleRecoveryKeyRequest, suggestRecoveryKeyPath } from "./backup-recovery-key.mjs";

// BIP-173 test vectors.
const valid=["A12UEL5L","a12uel5l","an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
  "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw","11"+"q".repeat(82)+"c8247j","split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w","?1ezyfcl"];
const invalid=["\x201nwldj5","\x7f1axkwrx","\x801eym55h","an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx",
  "pzry9x0s0muk","1pzry9x0s0muk","x1b4n0q5v","li1dgmt3","de1lg7wt\xff","A1G7SGD8","10a06t8","1qzzfhee",
  // Mixed case, and a valid bech32m string: age keys are plain bech32.
  "A12uEL5L","a1lqfn3a"];
// The real-tool checks need this host's verified age tools from
// MURAGE_BACKUP_TEST_AGE_DIR. Windows has no pinned age build, as in
// backup-schedule-host.node-test.mjs; the in-process checks still run there.
const noRealAge=!backupAgePinForTarget(process.platform,process.arch)&&"no pinned age build for this host";
const ageTools=()=>{const keys=testAgeKeys();return{...keys,keygen:path.join(path.dirname(keys.ageExecutable),"age-keygen")};};
function place(){
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-recovery-key-"))),installation=path.join(root,"installation"),destination=path.join(root,"backups"),safe=path.join(root,"usb");
  for(const folder of [installation,destination,safe])mkdirSync(folder);
  return{root,installation,destination,safe,cleanup:()=>safeWipeSync(root)};
}

test("bech32 follows BIP-173 exactly, including its checksum constant and limits",()=>{
  for(const vector of valid){const decoded=bech32Decode(vector);assert.equal(bech32Encode(decoded.hrp,decoded.words,{words:true}),vector.toLowerCase(),vector);}
  for(const vector of invalid)assert.throws(()=>bech32Decode(vector),/BECH32_INVALID/,JSON.stringify(vector));
});

test("a real age-keygen identity re-derives to the recipient age-keygen printed",{skip:noRealAge},()=>{
  const {identity,recipient}=ageTools();const secret=identity.split("\n").find(line=>line.startsWith("AGE-SECRET-KEY-1"));
  assert.equal(ageIdentityRecipient(secret),recipient);
  assert.throws(()=>ageIdentityRecipient(secret.replace(/.$/,last=>last==="Q"?"P":"Q")),/BECH32_INVALID/);
  assert.throws(()=>ageIdentityRecipient(recipient),/AGE_IDENTITY_INVALID/);
});

test("generated identities are age's own encoding",()=>{
  const key=generateAgeIdentity();try{
    assert.match(key.secret,/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/);assert.match(key.recipient,/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/);
    assert.equal(ageIdentityRecipient(key.secret),key.recipient);assert.notEqual(generateAgeIdentity().recipient,key.recipient);
  }finally{key.dispose();}
});

test("a created key file is age-keygen's format and works with the real age tools",{skip:noRealAge},()=>{
  const p=place(),{ageExecutable,keygen}=ageTools();try{
    const file=path.join(p.safe,"murage-recovery-key.txt"),created=createRecoveryKeyFile({file,installation:p.installation,destination:p.destination,now:Date.parse("2026-09-18T01:02:03.456Z")});
    const text=readFileSync(file,"utf8");
    assert.match(text,/^# created: 2026-09-18T01:02:03Z\n# public key: (age1[a-z0-9]{58})\n(AGE-SECRET-KEY-1[A-Z0-9]{58})\n$/);
    assert.equal(text.split("\n")[1],"# public key: "+created.publicKey);assert.equal(created.label,"murage-recovery-key.txt");assert.equal(created.file,file);
    if(process.platform!=="win32")assert.equal(lstatSync(file).mode&0o777,0o600);
    assert.equal(readBackupIdentity(file,p.installation).recipient,created.publicKey);
    assert.equal(execFileSync(keygen,["-y",file],{encoding:"utf8",env:{PATH:""}}).trim(),created.publicKey);
    const secret="A fixture archive only this key opens.\n",encrypted=execFileSync(ageExecutable,["-r",created.publicKey],{input:secret,env:{PATH:""}});
    assert.equal(encrypted.includes(Buffer.from(secret)),false);
    assert.equal(execFileSync(ageExecutable,["-d","-i",file],{input:encrypted,encoding:"utf8",env:{PATH:""}}),secret);
  }finally{p.cleanup();}
});

test("key files are refused inside the installation or the backup folder and never overwrite",()=>{
  const p=place();try{
    for(const [file,code] of [[path.join(p.installation,"key.txt"),/MUST_BE_INDEPENDENT/],[path.join(p.destination,"key.txt"),/INSIDE_DESTINATION/],[path.join(p.destination,"nested","key.txt"),/LOCATION_INVALID/],["relative-key.txt",/LOCATION_INVALID/]]){
      assert.throws(()=>createRecoveryKeyFile({file,installation:p.installation,destination:p.destination}),code,file);
    }
    // A link into the installation is judged by where it resolves.
    symlinkSync(p.installation,path.join(p.safe,"looks-safe"));
    assert.throws(()=>createRecoveryKeyFile({file:path.join(p.safe,"looks-safe","key.txt"),installation:p.installation,destination:null}),/MUST_BE_INDEPENDENT/);
    assert.equal(lstatSync(p.installation).isDirectory(),true);assert.throws(()=>lstatSync(path.join(p.installation,"key.txt")));
    const existing=path.join(p.safe,"existing.txt");writeFileSync(existing,"keep me");
    assert.throws(()=>createRecoveryKeyFile({file:existing,installation:p.installation,destination:null}),/BACKUP_RECOVERY_KEY_EXISTS/);assert.equal(readFileSync(existing,"utf8"),"keep me");
    const target=path.join(p.safe,"target.txt");writeFileSync(target,"linked");symlinkSync(target,path.join(p.safe,"link.txt"));
    assert.throws(()=>createRecoveryKeyFile({file:path.join(p.safe,"link.txt"),installation:p.installation,destination:null}),/BACKUP_RECOVERY_KEY_EXISTS/);assert.equal(readFileSync(target,"utf8"),"linked");
  }finally{p.cleanup();}
});

test("the dialog flow returns only a label and public key, remembers the folder and fails closed",async()=>{
  const p=place();try{
    let chosen=null;const flow=createRecoveryKeyFlow({installation:()=>p.installation,selectedDestination:async()=>p.destination,chooseFile:async()=>chosen});
    assert.deepEqual(await flow.create(),{cancelled:true});assert.equal(flow.lastFolder(),null);
    chosen=path.join(p.safe,"murage-recovery-key.txt");const result=await flow.create();
    assert.deepEqual(Object.keys(result).sort(),["label","publicKey","saved"]);assert.equal(result.label,"murage-recovery-key.txt");
    assert.equal(JSON.stringify(result).includes("AGE-SECRET"),false);assert.equal(JSON.stringify(result).includes(p.root),false);
    assert.equal(flow.lastFolder(),p.safe);
    chosen=path.join(p.destination,"key.txt");await assert.rejects(flow.create(),/INSIDE_DESTINATION/);
    const dialogs=[];const slow=createRecoveryKeyFlow({installation:()=>p.installation,selectedDestination:async()=>null,chooseFile:()=>new Promise(resolve=>{dialogs.push(resolve);})});
    const first=slow.create(),second=slow.create();assert.equal(dialogs.length,1,"one save dialog at a time");for(const close of dialogs)close(null);
    await assert.rejects(second,/BACKUP_BUSY/);assert.deepEqual(await first,{cancelled:true});
    const locked=createRecoveryKeyFlow({installation:()=>p.installation,selectedDestination:async()=>{throw Error("locked");},chooseFile:async()=>path.join(p.safe,"locked.txt")});
    await assert.rejects(locked.create(),/BACKUP_BINDINGS_UNAVAILABLE/);assert.throws(()=>lstatSync(path.join(p.safe,"locked.txt")));
    let asked=false;const off=createRecoveryKeyFlow({isUsable:()=>false,installation:()=>p.installation,selectedDestination:async()=>null,chooseFile:async()=>{asked=true;return null;}});
    await assert.rejects(off.create(),/BACKUP_UNAVAILABLE/);assert.equal(asked,false);
  }finally{p.cleanup();}
});

test("the save dialog suggests a key name that is not taken yet",()=>{
  const p=place();try{
    assert.equal(suggestRecoveryKeyPath(p.safe),path.join(p.safe,"murage-recovery-key.txt"));
    writeFileSync(path.join(p.safe,"murage-recovery-key.txt"),"first");
    assert.equal(suggestRecoveryKeyPath(p.safe),path.join(p.safe,"murage-recovery-key-2.txt"));
    writeFileSync(path.join(p.safe,"murage-recovery-key-2.txt"),"second");
    assert.equal(suggestRecoveryKeyPath(p.safe),path.join(p.safe,"murage-recovery-key-3.txt"));
    assert.equal(suggestRecoveryKeyPath(null),null);
  }finally{p.cleanup();}
});

test("the key folder is remembered across launches, and only the folder",async()=>{
  const p=place();try{
    const store=recoveryKeyFolderStore(path.join(p.root,"backup-key-folder.json"));
    const suggested=[];let chosen=null;
    const flow=()=>createRecoveryKeyFlow({installation:()=>p.installation,selectedDestination:async()=>p.destination,folderStore:store,defaultFolder:()=>p.root,chooseFile:async suggestion=>{suggested.push(suggestion);return chosen;}});
    const first=flow();
    await first.create();assert.equal(suggested.at(-1),path.join(p.root,"murage-recovery-key.txt"),"first run starts in the default folder");
    chosen=path.join(p.safe,"murage-recovery-key.txt");await first.create();
    // A new flow is a new launch: it starts where the last key went, with a name not taken there.
    const second=flow();assert.equal(second.lastFolder(),p.safe);
    chosen=null;await second.create();assert.equal(suggested.at(-1),path.join(p.safe,"murage-recovery-key-2.txt"));
    const saved=readFileSync(path.join(p.root,"backup-key-folder.json"),"utf8");
    assert.deepEqual(JSON.parse(saved),{version:1,folder:p.safe});assert.equal(saved.includes("AGE-SECRET"),false);
    assert.equal(lstatSync(path.join(p.root,"backup-key-folder.json")).mode&0o077,0);
    // Picking an existing key file in "Choose backup folder and recovery key" remembers its folder too.
    const usb2=path.join(p.root,"usb2");mkdirSync(usb2);second.rememberKeyFile(path.join(usb2,"old-key.txt"));assert.equal(flow().lastFolder(),usb2);
    // A stored value that is not an existing absolute folder is ignored.
    for(const folder of ["relative/folder",path.join(p.root,"gone"),path.join(p.safe,"murage-recovery-key.txt"),42]){
      writeFileSync(path.join(p.root,"backup-key-folder.json"),JSON.stringify({version:1,folder}));assert.equal(flow().lastFolder(),null,String(folder));
    }
    writeFileSync(path.join(p.root,"backup-key-folder.json"),"not json");assert.equal(flow().lastFolder(),null);
  }finally{p.cleanup();}
});

test("an expected refusal is answered as a value with one log line, not a stack trace",async()=>{
  for(const code of ["BACKUP_RECOVERY_KEY_EXISTS","BACKUP_RECOVERY_KEY_INSIDE_DESTINATION","BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT","BACKUP_RECOVERY_KEY_LOCATION_INVALID","BACKUP_BUSY"]){
    const lines=[];
    assert.deepEqual(await settleRecoveryKeyRequest(async()=>{throw new Error(code);},line=>lines.push(line)),{refused:code});
    assert.equal(lines.length,1,code);assert.equal(lines[0].includes("\n"),false);assert.match(lines[0],new RegExp(code));assert.equal(lines[0].includes(" at "),false);
  }
  // Anything unexpected still fails loudly, and success passes through untouched.
  const lines=[];
  await assert.rejects(settleRecoveryKeyRequest(async()=>{throw new Error("BACKUP_RECOVERY_KEY_WRITE_FAILED");},line=>lines.push(line)),/WRITE_FAILED/);
  assert.deepEqual(lines,[]);
  assert.deepEqual(await settleRecoveryKeyRequest(async()=>({cancelled:true}),line=>lines.push(line)),{cancelled:true});
});

test("the desktop app wires the refusal, the name suggestion and the folder memory",()=>{
  const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  assert.match(main,/ipcMain\.handle\("backup-mode:create-recovery-key",[^\n]*settleRecoveryKeyRequest\(\(\)=>backupRecoveryKeys\.create\(\)/);
  assert.match(main,/folderStore:recoveryKeyFolderStore\(path\.join\(app\.getPath\("userData"\),"backup-key-folder\.json"\)\)/);
  assert.match(main,/chooseKey:[^\n]*backupRecoveryKeys\.rememberKeyFile\(/);
  assert.match(main,/chooseFile:async suggested=>/);assert.match(main,/defaultPath:suggested/);
  for(const jargon of ["Choose independent age recovery key","authorize a restart","Save references","owning-user"])assert.equal(main.includes(jargon),false,jargon);
});
