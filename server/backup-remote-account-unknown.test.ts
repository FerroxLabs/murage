// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nops B: an SDDL account Murage cannot identify keeps its own code, and with it the fix-it sentence, through the host on every password path.
import {describe,expect,it} from "vitest";
import {createBackupRemoteHost,BACKUP_REMOTE_BINDING_KEY} from "./backup-remote-host.ts";

const CODE="BACKUP_REMOTE_PASSWORD_ACCOUNT_UNKNOWN_WINDOWS";
const receipt={jobId:"a".repeat(64),installationRef:"install",destinationRef:"local",selectionHash:"b".repeat(64),snapshotId:"97d4fa8e-2c50-4cba-a66f-a7bb84b13d42",artifactRef:"artifact",sha256:"c".repeat(64),bytes:10,verifiedAt:1};
const input={kind:"s3",label:"Bucket",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"auto",credentials:{accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}};
function build(extra:Record<string,unknown>){
 let document:Record<string,unknown>={},count=0;
 const host=createBackupRemoteHost({supported:()=>true,readProtected:async()=>structuredClone(document),updateProtected:async (derive:(current:Record<string,unknown>)=>Record<string,unknown>)=>{document=derive(structuredClone(document));},
  selectPassword:async()=>({passwordRef:"independent-password"}),latestVerified:async()=>({archivePath:"/host/verified.age",receipt}),latestReceipt:()=>receipt,now:()=>10,createId:()=>`ref-${++count}`,
  forgetLocalState:()=>{},createAdapter:()=>({connectionStatus:()=>({state:"disconnected",repositoryId:"d".repeat(64)}),connect:async()=>{throw Error(CODE);},prepareRepository:async()=>{throw Error(CODE);}}),...extra} as never);
 return{host,document:()=>document};
}
async function saved(f:ReturnType<typeof build>){await f.host.save(0,input);const ref=(await f.host.status()).remoteRef!;return ref;}
// The window turns exactly this code into the fix-it sentence (src/components/BackupRemoteSettings.test.ts, remoteBackupError).
const shownFor=async(work:Promise<unknown>)=>{const error=await work.then(()=>undefined,(e:unknown)=>e as Error);expect(error).toBeInstanceOf(Error);return (error as Error).message;};

describe("an unresolved SDDL account reaches the window as the code that shows the fix-it sentence",()=>{
 it("create",async()=>{
  const f=build({createPassword:async()=>{throw Error(CODE);}}),ref=await saved(f);
  expect(await shownFor(f.host.createRepositoryPassword(ref,1))).toBe(CODE);
 });
 it("copy",async()=>{
  const f=build({copyPassword:async()=>{throw Error(CODE);}}),ref=await saved(f);await f.host.selectRepositoryPassword(ref,1);
  expect(await shownFor(f.host.saveRepositoryPasswordCopy(ref,2))).toBe(CODE);
 });
 it("select",async()=>{
  const f=build({selectPassword:async()=>{throw Error(CODE);}}),ref=await saved(f);
  expect(await shownFor(f.host.selectRepositoryPassword(ref,1))).toBe(CODE);
 });
 it("read (the stored password read when the connection is tested)",async()=>{
  const f=build({}),ref=await saved(f);await f.host.selectRepositoryPassword(ref,1);
  expect(await shownFor(f.host.testConnection(ref,2))).toBe(CODE);
  expect(f.document()[BACKUP_REMOTE_BINDING_KEY]).toBeDefined();
 });
});
