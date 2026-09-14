import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "../message-tables.ts";
import { initializeImageOperations } from "../image-operations-schema.ts";
import { migrateMemorySchema } from "../memory/schema.ts";
import { backupAgePinForTarget } from "../../shared/backup-age-pin.ts";
export function testAgeKeys(){
  const directory=process.env.MURAGE_BACKUP_TEST_AGE_DIR;
  if(!directory)throw Error("MURAGE_BACKUP_TEST_AGE_DIR must name the verified fixture tool directory");
  const keygen=join(directory,"age-keygen");
  const pin=backupAgePinForTarget(process.platform,process.arch);
  if(!pin||createHash("sha256").update(readFileSync(keygen)).digest("hex")!==pin.keygenSha256)throw Error("Unverified fixture key generator");
  const identity=execFileSync(keygen,[],{encoding:"utf8",env:{PATH:""},stdio:["ignore","pipe","pipe"],maxBuffer:4096});
  const recipient=execFileSync(keygen,["-y"],{input:identity,encoding:"utf8",env:{PATH:""},stdio:["pipe","pipe","pipe"],maxBuffer:4096}).trim();
  return{ageExecutable:join(directory,"age"),identity,recipient};
}
export function backupFixture(){
  const parent=mkdtempSync(join(tmpdir(),"murage-encrypted-backup-test-")),data=join(parent,"installation");mkdirSync(data);
  writeFileSync(join(data,"config.json"),JSON.stringify({profile:{name:"Fixture"},instances:{fixture:{driver:"fuigoAgent",enabled:true,config:{apiKey:"FAKE-CREDENTIAL-CANARY"}}},appearance:{skin:"light"}})+"\n");
  writeFileSync(join(data,"bots.json"),JSON.stringify([{id:"bot",threadId:"thread",name:"Fixture",resumeCursors:{fixture:"native-cursor"},autoApprove:true,notifications:true}])+"\n");
  writeFileSync(join(data,"groups.json"),"[]\n");
  mkdirSync(join(data,"workspaces"));writeFileSync(join(data,"workspaces","report.md"),"# Saved output\n");
  const db=new DatabaseSync(join(data,"messages.db"));db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;");initializeMessageTables(db);initializeImageOperations(db);migrateMemorySchema(db,"active");
  const message={id:"message",at:1,role:"user",kind:"text",text:"WAL-visible transcript"};
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread","message",1,"user","text",message.text,JSON.stringify(message));db.exec("INSERT INTO thread_state VALUES('thread','message')");
  db.exec("INSERT INTO image_operations VALUES('operation','generation','request-hash','publish-pending',NULL,1)");
  db.exec("INSERT INTO memory_tombstones VALUES('tombstone','record','forgotten',1,NULL,1,'forgotten',1); UPDATE memory_meta SET deletion_epoch=1");
  return{parent,data,db};
}
