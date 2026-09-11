// Execute the actual small startup block with injected Electron methods; no app launch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyLoginProfileArguments } from "./background-login.mjs";

const source=fs.readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
const start=source.indexOf("// Explicit fixture/profile isolation");
const end=source.indexOf("const { desktopCapabilities, nativeDesktopActions }",start);
assert(start>=0&&end>start,"Actual isolated startup block must exist");
// The block calls the real sign-in profile argument parser first, so inject the actual module export.
const run=new Function("app","process","fs","path","applyLoginProfileArguments",source.slice(start,end));
function context(env,argv=[]){const calls=[];return {calls,env,run:()=>run({setPath:(key,value)=>calls.push([key,value]),setAppLogsPath:value=>calls.push(["logs",value])},{env,argv},fs,path,applyLoginProfileArguments)};}

test("ordinary installed launches keep default user data, session and log paths",()=>{
  const fixture=context({});fixture.run();assert.deepEqual(fixture.calls,[]);
});

test("explicit paired roots configure Electron before instance lock and credential path resolution",()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));
  try{
    const user=path.join(root,"user"),data=path.join(root,"data");fs.mkdirSync(user);fs.mkdirSync(data);
    const fixture=context({MURAGE_USER_DATA:user,MURAGE_DATA_DIR:data});fixture.run();
    const canonical=fs.realpathSync(user);
    assert.deepEqual(fixture.calls,[["userData",canonical],["sessionData",canonical],["logs",path.join(canonical,"logs")]]);
    assert(source.indexOf('app.setPath("userData"')<source.indexOf("app.requestSingleInstanceLock()"));
    assert(source.indexOf('app.setPath("userData"')<source.indexOf("let CREDENTIALS_FILE"));
    assert(source.indexOf("applyLoginProfileArguments(process.argv,process.env)")<source.indexOf('app.setPath("userData"'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("sign-in launch arguments select the paired roots before the isolation block runs",()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));
  try{
    const user=path.join(root,"user"),data=path.join(root,"data");fs.mkdirSync(user);fs.mkdirSync(data);
    const fixture=context({},["electron","--murage-login","--murage-data-dir",data,"--murage-user-data",user]);fixture.run();
    const canonical=fs.realpathSync(user);
    assert.equal(fixture.env.MURAGE_USER_DATA,user);assert.equal(fixture.env.MURAGE_DATA_DIR,data);
    assert.deepEqual(fixture.calls,[["userData",canonical],["sessionData",canonical],["logs",path.join(canonical,"logs")]]);
    // Without the sign-in flag the same arguments are inert and ordinary launches stay on default paths.
    const plain=context({},["electron","--murage-data-dir",data,"--murage-user-data",user]);plain.run();
    assert.deepEqual(plain.env,{});assert.deepEqual(plain.calls,[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("invalid or unpaired roots fail before any Electron path changes",()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),"murage-memory-profile-"));
  try{
    const user=path.join(root,"user"),data=path.join(root,"data"),file=path.join(root,"file"),link=path.join(root,"link");
    fs.mkdirSync(user);fs.mkdirSync(data);fs.writeFileSync(file,"fixture");
    // Directory junctions avoid requiring Windows symlink elevation.
    fs.symlinkSync(user,link,process.platform==="win32"?"junction":"dir");
    for(const env of [
      {MURAGE_USER_DATA:user},
      {MURAGE_USER_DATA:"",MURAGE_DATA_DIR:data},
      {MURAGE_USER_DATA:"relative",MURAGE_DATA_DIR:data},
      {MURAGE_USER_DATA:user,MURAGE_DATA_DIR:"relative"},
      {MURAGE_USER_DATA:file,MURAGE_DATA_DIR:data},
      {MURAGE_USER_DATA:link,MURAGE_DATA_DIR:data},
      {MURAGE_USER_DATA:user,MURAGE_DATA_DIR:link},
      {MURAGE_USER_DATA:path.join(root,"missing"),MURAGE_DATA_DIR:data},
    ]){const fixture=context(env);assert.throws(fixture.run);assert.deepEqual(fixture.calls,[]);}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
