import {it,expect} from "vitest";
import {remoteBackupInput,remoteBackupStatus,remoteBackupError,remoteBackupCatalogue,type RemoteDraft} from "./BackupRemoteSettings";
const draft:RemoteDraft={label:"Backup",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"auto",accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET",sessionToken:""};
it("validates explicit S3 settings without choosing a provider or embedding credentials in URLs",()=>{
 expect(remoteBackupInput(draft)).toMatchObject({endpoint:draft.endpoint,credentials:{accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}});
 for(const patch of [{endpoint:"http://example.invalid"},{endpoint:"https://key:secret@example.invalid"},{bucket:"../outside"},{prefix:"../outside"},{region:""},{secretAccessKey:""},{sessionToken:"bad\nsecret"}])expect(remoteBackupInput({...draft,...patch})).toBeNull();
});
it("projects only safe status and rejects malformed binding states",()=>{
 const value={supported:true,pending:false,configured:true,state:"connected",revision:2,remoteRef:"remote-one",label:"Backup",passwordSelected:true,privateKey:"PRIVATE_CANARY"};
 expect(JSON.stringify(remoteBackupStatus(value))).not.toContain("PRIVATE_CANARY");
 for(const patch of [{revision:-1},{remoteRef:"../outside"},{state:"maybe-success"},{pending:"false"}])expect(()=>remoteBackupStatus({...value,...patch})).toThrow();
 expect(remoteBackupStatus({...value,lastUpload:{state:"needs-review",jobId:"a".repeat(64),privateKey:"HIDDEN"}}).lastUpload).toEqual({state:"needs-review",jobId:"a".repeat(64)});
 expect(()=>remoteBackupStatus({...value,lastUpload:{state:"verified",jobId:"../outside"}})).toThrow();
});
it("unknown errors never echo provider text or recommend automatic retry",()=>{
 expect(remoteBackupError(Error("PRIVATE_CANARY https://secret.example"))).not.toMatch(/PRIVATE_CANARY|secret.example/);
 expect(remoteBackupError(Error("BACKUP_REMOTE_CHANGED"))).toContain("destination changed");
 expect(remoteBackupError(Error("BACKUP_REMOTE_JOB_CHANGED"))).toContain("local backup changed");
});
it("recovery catalogue is bounded, unverified and strips private metadata",()=>{
 const row={snapshotId:"a".repeat(64),createdAt:1,verified:false,private:"CANARY"};expect(remoteBackupCatalogue({backups:[row],ignored:0})).toEqual({backups:[{snapshotId:row.snapshotId,createdAt:1}],ignored:0});
 for(const backups of [[row,row],[{...row,verified:true}],[{...row,createdAt:NaN}],[{...row,snapshotId:"../outside"}],Array(1001).fill(row)])expect(()=>remoteBackupCatalogue({backups,ignored:0})).toThrow();
});
it("automatic policy status is explicit, safe and rejects contradictory consent",()=>{
 const status={supported:true,pending:false,configured:true,state:"connected",revision:2,remoteRef:"remote-one"};
 expect(remoteBackupStatus(status).automaticUpload).toBeUndefined();
 for(const policy of [{enabled:false,state:"disabled"},{enabled:true,state:"enabled"},{enabled:true,state:"needs-review"}])expect(remoteBackupStatus({...status,automaticUpload:{...policy,private:"CANARY"}}).automaticUpload).toEqual(policy);
 for(const policy of [null,{enabled:"true",state:"enabled"},{enabled:false,state:"enabled"},{enabled:true,state:"disabled"},{enabled:true,state:"retrying"}])expect(()=>remoteBackupStatus({...status,automaticUpload:policy})).toThrow();
});
