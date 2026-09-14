import {it,expect,vi} from "vitest";
import {createBackupRemoteHost,BACKUP_REMOTE_BINDING_KEY} from "./backup-remote-host.ts";
const input={label:"Remote backup",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"path",credentials:{accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}};
const receipt={jobId:"a".repeat(64),installationRef:"install",destinationRef:"local",selectionHash:"b".repeat(64),snapshotId:"97d4fa8e-2c50-4cba-a66f-a7bb84b13d42",artifactRef:"artifact",sha256:"c".repeat(64),bytes:10,verifiedAt:1};
function fixture(){
 let document:Record<string,unknown>={untouched:"preserve"},count=0;
 const connected=new Map<number,string>();
 const connect=vi.fn(async(binding:any)=>{connected.set(binding.target.revision,"d".repeat(64));return{connected:true,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)};});
 const store=vi.fn(async(_path:string,_receipt:any)=>({state:"verified",snapshotId:"e".repeat(64)}));
 const selectPassword=vi.fn(async()=>({passwordRef:"independent-password"}));
 const latest=vi.fn(async()=>({archivePath:"/host/verified.age",receipt}));
 const chooseDownload=vi.fn<()=>Promise<string|null>>(async()=>"/chosen-download-folder");
 const exportDownloaded=vi.fn(async(_copy:unknown,_folder:string)=>({saved:true,archivePath:"/chosen-download-folder/new/backup.age",directory:"/chosen-download-folder/new"}));
 const list=vi.fn(async()=>({repositoryId:"d".repeat(64),backups:[{snapshotId:"e".repeat(64),jobId:receipt.jobId,createdAt:1,verified:false as const}],ignored:0}));
 const download=vi.fn(async(id:string)=>({state:"downloaded-verified" as const,snapshotId:id,repositoryId:"d".repeat(64),archivePath:"/private-copy/backup.age",receiptPath:"/private-copy/receipt.json",receipt}));
 const read=vi.fn(async()=>structuredClone(document));
 let current:typeof receipt|undefined=receipt;
 const rebuild=()=>createBackupRemoteHost({supported:()=>true,readProtected:read,updateProtected:async derive=>{document=derive(document);},selectPassword,latestVerified:latest,latestReceipt:()=>current,now:()=>10,chooseDownloadFolder:chooseDownload,exportDownloaded,createId:()=>`ref-${++count}`,createAdapter:binding=>({listBackups:list,downloadBackup:download,connectionStatus:()=>({state:connected.has(binding.target.revision)?"connected":"disconnected",repositoryId:connected.get(binding.target.revision)}),connect:()=>connect(binding),store})});
 const host=rebuild();
 return{host,rebuild,connected,setReceipt:(next:typeof receipt|undefined)=>{current=next;if(next)latest.mockResolvedValue({archivePath:"/host/verified.age",receipt:next});},connect,store,selectPassword,latest,chooseDownload,exportDownloaded,list,download,document:()=>document,setDocument:(value:Record<string,unknown>)=>{document=value;}};
}
async function configured(f:ReturnType<typeof fixture>){await f.host.save(0,input);const saved=await f.host.status();await f.host.selectRepositoryPassword(saved.remoteRef,1);return(await f.host.status()).remoteRef;}
it("saving and status use protected storage without network or exposed credentials",async()=>{
 const f=fixture();expect(await f.host.status()).toMatchObject({configured:false,revision:0});await f.host.save(0,input);
 expect(f.document().untouched).toBe("preserve");expect(String(f.document()[BACKUP_REMOTE_BINDING_KEY])).toContain("FAKE_SECRET");
 const status=await f.host.status();expect(status).toMatchObject({configured:true,state:"password-required",revision:1});expect(JSON.stringify(status)).not.toMatch(/FAKE_|https:|fixture-bucket/);expect(f.connect).not.toHaveBeenCalled();expect(f.store).not.toHaveBeenCalled();
});
it("requires independent password selection and explicit existing-repository connection",async()=>{
 const f=fixture();await f.host.save(0,input);const ref=(await f.host.status()).remoteRef;await expect(f.host.connect(ref,1)).rejects.toThrow("PASSWORD_REQUIRED");
 await f.host.selectRepositoryPassword(ref,1);expect(f.connect).not.toHaveBeenCalled();expect(await f.host.status()).toMatchObject({state:"disconnected",revision:2});await f.host.connect(ref,2);expect(f.connect).toHaveBeenCalledTimes(1);expect(await f.host.status()).toMatchObject({state:"connected"});
});
it("rejects stale saves, absent identifiers and injected host fields without mutation",async()=>{
 const f=fixture();await f.host.save(0,input);const before=structuredClone(f.document());await expect(f.host.save(0,input)).rejects.toThrow("CHANGED");
 for(const extra of [{archivePath:"/private"},{passwordRef:"steal"},{remoteRef:"foreign"},{command:"init"}])await expect(f.host.save(1,{...input,...extra})).rejects.toThrow("INPUT_INVALID");
 await expect(f.host.connect(undefined,1)).rejects.toThrow("CHANGED");expect(f.document()).toEqual(before);expect(f.connect).not.toHaveBeenCalled();
});
it("uploads only the requested latest host-bound verified artifact",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);
 await expect(f.host.uploadLatest(ref,2,"f".repeat(64))).rejects.toThrow("JOB_CHANGED");expect(f.store).not.toHaveBeenCalled();
 expect(await f.host.uploadLatest(ref,2,receipt.jobId)).toMatchObject({state:"verified",jobId:receipt.jobId});expect(f.store).toHaveBeenCalledWith("/host/verified.age",receipt);
});
it("blocks overlapping changes while connection runs and does not replay failed connection",async()=>{
 const f=fixture(),ref=await configured(f);let release!:()=>void;
 f.connect.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});throw Error("PRIVATE_PROVIDER_SECRET");});
 const run=f.host.connect(ref,2);await vi.waitFor(()=>expect(release).toBeTypeOf("function"));expect((await f.host.status()).pending).toBe(true);
 await expect(f.host.save(2,input)).rejects.toThrow("BUSY");release();await expect(run).rejects.toThrow("BACKUP_REMOTE_REVIEW_REQUIRED");expect(f.connect).toHaveBeenCalledTimes(1);expect(f.host.isPending()).toBe(false);
});
it("corrupt protected state and invalid adapter success never leak or become verified",async()=>{
 const f=fixture();f.setDocument({[BACKUP_REMOTE_BINDING_KEY]:"PRIVATE_INVALID_JSON"});expect(await f.host.status()).toMatchObject({state:"needs-review"});
 await expect(f.host.save(0,input)).rejects.toThrow("REVIEW_REQUIRED");const g=fixture(),ref=await configured(g);g.store.mockResolvedValueOnce({state:"verified",snapshotId:"not-a-hash"});await expect(g.host.uploadLatest(ref,2,receipt.jobId)).rejects.toThrow("REVIEW_REQUIRED");
});
it("changing protected destination invalidates old connection and preserves other fields",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);await f.host.save(2,{...input,prefix:"new-prefix"});
 expect(await f.host.status()).toMatchObject({state:"disconnected",passwordSelected:true,revision:3,remoteRef:ref});await expect(f.host.connect(ref,2)).rejects.toThrow("CHANGED");expect(f.document().untouched).toBe("preserve");
});
it("recovery picker cancellation performs no download and successful export never needs latest local file",async()=>{
 const f=fixture(),ref=await configured(f);const listing=await f.host.listBackups(ref,2);expect(listing.backups[0].verified).toBe(false);
 f.chooseDownload.mockResolvedValueOnce(null);expect(await f.host.downloadBackup(ref,2,"e".repeat(64))).toEqual({cancelled:true});expect(f.download).not.toHaveBeenCalled();expect(f.exportDownloaded).not.toHaveBeenCalled();
 expect(await f.host.downloadBackup(ref,2,"e".repeat(64))).toMatchObject({saved:true,archivePath:"/chosen-download-folder/new/backup.age"});expect(f.download).toHaveBeenCalledWith("e".repeat(64));expect(f.exportDownloaded.mock.calls[0][1]).toBe("/chosen-download-folder");expect(f.latest).not.toHaveBeenCalled();
});
it("stale recovery requests and mismatched downloads are never exported",async()=>{
 const f=fixture(),ref=await configured(f);await expect(f.host.downloadBackup(ref,1,"e".repeat(64))).rejects.toThrow("CHANGED");expect(f.chooseDownload).not.toHaveBeenCalled();
 f.download.mockImplementationOnce(async()=>({state:"downloaded-verified",snapshotId:"f".repeat(64),repositoryId:"d".repeat(64),archivePath:"/private/backup.age",receiptPath:"/private/receipt.json",receipt}));await expect(f.host.downloadBackup(ref,2,"e".repeat(64))).rejects.toThrow("REVIEW_REQUIRED");expect(f.exportDownloaded).not.toHaveBeenCalled();
});
it("automatic upload defaults off and explicit consent requires exact connected revision",async()=>{
 const f=fixture(),ref=await configured(f);expect(await f.host.runAutomaticUpload()).toEqual({state:"disabled"});
 await expect(f.host.setAutomaticUpload(ref,2,true)).rejects.toThrow("REVIEW_REQUIRED");
 await f.host.connect(ref,2);
 await expect(f.host.setAutomaticUpload(ref,1,true)).rejects.toThrow("CHANGED");
 await expect(f.host.setAutomaticUpload("foreign",2,true)).rejects.toThrow("CHANGED");
 await expect(f.host.setAutomaticUpload(ref,2,"true")).rejects.toThrow("INPUT_INVALID");
 expect(f.store).not.toHaveBeenCalled();expect(f.latest).not.toHaveBeenCalled();
 await f.host.setAutomaticUpload(ref,2,true);
 expect(await f.host.status()).toMatchObject({automaticUpload:{enabled:true,state:"enabled"}});
 expect(JSON.stringify(await f.host.status())).not.toMatch(/FAKE_|https:|fixture-bucket|after|paused/);
});
it("opt-in and reconstructed hosts skip history, preserve repeated consent and upload only future verified receipts once",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);await f.host.setAutomaticUpload(ref,2,true);
 expect(await f.rebuild().runAutomaticUpload()).toEqual({state:"not-due"});expect(f.latest).not.toHaveBeenCalled();
 const future={...receipt,jobId:"f".repeat(64),verifiedAt:11};f.setReceipt(future);
 await f.rebuild().setAutomaticUpload(ref,2,true);
 expect(await f.rebuild().runAutomaticUpload()).toMatchObject({state:"verified",jobId:future.jobId});
 expect(f.store).toHaveBeenCalledWith("/host/verified.age",future);
 expect(await f.rebuild().runAutomaticUpload()).toEqual({state:"not-due"});expect(f.store).toHaveBeenCalledTimes(1);
});
it("empty initial receipt still excludes historical timestamps and target or password changes revoke policy",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);f.setReceipt(undefined);await f.host.setAutomaticUpload(ref,2,true);
 f.setReceipt(receipt);expect(await f.host.runAutomaticUpload()).toEqual({state:"not-due"});
 await f.host.save(2,input);expect(await f.host.runAutomaticUpload()).toEqual({state:"disabled"});
 await f.host.connect(ref,3);await f.host.setAutomaticUpload(ref,3,true);await f.host.selectRepositoryPassword(ref,3);
 expect(await f.host.runAutomaticUpload()).toEqual({state:"disabled"});expect(f.store).not.toHaveBeenCalled();
});
it("uncertain automatic stores persist a review pause through restart and repeated consent",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);await f.host.setAutomaticUpload(ref,2,true);
 f.setReceipt({...receipt,jobId:"f".repeat(64),verifiedAt:11});f.store.mockImplementationOnce(async()=>{throw Error("PRIVATE_FAILURE");});
 await expect(f.host.runAutomaticUpload()).rejects.toThrow("BACKUP_REMOTE_REVIEW_REQUIRED");
 await f.rebuild().setAutomaticUpload(ref,2,true);expect(await f.rebuild().runAutomaticUpload()).toEqual({state:"needs-review"});
 expect(await f.host.status()).toMatchObject({automaticUpload:{enabled:true,state:"needs-review"}});expect(f.store).toHaveBeenCalledTimes(1);
 await f.host.setAutomaticUpload(ref,2,false);await f.host.setAutomaticUpload(ref,2,true);
 expect(await f.host.runAutomaticUpload()).toEqual({state:"not-due"});expect(f.store).toHaveBeenCalledTimes(1);
});
it("automatic upload refuses changed verified receipt and disconnected target without store",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);await f.host.setAutomaticUpload(ref,2,true);
 const future={...receipt,jobId:"f".repeat(64),verifiedAt:11};f.setReceipt(future);
 f.latest.mockResolvedValueOnce({archivePath:"/host/verified.age",receipt:{...future,sha256:"9".repeat(64)}});
 await expect(f.host.runAutomaticUpload()).rejects.toThrow("JOB_CHANGED");expect(f.store).not.toHaveBeenCalled();
 f.connected.clear();expect(await f.host.runAutomaticUpload()).toEqual({state:"needs-review"});expect(f.store).not.toHaveBeenCalled();
});
it("automatic store shares the operation lock and a durable pause is visible before unknown completion",async()=>{
 const f=fixture(),ref=await configured(f);await f.host.connect(ref,2);await f.host.setAutomaticUpload(ref,2,true);f.setReceipt({...receipt,jobId:"f".repeat(64),verifiedAt:11});
 let release!:()=>void;f.store.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return{state:"needs-review",snapshotId:"e".repeat(64)};});
 const run=f.host.runAutomaticUpload();await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
 await expect(f.host.setAutomaticUpload(ref,2,false)).rejects.toThrow("BUSY");await expect(f.host.uploadLatest(ref,2,"f".repeat(64))).rejects.toThrow("BUSY");
 expect(await f.rebuild().runAutomaticUpload()).toEqual({state:"needs-review"});release();expect(await run).toMatchObject({state:"needs-review"});
 expect(await f.host.runAutomaticUpload()).toEqual({state:"needs-review"});expect(f.store).toHaveBeenCalledTimes(1);
});
