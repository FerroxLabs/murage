import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const source=readFileSync(new URL("./updater.mjs",import.meta.url),"utf8");
const file=ts.createSourceFile("updater.mjs",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const start=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="startUpdater");
assert.ok(start,"actual updater initializer must exist");
function initialize(platform,env={},startOptions){
  const native=new EventEmitter();let nativeChecks=0,installs=0;
  native.checkForUpdates=()=>nativeChecks++;
  const updater=new EventEmitter();updater.nativeUpdater=native;updater.autoInstallOnAppQuit=true;
  updater.quitAndInstall=()=>installs++;
  let state={},options,timeouts=0,intervals=0;
  const context=vm.createContext({
    updaterCoordinator:null,checksScheduled:false,autoUpdater:null,app:{isPackaged:true},process:{platform,env},
    require:()=>({autoUpdater:updater}),updaterLogger:()=>({}),
    linuxPackageType:()=>null,HAND_OFF_TYPES:new Set(),
    setState:patch=>{state={...state,...patch};},
    createUpdaterCoordinator:(instance,setState,passed)=>{options=passed;return createUpdaterCoordinator(instance,setState,passed);},
    setTimeout:()=>{timeouts++;return {unref(){}};},setInterval:()=>{intervals++;return {unref(){}};},
  });
  vm.runInContext(start.getText(file).replace(/^export\s+/,""),context);
  context.startUpdater(startOptions);
  updater.downloadUpdate=async()=>{
    assert.equal(updater.autoInstallOnAppQuit,false,"policy set before download is called");
    updater.emit("update-downloaded",{version:"2.0.0"});
    if(updater.autoInstallOnAppQuit)native.checkForUpdates();
    return ["/unused-fixture/update.zip"];
  };
  return {updater,coordinator:context.updaterCoordinator,options,nativeChecks:()=>nativeChecks,installs:()=>installs,state:()=>state,start:context.startUpdater,timers:()=>({timeouts,intervals})};
}
test("continuation startup can enable ordinary polling once after completion",()=>{
  const h=initialize("darwin",{},{scheduleChecks:false});
  assert.deepEqual(h.timers(),{timeouts:0,intervals:0});
  assert.equal(h.start({scheduleChecks:true}),h.coordinator);
  assert.equal(h.start({scheduleChecks:true}),h.coordinator);
  assert.deepEqual(h.timers(),{timeouts:1,intervals:1});
});
test("actual startup disables eager staging on Mac, Windows, Linux and custom profiles",()=>{
  for(const platform of ["darwin","win32","linux"]){
    for(const env of [{},{MURAGE_USER_DATA:"/unused-fixture"},{MURAGE_DATA_DIR:"/unused-fixture"}]){
      const h=initialize(platform,env);
      assert.equal(h.updater.autoDownload,false);
      assert.equal(h.updater.autoInstallOnAppQuit,false);
      assert.equal(h.options.nativeUpdater,null);
      assert.equal(h.nativeChecks(),0);
    }
  }
});
test("download-only coordinator reaches downloaded without any native staging event",async()=>{
  const h=initialize("darwin");
  await h.coordinator.download();
  assert.equal(h.state().status,"downloaded");
  assert.equal(h.nativeChecks(),0);assert.equal(h.installs(),0);
});
test("shipped MacUpdater explicit false-policy path still stages then installs",()=>{
  const bundle=readFileSync(new URL("./vendor/electron-updater.cjs",import.meta.url),"utf8");
  const parsed=ts.createSourceFile("vendor.cjs",bundle,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let mac;
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(parsed)==="MacUpdater"&&node.initializer&&ts.isClassExpression(node.initializer))mac=node.initializer;ts.forEachChild(node,visit);};visit(parsed);
  assert.ok(mac,"actual shipped MacUpdater class must exist");
  const method=name=>{const node=mac.members.find(member=>ts.isMethodDeclaration(member)&&member.name.getText(parsed)===name);assert.ok(node,name);return node.getText(parsed);};
  const native=new EventEmitter();const order=[];
  native.checkForUpdates=()=>{order.push("native-stage");};
  native.quitAndInstall=()=>order.push("native-install");
  const instance={nativeUpdater:native,squirrelDownloadedUpdate:false,autoInstallOnAppQuit:false,autoRunAppAfterInstall:true,closeServerIfExists:()=>order.push("close-proxy")};
  Object.assign(instance,vm.runInNewContext(`({${method("quitAndInstall")},${method("handleUpdateDownloaded")}})`));
  instance.quitAndInstall();assert.deepEqual(order,["native-stage"]);
  native.emit("update-downloaded");assert.deepEqual(order,["native-stage","native-install","close-proxy"]);
});
