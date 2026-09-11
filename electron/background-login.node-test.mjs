import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,readFileSync,readdirSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLoginProfileArguments,createBackgroundLogin,desktopExecArgument } from "./background-login.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

test("Windows uses a named profile entry and confirms the exact executable arguments",async()=>{
  let current=false;const writes=[],reads=[];
  const provider=createBackgroundLogin({platform:"win32",installed:true,primaryProfile:false,profileDir:"/fixture/profile",userDataDir:"/fixture/user-data",executable:"/fixture/Murage.exe",app:{getLoginItemSettings:options=>{reads.push(options);return {openAtLogin:current};},setLoginItemSettings:options=>{writes.push(options);current=options.openAtLogin;}}});
  assert.equal(provider.read().openAtLogin,false);assert.equal(writes.length,0);await provider.write(true);assert.equal(provider.read().openAtLogin,true);
  assert.deepEqual(reads.at(-1).args,writes[0].args);assert.match(writes[0].name,/^Murage-/);assert.ok(writes[0].args.includes("/fixture/profile"));
});
test("Mac custom profiles refuse registration rather than launching the wrong profile",async()=>{
  const provider=createBackgroundLogin({platform:"darwin",installed:true,primaryProfile:false,profileDir:"/fixture/custom",userDataDir:"/fixture/user",executable:"/fixture/app",app:{setLoginItemSettings(){throw Error("must not call native API");}}});
  assert.equal(provider.read().supported,false);await assert.rejects(provider.write(true),/primary Murage profile/);
});
test("Linux writes and removes only its scratch profile entry and safely quotes argv",async()=>{
  const root=mkdtempSync(join(tmpdir(),"murage-login-"));
  try{
    const provider=createBackgroundLogin({platform:"linux",installed:true,profileDir:join(root,"profile $name"),userDataDir:join(root,"user"),executable:"/opt/Murage AppImage",autostartDir:root});
    assert.equal(provider.read().openAtLogin,false);await provider.write(true);
    const file=join(root,readdirSync(root)[0]);const content=readFileSync(file,"utf8");
    assert.match(content,/Exec="\/opt\/Murage AppImage"/);assert.ok(content.includes(desktopExecArgument(join(root,"profile $name"))));assert.equal(provider.read().openAtLogin,true);
    await provider.write(false);assert.deepEqual(readdirSync(root),[]);
    await provider.write(true);writeFileSync(file,"[Desktop Entry]\nName=Other application\n");await assert.rejects(provider.write(false),/different sign-in entry/);assert.match(readFileSync(file,"utf8"),/Other application/);
  }finally{safeWipeSync(root);}
});
test("sign-in profile arguments are explicit and cannot replace an existing override",()=>{
  const env={MURAGE_DATA_DIR:"/chosen"};applyLoginProfileArguments(["--murage-login","--murage-data-dir","/scheduled","--murage-user-data","/user"],env);
  assert.equal(env.MURAGE_DATA_DIR,"/chosen");assert.equal(env.MURAGE_USER_DATA,"/user");assert.throws(()=>applyLoginProfileArguments(["--murage-login","--murage-data-dir","relative"],{}),/Invalid/);
  assert.equal(desktopExecArgument("100% done"),'"100%% done"');assert.throws(()=>desktopExecArgument("bad\npath"),/Unsupported/);
});
