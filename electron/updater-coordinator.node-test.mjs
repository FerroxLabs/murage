import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options) {
  const updater = new EventEmitter();
  // electron-updater has its own error listener; model that without routing it.
  updater.on("error", () => {});
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(
    updater,
    (patch) => {
      state = { ...state, ...patch };
      states.push({ ...state });
    },
    options,
  );
  return { updater, coordinator, states, getState: () => state };
}

// Drives a successful download so install() has staged paths to hand off.
async function downloadInto(h, files = ["/tmp/Murage-2.0.0-amd64.deb"]) {
  h.updater.downloadUpdate = () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return Promise.resolve(files);
  };
  await h.coordinator.download();
}

function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

test("automatic check rejection is handled and returns to idle", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));

  await assert.doesNotReject(coordinator.check());

  assert.equal(getState().status, "idle");
});

test("manual check rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("feed failed"));

  await assert.doesNotReject(coordinator.check(true));

  assert.deepEqual(getState(), { status: "error", message: "feed failed" });
});

test("download rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await assert.doesNotReject(coordinator.download());

  assert.deepEqual(getState(), { status: "error", message: "download failed" });
});

test("synchronous check and download throws are handled", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(coordinator.check(true));
  assert.deepEqual(getState(), { status: "error", message: "check threw" });

  updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(coordinator.download());
  assert.deepEqual(getState(), { status: "error", message: "download threw" });
});

test("a concurrent background check cannot downgrade a manual check", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const manual = coordinator.check(true);
  const background = coordinator.check();
  assert.strictEqual(background, manual);
  assert.equal(calls, 1);

  pending.reject(new Error("manual failure"));
  await manual;

  assert.deepEqual(getState(), { status: "error", message: "manual failure" });
});

test("a manual request during a background check preserves user-visible errors", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const background = coordinator.check();
  const manual = coordinator.check(true);
  assert.strictEqual(manual, background);
  assert.equal(calls, 1);

  pending.reject(new Error("background request failed"));
  await background;

  assert.deepEqual(getState(), { status: "error", message: "background request failed" });
});

test("download reports downloading before the first progress event", async () => {
  const { updater, coordinator, getState, states } = harness();
  const pending = deferred();
  // a real transfer stays silent until bytes arrive; the button must not wait
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading" });
  assert.equal(states[0].status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", percent: 12 });

  pending.resolve();
  await download;
});

test("downloaded waits for native staging to finish before becoming actionable", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.deepEqual(getState(), { status: "downloading" });

  pending.resolve(["update.zip"]);
  await download;
  assert.deepEqual(getState(), { status: "downloaded", version: "2.0.0" });
});

test("an asynchronous native install error escapes the restarting spinner", async () => {
  const { updater, coordinator, getState, states } = harness();
  const error = new Error("native staging failed");
  updater.quitAndInstall = () => updater.emit("error", error);

  await downloadInto({ updater, coordinator });
  coordinator.install();

  assert.deepEqual(getState(), { status: "error", version: "2.0.0", message: "native staging failed" });
  assert.equal(errorStates(states).length, 1);
});

test("a synchronous install failure becomes a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.quitAndInstall = () => {
    throw new Error("install threw");
  };

  await downloadInto({ updater, coordinator });
  coordinator.install();

  assert.deepEqual(getState(), { status: "error", version: "2.0.0", message: "install threw" });
});

test("formatted integrity errors retain the prepared-close recovery prefix", async () => {
  const { updater, coordinator, getState } = harness({ beforeInstall: () => Promise.resolve() });
  updater.quitAndInstall = () => {
    throw Object.assign(new Error("checksum mismatch; ETIMEDOUT"), { code: "ERR_UPDATER_CHECKSUM_MISMATCH" });
  };

  await downloadInto({ updater, coordinator });
  coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(getState().message, /^Murage has finished closing\. Retry the update, or quit and reopen Murage\. The update failed verification\./);
  assert.doesNotMatch(getState().message, /connection and try again/);
});

test("an active download state survives a later background check failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("update-not-available");
    return checkPending.promise;
  };

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  const background = coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  downloadPending.resolve();
  await download;
});

test("a download error remains authoritative after a later background failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => checkPending.promise;

  const download = coordinator.download();
  const background = coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await download;
  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });
});

test("a background failure stays silent before a later download failure", async () => {
  const { updater, coordinator, getState, states } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.checkForUpdates = () => checkPending.promise;
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = coordinator.check();
  const download = coordinator.download();

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed first"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 18 });
  assert.equal(errorStates(states).length, 0);

  const downloadError = new Error("download failed later");
  downloadPending.reject(downloadError);
  await download;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 18,
    message: "download failed later",
  });
});

test("available, not-available, progress, and downloaded events preserve success behavior", async () => {
  const available = harness();
  available.updater.checkForUpdates = () => {
    available.updater.emit("checking-for-update");
    queueMicrotask(() => available.updater.emit("update-available", { version: "2.0.0" }));
    return Promise.resolve({ isUpdateAvailable: true });
  };
  await available.coordinator.check(true);
  assert.equal(available.getState().status, "available");
  assert.equal(available.getState().version, "2.0.0");

  available.updater.downloadUpdate = () => {
    available.updater.emit("download-progress", { percent: 42.4 });
    return Promise.resolve().then(() => {
      available.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    });
  };
  await available.coordinator.download();
  assert.deepEqual(available.getState(), {
    status: "downloaded",
    version: "2.0.0",
    message: undefined,
    percent: 42,
  });

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("an updater error event and rejected promise produce one deterministic state", async () => {
  const check = harness();
  const checkError = new Error("check failed once");
  check.updater.checkForUpdates = () =>
    Promise.reject(checkError).catch((error) => {
      check.updater.emit("error", error);
      throw error;
    });

  await check.coordinator.check(true);
  assert.equal(errorStates(check.states).length, 1);
  assert.deepEqual(check.getState(), { status: "error", message: "check failed once" });

  const download = harness();
  const downloadError = new Error("download failed once");
  download.updater.downloadUpdate = () =>
    Promise.reject(downloadError).catch((error) => {
      download.updater.emit("error", error);
      throw error;
    });

  await download.coordinator.download();
  assert.equal(errorStates(download.states).length, 1);
  assert.deepEqual(download.getState(), { status: "error", message: "download failed once" });
});

test("the hand-off install opens the staged package instead of quitting", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      // what the user still has to do travels back with the state
      return Promise.resolve({ command: "sudo apt-get install -y '/tmp/x.deb'", terminalOpened: true });
    },
  });
  h.updater.quitAndInstall = () => assert.fail("a system package must not be installed by quitAndInstall");

  await downloadInto(h);
  assert.equal(h.getState().status, "downloaded");

  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, [["/tmp/Murage-2.0.0-amd64.deb"]]);
  assert.equal(h.getState().status, "handed-off");
  // the user watched something happen between the click and the result
  assert.ok(h.states.some((entry) => entry.status === "installing"));
  assert.equal(h.getState().command, "sudo apt-get install -y '/tmp/x.deb'");
  assert.equal(h.getState().terminalOpened, true);
});

test("a failed hand-off is reported instead of leaving the card spinning", async () => {
  const h = harness({ handOffInstall: () => Promise.reject(new Error("no handler for .deb")) });

  await downloadInto(h);
  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  // version survives the merge from the download — assert what the card reads
  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "no handler for .deb");
});

test("the hand-off cannot run before a validated download", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      return Promise.resolve();
    },
  });

  h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, []);
  assert.equal(h.getState().status, "error");
  assert.match(h.getState().message, /Download the update before installing/);
});

test("without a hand-off the install still quits and installs", async () => {
  const h = harness();
  let called = 0;
  h.updater.quitAndInstall = () => {
    called += 1;
  };

  await downloadInto(h, ["/tmp/Murage-2.0.0.AppImage"]);
  h.coordinator.install();

  assert.equal(called, 1);
  assert.equal(h.getState().status, "installing");
});

test("a staged update survives automatic checks until a manual refresh", async () => {
  const h = harness();
  let checks = 0;
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.1.0" });
  };
  await downloadInto(h);
  const staged = h.getState();
  await h.coordinator.check();
  assert.equal(checks, 0);
  assert.deepEqual(h.getState(), staged);
  await h.coordinator.check(true);
  assert.equal(checks, 1);
  assert.equal(h.getState().status, "available");
  assert.equal(h.getState().version, "2.1.0");
});

for (const late of [false, true]) {
  test(`a superseded check error cannot erase a download (${late ? "after" : "before"} promise cleanup)`, async () => {
    const h = harness();
    const pending = deferred();
    h.updater.checkForUpdates = () => pending.promise;
    const check = h.coordinator.check();
    await downloadInto(h);
    const error = new Error("superseded feed error");
    if (late) {
      pending.resolve();
      await check;
      h.updater.emit("error", error);
    } else {
      h.updater.emit("error", error);
      pending.reject(error);
      await check;
    }
    assert.equal(h.getState().status, "downloaded");
    assert.equal(h.getState().version, "2.0.0");
  });
}

test("checks preserve active installation and a completed package hand-off", async () => {
  const pending = deferred();
  const h = harness({ handOffInstall: () => pending.promise });
  let checks = 0;
  h.updater.checkForUpdates = async () => { checks += 1; h.updater.emit("update-not-available"); };
  await downloadInto(h);
  h.coordinator.install();
  await h.coordinator.check();
  await h.coordinator.check(true);
  assert.equal(checks, 0);
  assert.equal(h.getState().status, "installing");
  pending.resolve({ command: "fixture install command", terminalOpened: false });
  await new Promise((resolve) => setImmediate(resolve));
  const handedOff = h.getState();
  await h.coordinator.check();
  h.updater.emit("error", new Error("unattributed late feed error"));
  assert.equal(checks, 0);
  assert.equal(h.getState().status, "handed-off");
  assert.deepEqual(h.getState(), handedOff);
});

for (const action of ["check", "download", "hand-off"]) {
  test(`a failed manual ${action} remains visible across automatic checks and can be refreshed`, async () => {
    const h = harness({ handOffInstall: () => Promise.reject(new Error("hand-off failed")) });
    if (action === "check") {
      h.updater.checkForUpdates = () => Promise.reject(new Error("check failed"));
      await h.coordinator.check(true);
    } else if (action === "download") {
      h.updater.downloadUpdate = () => Promise.reject(new Error("download failed"));
      await h.coordinator.download();
    } else {
      await downloadInto(h);
      h.coordinator.install();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const failed = h.getState();
    let checks = 0;
    h.updater.checkForUpdates = async () => { checks += 1; h.updater.emit("update-not-available"); };
    await h.coordinator.check();
    h.updater.emit("error", new Error("unattributed old check error"));
    assert.equal(checks, 0);
    assert.equal(h.getState().status, "error");
    assert.deepEqual(h.getState(), failed);
    await h.coordinator.check(true);
    assert.equal(checks, 1);
    assert.equal(h.getState().status, "idle");
  });
}

for (const action of ["check", "download", "install"]) {
  test(`a fresh user ${action} still reports its error after a staged update`, async () => {
    const h = harness();
    await downloadInto(h);
    const fail = () => {
      const error = new Error(`${action} failed`);
      h.updater.emit("error", error);
      return Promise.reject(error);
    };
    if (action === "check") {
      h.updater.checkForUpdates = fail;
      await h.coordinator.check(true);
    } else if (action === "download") {
      h.updater.downloadUpdate = fail;
      await h.coordinator.download();
    } else {
      h.updater.quitAndInstall = () => h.updater.emit("error", new Error("install failed"));
      h.coordinator.install();
    }
    assert.equal(h.getState().status, "error");
    assert.equal(h.getState().message, `${action} failed`);
  });
}

for (const outcome of ["ready", "error"]) {
  test(`macOS ZIP transfer waits for native staging: ${outcome}`, async () => {
    const nativeUpdater = new EventEmitter();
    const h = harness({ nativeUpdater });
    h.updater.downloadUpdate = async () => {
      h.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    };
    const download = h.coordinator.download();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.getState().status, "downloading");
    if (outcome === "ready") nativeUpdater.emit("update-downloaded");
    else nativeUpdater.emit("error", new Error("signature staging failed"));
    await download;
    assert.equal(h.getState().status, outcome === "ready" ? "downloaded" : "error");
    if (outcome === "error") assert.match(h.getState().message, /The update failed verification/);
    assert.equal(nativeUpdater.listenerCount("update-downloaded"), 0);
    assert.equal(nativeUpdater.listenerCount("error"), 0);
  });
}


test("late progress/downloaded events cannot resurrect a failed or staged download", async () => {
  const h = harness();
  h.updater.downloadUpdate = async () => { throw new Error("offline"); };
  await h.coordinator.download();
  const failed = h.getState();
  h.updater.emit("download-progress", { percent: 91 });
  h.updater.emit("update-downloaded", { version: "unowned" });
  assert.deepEqual(h.getState(), failed);
  await downloadInto(h);
  const ready = h.getState();
  h.updater.emit("download-progress", { percent: 10 });
  assert.deepEqual(h.getState(), ready);
});

test("Retry repeats the failed download instead of checking the feed again", async () => {
  const h = harness();
  let downloads = 0;
  h.updater.checkForUpdates = () => assert.fail("retry must not discard the selected update");
  h.updater.downloadUpdate = async () => {
    downloads++;
    if (downloads === 1) throw new Error("network interrupted");
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return ["update.zip"];
  };
  await h.coordinator.download();
  await h.coordinator.retry();
  assert.equal(downloads, 2);
  assert.equal(h.getState().status, "downloaded");
});

test("install waits for owned cleanup and deduplicates restart clicks", async () => {
  const cleanup = deferred();
  const order = [];
  const h = harness({ beforeInstall: () => { order.push("cleanup"); return cleanup.promise; } });
  h.updater.quitAndInstall = () => order.push("installer");
  await downloadInto(h);
  const first = h.coordinator.install();
  assert.equal(h.coordinator.install(), first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["cleanup"]);
  cleanup.resolve();
  await first;
  assert.deepEqual(order, ["cleanup", "installer"]);
});

test("busy or failed cleanup preserves the staged update for an explicit retry", async () => {
  let busy = true;
  let installs = 0;
  const h = harness({ beforeInstall: () => { if (busy) throw new Error("Finish current work first."); } });
  h.updater.quitAndInstall = () => installs++;
  await downloadInto(h);
  await h.coordinator.install();
  assert.equal(installs, 0);
  assert.equal(h.getState().status, "error");
  busy = false;
  await h.coordinator.retry();
  assert.equal(installs, 1);
});

test("an install click during download cannot fail the active transfer", async () => {
  const pending = deferred();
  const h = harness();
  h.updater.downloadUpdate = () => pending.promise;
  const transfer = h.coordinator.download();
  assert.equal(h.coordinator.install(), transfer);
  h.updater.emit("update-downloaded", { version: "2.0.0" });
  pending.resolve(["update.zip"]);
  await transfer;
  assert.equal(h.getState().status, "downloaded");
});

test("downloads are not started while installation is preparing", async () => {
  const pending = deferred();
  const h = harness({ beforeInstall: () => pending.promise });
  await downloadInto(h);
  const install = h.coordinator.install();
  h.updater.downloadUpdate = () => assert.fail("installer owns the staged package");
  await h.coordinator.download();
  pending.reject(new Error("cleanup unavailable"));
  await install;
});

test("update-available carries the release notes as plain text, capped", async () => {
  const { updater, getState } = harness();
  updater.emit("update-available", { version: "2.0.0", releaseNotes: "<h2>New</h2><ul><li>Faster <b>search</b></li><li>Fix &amp; polish</li></ul><script>alert(1)</script>" });
  assert.equal(getState().status, "available");
  assert.ok(!/[<>]/.test(getState().releaseNotesText));
  assert.match(getState().releaseNotesText, /- Faster search/);
  assert.match(getState().releaseNotesText, /- Fix & polish/);
  assert.doesNotMatch(getState().releaseNotesText, /alert/);
  updater.emit("update-available", { version: "2.0.1", releaseNotes: "x".repeat(20000) });
  assert.equal(getState().releaseNotesText.length, 8000);
  updater.emit("update-available", { version: "2.0.2", releaseNotes: [{ version: "2.0.2", note: "Plain note" }] });
  assert.equal(getState().releaseNotesText, "Plain note");
  updater.emit("update-available", { version: "2.0.3" });
  assert.ok(!("releaseNotesText" in getState()) || getState().releaseNotesText === "Plain note");
});

import {createInstallWitness} from "./updater-coordinator.mjs";
import {createReturnAuthority,joinExplicitQuit} from "./backup-offline-return.mjs";
import {captureUpdateCandidate} from "./updater-candidate.mjs";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
async function nativeFixture(t,options={}){
  const root=mkdtempSync(join(tmpdir(),"macwd-native-"));t.after(()=>safeWipeSync(root));
  const file=join(root,"update.zip"),bytes="fixture only";writeFileSync(file,bytes);
  const sha512=createHash("sha512").update(bytes).digest("base64"),info={version:"2.0.0",files:[{url:"update.zip",sha512}]};
  const events=new EventEmitter(),timers=new Map(),authority=createReturnAuthority();const recoveryDetails=[];let calls=0,recoveries=0;
  const h=harness({returnAuthority:authority,installerFallback:{blocked:()=>null,offer:()=>({status:"error"}),stallMs:180000,events,persist:()=>{},recover:info=>{recoveries++;recoveryDetails.push(info);}},setTimer:(fn,ms)=>{const key={fn,ms};timers.set(key,key);return key;},clearTimer:key=>timers.delete(key),...options});
  h.updater.downloadedUpdateHelper={cacheDir:root,file,versionInfo:info,fileInfo:{info:info.files[0]}};
  h.updater.checkForUpdates=async()=>({isUpdateAvailable:true,updateInfo:info});
  h.updater.downloadUpdate=async()=>{h.updater.emit("update-downloaded",info);return [file];};
  h.updater.quitAndInstall=()=>{calls++;events.emit("update-downloaded");};
  return {...h,events,timers,authority,recoveryDetails,calls:()=>calls,recoveries:()=>recoveries,candidate:await captureUpdateCandidate(h.updater)};
}
for(const path of ["install","resumeInstall"])for(const boundary of ["cleanup","final revalidation"])test(`BF-1 pending native ${path} stops when Quit arrives during ${boundary}`,async t=>{
  const held=deferred(),entered=deferred();let admitted=false,quits=0,relaunches=0;
  const h=await nativeFixture(t,{beforeInstall:async()=>{admitted=true;if(boundary==="cleanup"){entered.resolve();await held.promise;}return {status:"continue"};},
    verifyDownload:async()=>({recheck:async()=>{if(admitted&&boundary==="final revalidation"){entered.resolve();await held.promise;}}})});
  const admit=async()=>{admitted=true;if(boundary==="cleanup"){entered.resolve();await held.promise;}return {status:"continue"};};
  if(path==="install")await h.coordinator.download();
  const pending=path==="install"?h.coordinator.install():h.coordinator.resumeInstall(h.candidate,{beforeInstall:admit});
  await entered.promise;
  const quitting=joinExplicitQuit({authority:h.authority,app:{quit:()=>{quits++;},exit:()=>{}},cleanup:()=>held.promise,takeProgress:()=>null,setTimer:()=>{},relaunch:()=>{relaunches++;}});
  held.resolve();assert.deepEqual(await pending,{status:"stopped"});await quitting;
  assert.equal(h.calls(),0);assert.equal(h.recoveries(),0);assert.equal(h.timers.size,0);assert.equal(h.events.listenerCount("update-downloaded"),0);assert.equal(h.events.listenerCount("before-quit-for-update"),0);
  assert.equal(relaunches,0);assert.equal(quits,1);assert.equal(errorStates(h.states).length,0);
});
test("T16 witness is monotonic, replays immediately and detaches",()=>{
  const events=new EventEmitter(),w=createInstallWitness(events),states=[];
  events.emit("update-downloaded");w.subscribe(s=>states.push(s));events.emit("before-quit-for-update");events.emit("update-downloaded");
  assert.deepEqual(states,[{staged:true,quitting:false},{staged:true,quitting:true}]);w.detach();assert.equal(events.listenerCount("update-downloaded"),0);
});
for(const path of ["install","resumeInstall"])test(`T13 T16 ${path} catches synchronous stage and bounds quitting then recovers once`,async t=>{
  const h=await nativeFixture(t);
  if(path==="install"){await h.coordinator.download();await h.coordinator.install();}else await h.coordinator.resumeInstall(h.candidate,{beforeInstall:()=>({status:"continue"})});
  assert.equal(h.calls(),1);assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].ms,180000);
  h.events.emit("before-quit-for-update");assert.equal([...h.timers.values()][0].ms,30000);
  [...h.timers.values()][0].fn();h.updater.emit("error",Error("late"));assert.equal(h.recoveries(),1);
});
test("BF-1 synchronous witness subscription reentry cannot launch after Quit",async t=>{
 const h=await nativeFixture(t);await h.coordinator.download();
 h.events.once("newListener",()=>{h.authority.userQuitRequested=true;h.authority.generation++;});
 assert.deepEqual(await h.coordinator.install(),{status:"stopped"});assert.equal(h.calls(),0);assert.equal(h.timers.size,0);assert.equal(h.events.listenerCount("update-downloaded"),0);
});

// MAC-UPDATE-WATCHDOG (1.0.18): Squirrel.Mac can stop at an admin password prompt and report nothing (rel1017 canary-mac).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OFFER = (version) => ({ status: "error", action: "download-installer", version, downloadUrl: `dmg:${version}` });
function macFallback({ blocked = null, stallMs = 30 } = {}) {
  const events = new EventEmitter();
  const recovered = [];
  const checks = [];
  return {
    events, recovered, checks,
    options: { events, stallMs, blocked: () => { checks.push("checked"); return blocked; }, offer: OFFER, recover: (info) => { recovered.push(info); return "relaunched"; } },
  };
}

test("watchdog: Squirrel silent after Restart to update brings the app back once and offers the dmg", async () => {
  const mac = macFallback();
  let cleanups = 0;
  const h = harness({ installerFallback: mac.options, beforeInstall: () => { cleanups++; } });
  h.updater.quitAndInstall = () => {};
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  assert.equal(cleanups, 1);
  assert.equal(h.getState().status, "installing");
  await sleep(80);
  assert.deepEqual(mac.recovered, [{ version: "2.0.0", reason: "install-stalled", staged: false }]);
  assert.deepEqual({ ...h.getState(), message: undefined }, { ...OFFER("2.0.0"), message: undefined });
  assert.equal(mac.events.listenerCount("update-downloaded"), 0);
  await sleep(80);
  assert.equal(mac.recovered.length, 1, "recovers once");
});

test("watchdog: a native update-downloaded restarts the wait and before-quit-for-update ends it", async () => {
  const mac = macFallback({ stallMs: 60 });
  const h = harness({ installerFallback: mac.options, beforeInstall: () => {} });
  h.updater.quitAndInstall = () => {};
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  await sleep(40);
  mac.events.emit("update-downloaded");
  await sleep(40);
  assert.deepEqual(mac.recovered, [], "staged in time: the wait starts again");
  mac.events.emit("before-quit-for-update");
  await sleep(100);
  assert.deepEqual(mac.recovered, []);
  assert.equal(h.getState().status, "installing");
});

test("watchdog: an install error after the server stopped brings the app back instead of a dead window", async () => {
  const mac = macFallback({ stallMs: 10_000 });
  const h = harness({ installerFallback: mac.options, beforeInstall: () => {} });
  h.updater.quitAndInstall = () => h.updater.emit("error", new Error("native staging failed"));
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  assert.deepEqual(mac.recovered, [{ version: "2.0.0", reason: "install-error", staged: false }]);
  assert.equal(h.getState().action, "download-installer");
  assert.doesNotMatch(JSON.stringify(h.states), /Murage has finished closing/);
});

test("pre-check: a copy this person cannot replace goes straight to the dmg; nothing stops and nothing installs", async () => {
  const mac = macFallback({ blocked: "app-owner-differs" });
  let cleanups = 0;
  const h = harness({ installerFallback: mac.options, beforeInstall: () => { cleanups++; } });
  h.updater.quitAndInstall = () => assert.fail("Squirrel must not be started");
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  await sleep(50);
  assert.equal(cleanups, 0, "the server keeps running");
  assert.deepEqual(mac.recovered, []);
  assert.equal(h.getState().action, "download-installer");
  assert.equal(h.getState().version, "2.0.0");
  assert.ok(!h.states.some((entry) => entry.status === "installing"));
});

test("pre-check that throws does not block the install; the watchdog still covers it", async () => {
  const mac = macFallback();
  mac.options.blocked = () => { throw new Error("stat failed"); };
  let installs = 0;
  const h = harness({ installerFallback: mac.options, beforeInstall: () => {} });
  h.updater.quitAndInstall = () => installs++;
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  assert.equal(installs, 1);
  await sleep(80);
  assert.equal(mac.recovered.length, 1);
});

test("the relaunched app shows its previous run's offer and a background check does not erase it", async () => {
  const mac = macFallback();
  const h = harness({ installerFallback: mac.options });
  assert.equal(h.coordinator.showInstallerOffer("2.0.0", "install-stalled"), true);
  assert.equal(h.getState().action, "download-installer");
  h.updater.checkForUpdates = () => { h.updater.emit("update-available", { version: "2.0.0" }); return Promise.resolve(); };
  await h.coordinator.check();
  assert.equal(h.getState().action, "download-installer");
  assert.equal(harness().coordinator.showInstallerOffer("2.0.0"), false, "no fallback, no offer");
});

test("without the macOS fallback the install timeout is unchanged", async () => {
  const h = harness({ beforeInstall: () => {} });
  h.updater.quitAndInstall = () => {};
  await downloadInto(h, ["update.zip"]);
  await h.coordinator.install();
  assert.equal(h.getState().status, "installing");
  assert.equal(typeof h.coordinator.showInstallerOffer, "function");
});
test("resume pre-check offers the installer before request marking or cleanup",async t=>{
 let admitted=0;const h=await nativeFixture(t,{installerFallback:{blocked:()=>"app-not-writable",offer:()=>({status:"error",action:"download-installer"})}});
 assert.equal((await h.coordinator.resumeInstall(h.candidate,{beforeInstall:()=>{admitted++;return {status:"continue"};}})).status,"installer-offered");
 assert.equal(admitted,0);assert.equal(h.calls(),0);assert.equal(h.getState().action,"download-installer");
});

for(const mode of ["emit","throw"])for(const staged of [false,true])test(`F4 resumed synchronous native error has one handled outcome staged=${staged} mode=${mode}`,async t=>{
 const h=await nativeFixture(t);
 // Observe the real fallback through its offered state and witness deadline cleanup.
 h.updater.quitAndInstall=()=>{if(staged)h.events.emit('update-downloaded');if(mode==='throw')throw Error('native failed');h.updater.emit('error',Error('native failed'));};
 const result=await h.coordinator.resumeInstall(h.candidate,{beforeInstall:()=>({status:'continue'})});
 assert.equal(result.status,'install-requested');assert.equal(h.recoveryDetails[0].staged,staged);assert.equal(h.recoveries(),1);assert.equal(h.timers.size,0);assert.equal(errorStates(h.states).length,1);
});

test('r33 Grok stopped arming remains stopped through real install',async t=>{
 const h=await nativeFixture(t,{beforeInstall:()=>({status:'stopped'})});await h.coordinator.download();
 assert.deepEqual(await h.coordinator.install(),{status:'stopped'});assert.equal(h.calls(),0);assert.equal(h.recoveries(),0);assert.equal(errorStates(h.states).length,0);assert.equal(h.timers.size,0);assert.equal(h.events.listenerCount('update-downloaded'),0);
});

for(const path of ['install','resumeInstall'])test(`F3 ${path} blocks Return while admission is pending and releases it on failure`,async t=>{
 const held=deferred(),entered=deferred();const admit=async()=>{entered.resolve();await held.promise;return {status:'continue'};};
 const h=await nativeFixture(t,{beforeInstall:admit});let pending=false,launched=false;
 h.authority.markInstallPending=()=>{pending=true;};h.authority.markNativeLaunch=()=>{launched=true;};h.authority.releasePendingInstall=()=>{pending=false;};
 if(path==='install')await h.coordinator.download();
 const running=path==='install'?h.coordinator.install():h.coordinator.resumeInstall(h.candidate,{beforeInstall:admit});const outcome=running.catch(error=>error);
 await entered.promise;const pendingObserved=pending;held.reject(Error('cleanup rejected'));await outcome;
 assert.equal(pendingObserved,true);assert.equal(pending,false);assert.equal(launched,false);assert.equal(h.calls(),0);
});
