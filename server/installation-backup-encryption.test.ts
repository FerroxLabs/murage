import { existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough,Readable } from "node:stream";
import { expect,it } from "vitest";
import { backupIdentity,backupRecipient,encryptBackupStream,decryptBackupFile,stopBackupAgeProcess } from "./installation-backup-encryption.ts";
import { testAgeKeys } from "./testing/backup-fixture.ts";
it("round trips through pinned age with private identity on stdin; wrong key and tampering refuse",async()=>{
  const keys=testAgeKeys(),other=testAgeKeys(),root=mkdtempSync(join(tmpdir(),"murage-age-roundtrip-test-"));
  try{
    const encrypted=join(root,"backup.age"),plain=join(root,"restored.txt");
    await encryptBackupStream(keys.ageExecutable,keys.recipient,Readable.from(["FAKE-PRIVATE-CONTENT"]),encrypted,{maxBytes:4096});
    expect(readFileSync(encrypted).includes(Buffer.from("FAKE-PRIVATE-CONTENT"))).toBe(false);
    await decryptBackupFile(keys.ageExecutable,keys.identity,encrypted,plain,{maxBytes:4096});expect(readFileSync(plain,"utf8")).toBe("FAKE-PRIVATE-CONTENT");
    await expect(decryptBackupFile(keys.ageExecutable,other.identity,encrypted,join(root,"wrong"),{maxBytes:4096})).rejects.toThrow("AGE_PROCESS_FAILED");
    const bytes=readFileSync(encrypted);bytes[bytes.length-1]^=1;writeFileSync(join(root,"tampered.age"),bytes);
    await expect(decryptBackupFile(keys.ageExecutable,keys.identity,join(root,"tampered.age"),join(root,"tampered"),{maxBytes:4096})).rejects.toThrow("AGE_PROCESS_FAILED");
  }finally{rmSync(root,{recursive:true,force:true});}
});
it("rejects plugin, passphrase and malformed recipient/identity inputs before execution",()=>{
  for(const key of ["AGE-PLUGIN-1COMMAND","ssh-private-key", "AGE-SECRET-KEY-1ABC\nAGE-SECRET-KEY-1DEF"])expect(()=>backupIdentity(key)).toThrow();
  for(const recipient of ["-p","ssh-rsa AAAA","age1\n--plugin"])expect(()=>backupRecipient(recipient)).toThrow();
});
it("bounds an actual tool waiting forever on input and removes output only after close",async()=>{
  const keys=testAgeKeys(),root=mkdtempSync(join(tmpdir(),"murage-age-timeout-test-")),input=new PassThrough(),output=join(root,"partial.age");
  try{
    await expect(encryptBackupStream(keys.ageExecutable,keys.recipient,input,output,{maxBytes:4096,timeoutMs:50,closeTimeoutMs:1000})).rejects.toMatchObject({code:"AGE_TOOL_TIMEOUT"});
    expect(existsSync(output)).toBe(false);expect(input.destroyed).toBe(true);
  }finally{input.destroy();rmSync(root,{recursive:true,force:true});}
});
it("never reports an unobserved close after bounded TERM and KILL attempts",async()=>{
  const signals:NodeJS.Signals[]=[];
  const result=await stopBackupAgeProcess({kill:signal=>signals.push(signal)},()=>false,new Promise(()=>{}),2);
  expect(result).toBe(false);expect(signals).toEqual(["SIGTERM","SIGKILL"]);
});
