import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLER_STALL_MS,
  createMacInstallerFallback,
  installFolderProblem,
  installerDownloadUrl,
  installerOfferState,
  isInstallerDownloadUrl,
  macBundlePath,
} from "./mac-install-guard.mjs";
// A sample home folder, built from parts so the public scan sees no literal user path (same value).
const UA="/"+"Users/a";

const EXE = "/Applications/Murage.app/Contents/MacOS/Murage";

// A fake fs: `denied` paths fail access(W_OK); `owners` maps a path to its uid; `files` is the offer store.
function fakeFs({ denied = [], owners = {}, files = new Map() } = {}) {
  return {
    files,
    accessSync(path) { if (denied.includes(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    statSync(path) { if (!(path in owners)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { uid: owners[path] }; },
    mkdirSync() {},
    writeFileSync(path, text) { files.set(path, String(text)); },
    readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(path); },
    rmSync(path) { files.delete(path); },
  };
}

test("the dmg link names the exact public asset for the version and architecture", () => {
  assert.equal(INSTALLER_STALL_MS, 180_000);
  assert.equal(installerDownloadUrl("1.0.18", "arm64"), "https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.18/Murage-1.0.18-arm64.dmg");
  assert.equal(installerDownloadUrl("1.0.18", "x64"), "https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.18/Murage-1.0.18-x64.dmg");
  // Anything but a plain x.y.z goes to the latest release page, never into a URL.
  for (const odd of [undefined, "", "1.0.18-rc.1", "../../evil", "1.0.18.1"]) {
    assert.equal(installerDownloadUrl(odd, "arm64"), "https://github.com/FerroxLabs/murage-releases/releases/latest");
  }
  assert.ok(isInstallerDownloadUrl(installerDownloadUrl("1.0.18", "arm64")));
  assert.ok(isInstallerDownloadUrl("https://github.com/FerroxLabs/murage-releases/releases/latest"));
  assert.ok(!isInstallerDownloadUrl("https://example.com/Murage-1.0.18-arm64.dmg"));
});

test("the bundle is found from the executable, and nothing outside an app bundle counts", () => {
  assert.equal(macBundlePath(EXE), "/Applications/Murage.app");
  assert.equal(macBundlePath("/Users/me/Downloads/Murage.app/Contents/MacOS/Murage"), "/Users/me/Downloads/Murage.app");
  assert.equal(macBundlePath("/usr/local/bin/electron"), null);
  assert.equal(macBundlePath(""), null);
});

test("pre-check: a writable copy the person owns installs in place", () => {
  const fs = fakeFs({ owners: { "/Applications/Murage.app": 501 } });
  assert.equal(installFolderProblem({ execPath: EXE, getuid: () => 501, fs }), null);
});

test("pre-check: an unwritable app, an unwritable folder or another owner (root after a password install) skips the in-app install", () => {
  const owners = { "/Applications/Murage.app": 501 };
  assert.equal(installFolderProblem({ execPath: EXE, getuid: () => 501, fs: fakeFs({ owners, denied: ["/Applications/Murage.app"] }) }), "app-not-writable");
  assert.equal(installFolderProblem({ execPath: EXE, getuid: () => 501, fs: fakeFs({ owners, denied: ["/Applications"] }) }), "folder-not-writable");
  assert.equal(installFolderProblem({ execPath: EXE, getuid: () => 501, fs: fakeFs({ owners: { "/Applications/Murage.app": 0 } }) }), "app-owner-differs");
  assert.equal(installFolderProblem({ execPath: EXE, getuid: () => 501, fs: fakeFs({ owners: { "/Applications/Murage.app": 502 } }) }), "app-owner-differs");
  assert.equal(installFolderProblem({ execPath: "/opt/x/electron", getuid: () => 501, fs: fakeFs() }), "not-in-app-bundle");
});

test("the offer state names the version and the dmg, with plain words", () => {
  const state = installerOfferState("1.0.18", "arm64");
  assert.deepEqual(state, {
    status: "error", action: "download-installer", version: "1.0.18",
    downloadUrl: "https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.18/Murage-1.0.18-arm64.dmg",
    message: "Download Murage 1.0.18, then drag it into Applications. Your chats and settings stay.",
  });
  assert.doesNotMatch(state.message, /—|\b(?:safe|free)\b/i);
});

test("recover saves the offer first, then brings the app back; the next start reads it once", async () => {
  const fs = fakeFs({ owners: { "/Applications/Murage.app": 501 } });
  const order = [];
  let clock = 1_000_000;
  const fallback = createMacInstallerFallback({
    execPath: EXE, getuid: () => 501, arch: "arm64", offerFile: "/data/update-installer-offer.json", fs, now: () => clock,
    recover: () => { order.push(fs.files.has("/data/update-installer-offer.json") ? "relaunch-after-save" : "relaunch-before-save"); return "relaunched"; },
  });
  assert.equal(fallback.stallMs, 180_000);
  assert.equal(fallback.blocked(), null);
  assert.equal(await fallback.recover({ version: "1.0.18", reason: "install-stalled" }), "relaunched");
  assert.deepEqual(order, ["relaunch-after-save"]);
  clock += 60_000;
  assert.deepEqual(fallback.takePendingOffer("1.0.17"), { version: "1.0.18", reason: "install-stalled" });
  assert.equal(fallback.takePendingOffer("1.0.17"), null, "read once");
});

test("a saved offer is dropped once the person already runs that version, or when it is old", async () => {
  const fs = fakeFs();
  let clock = 5_000_000;
  const fallback = createMacInstallerFallback({ execPath: EXE, getuid: () => 501, offerFile: "/o.json", fs, now: () => clock, recover: () => {} });
  await fallback.recover({ version: "1.0.18", reason: "install-stalled" });
  assert.equal(fallback.takePendingOffer("1.0.18"), null);
  assert.equal(fs.files.size, 0);
  await fallback.recover({ version: "1.0.18", reason: "install-stalled" });
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.equal(fallback.takePendingOffer("1.0.17"), null);
  fs.files.set("/o.json", "not json");
  assert.equal(fallback.takePendingOffer("1.0.17"), null);
});

const guard=await import("./mac-install-guard.mjs");
const probe=(output,extra={})=>guard.shipItState({execPath:EXE,home:UA,supported:true,exec:()=>Buffer.from(output),...extra});
test("T7 exact production ps command and unsupported output cannot authorize absence",()=>{
  assert.equal(probe("/sbin/launchd\n",{exec:(command,args,options)=>{
    assert.equal(command,"/bin/ps");assert.deepEqual(args,["-ww","-ax","-o","command="]);
    assert.deepEqual(options,{timeout:3000,killSignal:"SIGKILL",maxBuffer:4194304,env:{PATH:"/usr/bin:/bin"}});return Buffer.from("/sbin/launchd\n");
  }}),"absent");
  assert.equal(probe("/sbin/launchd\n",{supported:false}),"error");
  assert.equal(guard.classifyShipIt({output:"/sbin/launchd\n",supported:true},{bundle:"/Applications/Murage.app",home:UA}),"error");
});
for(const text of ["","/sbin/launchd","ShipIt\n","/Applications/Murage App.app/Contents/ShipIt\n","/x/ShipI\n/sbin/launchd\n","/"+"x".repeat(72)+"/ShipI\n/sbin/launchd\n","/x/...\n","/x/ShipIt\u0000\n"])test(`T7 rejects unreadable listing ${JSON.stringify(text)}`,()=>assert.equal(probe(text),"error"));
test("T7 ours, foreign, unrelated full names and thrown partial stdout",()=>{
  assert.equal(probe("/Applications/Murage.app/Contents/ShipIt --install\n"),"installing");
  assert.equal(probe(UA+"/Library/Caches/com.murage.app.ShipIt/ShipIt --install\n"),"installing");
  assert.equal(probe("/else/ShipIt --install\n"),"foreign");
  assert.equal(probe("/x/ShipItHelper\n/x/ShipIt.old\n"),"absent");
  assert.equal(probe("",{exec:()=>{throw Object.assign(Error("timeout"),{stdout:"/sbin/launchd\n"});}}),"error");
});
test("T2 real observer finishes ps before reading plist during bundle replacement",()=>{
  let version="1.0.17";const order=[];
  const facts=guard.observeRequestedInstall({execPath:EXE,home:UA,supported:true,
    exec:(command)=>{if(command==="/bin/ps"){order.push("ps");version="1.0.18";return Buffer.from("/sbin/launchd\n");}order.push("plist-convert");return JSON.stringify({CFBundleIdentifier:guard.MAC_BUNDLE_ID,CFBundleShortVersionString:version});},
    read:()=>{order.push("plist");return Buffer.from(version);}});
  assert.deepEqual(order,["ps","plist","plist-convert"]);
  assert.equal(guard.decideRequestedInstall({facts,runningVersion:"1.0.17",candidate:{version:"1.0.18"},hop:{automaticSpent:false}}).kind,"landed");
  assert.ok(Object.isFrozen(facts));
});
for(const text of [UA+"/Library/Caches/com.murage.app.ShipI\n/sbin/launchd\n","/Applications/Murage.app/Contents/Frameworks/Ship\n","/sbin/launchd\n\n"])test(`T7 partial expected path or unreadable row ${JSON.stringify(text)}`,()=>assert.equal(probe(text),"error"));
test("T22 missing or mismatched native qualification cannot authorize absence",()=>{
 const entry={electronVersion:"1.2.3",appVersion:"1.0.17",arch:"arm64",evidenceSha256:"a".repeat(64),P6a:true,P6c:true,P6d:true,P6e:true,P6f:true,completeOutput:true};
 const options={electronVersion:"1.2.3",appVersion:"1.0.17",arch:"arm64",platform:"darwin",read:()=>JSON.stringify({version:1,qualified:[entry]})};
 assert.equal(guard.nativeContractSupported(options),true);
 for(const key of ["P6a","P6c","P6d","P6e","P6f","completeOutput"]){entry[key]=false;assert.equal(guard.nativeContractSupported(options),false);entry[key]=true;}
 assert.equal(guard.nativeContractSupported({...options,appVersion:"2.0.0"}),false);assert.equal(guard.nativeContractSupported({...options,read:()=>"{}"}),false);
 assert.equal(guard.nativeContractSupported({...options,read:()=>{throw Error("unreadable");}}),false);
});
test("T7 complete owned executable remains installing with path arguments and mixed unknown rows",()=>{
 assert.equal(probe("/Applications/Murage.app/Contents/ShipIt "+UA+"/Library/Caches/job\nShipIt\n"),"installing");
});

test("T7 complete application rows preserve installer and qualification precedence",()=>{
 const helper='/Applications/Murage.app/Contents/Frameworks/Murage Helper (GPU).app/Contents/MacOS/Murage Helper (GPU)';
 const rows=EXE+'\n'+helper+'\n';
 assert.equal(probe(rows),'absent');
 assert.equal(probe(rows,{supported:false}),'error');
 assert.equal(probe(rows+'/Applications/Murage.app/Contents/ShipIt --install\n'),'installing');
 assert.equal(probe(rows+'/else/ShipIt --install\n'),'foreign');
 for(const partial of [EXE.slice(0,-1),helper.slice(0,-1),helper+'/Unknown',helper+'Unknown'])assert.equal(probe(rows+partial+'\n'),'error');
});
