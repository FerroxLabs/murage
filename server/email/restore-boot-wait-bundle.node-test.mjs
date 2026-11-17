import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Worker} from "node:worker_threads";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";
test("D5 actual Cloud bundle worker publishes the row",async()=>{
 const source=readFileSync("dist-server/index.js","utf8"),sf=ts.createSourceFile("index.js",source,ts.ScriptTarget.Latest,true),bodies=new Map();
 const walk=n=>{if(ts.isFunctionDeclaration(n)&&n.name)bodies.set(n.name.text,n.getText(sf));ts.forEachChild(n,walk);};walk(sf);
 assert.equal(typeof bodies.get("publishBootWaitRow"),"string");assert.equal(typeof bodies.get("workerPublish"),"string");
 const publish=vm.runInNewContext(`(${bodies.get("publishBootWaitRow")})`,{}),workerSource=bodies.get("workerPublish"),workerName=/new ([A-Za-z_$][\w$]*)\(/.exec(workerSource)[1],worker=vm.runInNewContext(`(${workerSource})`,{[workerName]:Worker,publishBootWaitRow:publish});
 const root=mkdtempSync(join(tmpdir(),"j4d3-bundle-")),file=join(root,"messages.db");
 try{const db=new DatabaseSync(file);db.exec("CREATE TABLE restore_job_marks(kind TEXT PRIMARY KEY,job_id TEXT NOT NULL);INSERT INTO restore_job_marks VALUES('prepared','bundle')");db.close();const h=worker({dbPath:file,jobId:"bundle",cause:"backup",elapsedMs:1000,outcome:"freed",at:1800000000000,bootId:"boot-A",upMs:1000});assert.equal(await h.result,"saved");await h.exited;const check=new DatabaseSync(file);try{assert.equal(check.prepare("SELECT job_id FROM restore_boot_wait").get().job_id,"bundle");}finally{check.close();}}finally{rmSync(root,{recursive:true,force:true});}
});
