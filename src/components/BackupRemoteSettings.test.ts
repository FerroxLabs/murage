import {it,expect} from "vitest";
import {remoteBackupInput,remoteBackupStatus,remoteBackupError,remoteBackupCatalogue,remoteRetentionPolicy,remoteRetentionPreview,type RemoteDraft} from "./BackupRemoteSettings";
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
it("retention status, policy and preview projections are bounded and never invent removals",()=>{
 const status={supported:true,pending:false,configured:true,state:"connected",revision:2,remoteRef:"remote-one",maintenanceSelected:true};
 expect(remoteBackupStatus(status).maintenanceSelected).toBe(true);expect(remoteBackupStatus({...status,maintenanceSelected:"yes"}).maintenanceSelected).toBe(false);
 expect(remoteBackupStatus({...status,lastUpload:{state:"verified",jobId:"a".repeat(64),lockRelease:"unconfirmed"}}).lastUpload).toEqual({state:"verified",jobId:"a".repeat(64),lockRelease:"unconfirmed"});
 expect(remoteBackupStatus({...status,retention:{state:"needs-review",removed:2,error:"prune-failed",previewId:"1".repeat(64),lockRelease:"unconfirmed",private:"CANARY"}}).retention).toEqual({state:"needs-review",removed:2,error:"prune-failed",previewId:"1".repeat(64),lockRelease:"unconfirmed"});
 for(const retention of [null,{state:"deleted"},{state:"complete",removed:-1},{state:"complete",error:"PRIVATE"},{state:"complete",previewId:"../x"}])expect(()=>remoteBackupStatus({...status,retention})).toThrow();
 const blank={keepLast:"",keepDaily:"",keepWeekly:"",keepMonthly:""};
 expect(remoteRetentionPolicy({...blank,keepLast:"3",keepWeekly:" 4 "})).toEqual({keepLast:3,keepWeekly:4});
 for(const keepLast of ["","0","1001","2.5","-1","1e2"])expect(remoteRetentionPolicy({...blank,keepLast})).toBeNull();
 expect(remoteRetentionPreview({previewId:"1".repeat(64),remove:["2".repeat(64)],keep:1,private:"CANARY"})).toEqual({previewId:"1".repeat(64),remove:["2".repeat(64)],keep:1,lockRelease:false});
 for(const value of [null,{previewId:"x",remove:[],keep:1},{previewId:"1".repeat(64),remove:["../x"],keep:1},{previewId:"1".repeat(64),remove:[],keep:0}])expect(()=>remoteRetentionPreview(value)).toThrow();
 expect(remoteBackupError(Error("BACKUP_REMOTE_MAINTENANCE_REQUIRED"))).toContain("maintenance access key");expect(remoteBackupError(Error("BACKUP_REMOTE_RETENTION_CHANGED"))).toContain("Nothing was removed");
});
it("SFTP fields are validated in the window the same way main validates them",async()=>{
 const {remoteSftpInput}=await import("./BackupRemoteSettings");
 const sftp={label:"Home NAS",host:" nas.example.com ",port:"22",user:"backup",folder:"murage-backups/"};
 expect(remoteSftpInput(sftp)).toEqual({kind:"sftp",label:"Home NAS",host:"nas.example.com",port:22,user:"backup",folder:"murage-backups"});
 expect(remoteSftpInput({...sftp,host:"[::1]"})?.host).toBe("::1");
 for(const patch of [{host:"-oProxyCommand=x"},{host:"nas example"},{user:"-l"},{folder:"../x"},{folder:"my backups"},{port:"0"},{port:"65536"},{port:"22a"},{label:""}])expect(remoteSftpInput({...sftp,...patch})).toBeNull();
});
it("SFTP status projects only public details and refusals",()=>{
 const value={supported:true,pending:false,configured:true,state:"connected",revision:3,remoteRef:"remote-one",kind:"sftp",serverCheck:"host-key-changed",privateKey:"PRIVATE_CANARY",
  sftp:{host:"nas.example.com",port:22,user:"backup",folder:"murage-backups",publicKey:"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc murage-backup",fingerprint:"SHA256:"+"A".repeat(43),privateKey:"PRIVATE_CANARY"}};
 const status=remoteBackupStatus(value);expect(JSON.stringify(status)).not.toContain("PRIVATE_CANARY");
 expect(status).toMatchObject({kind:"sftp",serverCheck:"host-key-changed",sftp:{host:"nas.example.com",fingerprint:"SHA256:"+"A".repeat(43)}});
 for(const sftp of [{...value.sftp,host:"-x"},{...value.sftp,publicKey:"-----BEGIN OPENSSH PRIVATE KEY-----"},{...value.sftp,fingerprint:"MD5:aa"},undefined])expect(()=>remoteBackupStatus({...value,sftp})).toThrow();
 expect(remoteBackupStatus({...value,serverCheck:"other"}).serverCheck).toBeUndefined();
});
it("SFTP refusals are explained in plain words, Windows says how to add OpenSSH",()=>{
 expect(remoteBackupError(Error("BACKUP_REMOTE_HOST_KEY_CHANGED"))).toContain("identity is not the one you trusted");
 expect(remoteBackupError(Error("BACKUP_REMOTE_KEY_REFUSED"))).toContain("did not accept Murage's key");
 expect(remoteBackupError(Error("BACKUP_REMOTE_SSH_MISSING_WINDOWS"))).toContain("Optional features");
 expect(remoteBackupError(Error("BACKUP_REMOTE_FOLDER_NOT_EMPTY"))).toContain("empty folder");
 expect(remoteBackupError(Error("BACKUP_REMOTE_WRONG_PASSWORD"))).toContain("password file");
});
it("every create-or-open refusal has its own plain sentence, never a bare code",()=>{
 const generic=remoteBackupError(Error("SOMETHING_ELSE"));
 for(const code of ["BACKUP_REMOTE_STORAGE_UNREACHABLE","BACKUP_REMOTE_CREATE_FAILED","BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE","BACKUP_REMOTE_PASSWORD_NOT_CREATED","BACKUP_REMOTE_PASSWORD_COPY_FAILED","BACKUP_REMOTE_TOOL_UNVERIFIED","BACKUP_REMOTE_KEYS_UNREADABLE","BACKUP_REMOTE_NOT_A_REPOSITORY","BACKUP_REMOTE_SETUP_INTERRUPTED","BACKUP_REMOTE_HOST_KEY_CHANGED","BACKUP_REMOTE_TRUST_CHANGED","BACKUP_REMOTE_KEY_REFUSED","BACKUP_REMOTE_SSH_MISSING","BACKUP_REMOTE_SFTP_UNAVAILABLE","BACKUP_REMOTE_SERVER_UNREACHABLE","BACKUP_REMOTE_FOLDER_NOT_EMPTY","BACKUP_REMOTE_FOLDER_NOT_WRITABLE","BACKUP_REMOTE_FOLDER_INVALID","BACKUP_REMOTE_WRONG_PASSWORD","BACKUP_REMOTE_REPOSITORY_CHANGED"]){
  const text=remoteBackupError(Error(`Error invoking remote method 'backup-remote:testConnection': Error: ${code}`));
  expect(text,code).not.toBe(generic);expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+|—|\bsafe/);
 }
});
it("a shared data folder is shown with its path and fix, never a bare code",()=>{
 const status=remoteBackupStatus({supported:true,pending:false,configured:false,state:"blocked",blocked:{reason:"data-folder-shared",folder:"/home/sam/work"}});
 expect(status.blocked).toEqual({reason:"data-folder-shared",folder:"/home/sam/work"});
 expect(()=>remoteBackupStatus({supported:true,pending:false,configured:false,state:"blocked",blocked:{reason:"other",folder:"/x"}})).toThrow();
 expect(remoteBackupError(Error("Error invoking remote method 'backup-remote:save': Error: BACKUP_REMOTE_DATA_FOLDER_SHARED"))).toContain("Remove their write access");
});
