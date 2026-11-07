// `handOffInstall` swaps the terminal step: instead of quitting and letting
// electron-updater run the installer, the downloaded file is handed to the
// user. Ubuntu system packages use it — see electron/updater.mjs for why a
// chat app must not run dpkg itself. Everything before the install is shared.
// It receives the staged paths and resolves with an optional state patch
// describing what is left to do, which the card renders.
import { rm } from "node:fs/promises";
import { isUpdateVerificationError, updateErrorMessage, updateVerificationError } from "./update-errors.mjs";
import { assertCandidateManifest, captureUpdateCandidate, validateUpdateCandidate } from "./updater-candidate.mjs";
import { releaseNotesText } from "./release-notes-text.mjs";
import { createCheckHealth, describeCheckFailure, isNoPublishedVersions } from "./updater-health.mjs";

// The notes ride in the state only when the feed has some (electron/updater.mjs setState drops an older update's notes when a
// newer "available" arrives without any).
function notesPatch(info) {
  const text = releaseNotesText(info?.releaseNotes);
  return text === undefined ? {} : { releaseNotesText: text };
}

// The native updater's events that show Squirrel.Mac is still moving after quitAndInstall.
const NATIVE_STAGED = "update-downloaded";
const NATIVE_QUITTING = "before-quit-for-update";

export function createInstallWitness(events) {
  let staged = false, quitting = false;
  const listeners = new Set();
  const state = () => Object.freeze({staged,quitting});
  const emit = () => { for (const listener of listeners) listener(state()); };
  const stage = () => { if (!staged) {staged=true; emit();} };
  const quit = () => { if (!quitting) {staged=true; quitting=true; emit();} };
  events?.on?.(NATIVE_STAGED, stage); events?.on?.(NATIVE_QUITTING, quit);
  return {state, subscribe(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
    detach() {events?.removeListener?.(NATIVE_STAGED,stage); events?.removeListener?.(NATIVE_QUITTING,quit); listeners.clear();}};
}

// `installerFallback` (macOS, electron/mac-install-guard.mjs) replaces the dead-end install timeout:
//   blocked()            reason this copy cannot be replaced in place, or null; checked before anything stops
//   offer(version)       the state that offers the dmg instead
//   recover({version, reason, staged})  bring the app back after the install stopped it (main.mjs relaunches)
//   events               the native updater; its "update-downloaded" restarts the wait, "before-quit-for-update" ends it
//   stallMs              how long Squirrel may stay silent after quitAndInstall
export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeUpdater = null, beforeInstall = null, verifyDownload = null, fallbackFeed = null, installerFallback = null, returnAuthority = null, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, staleAfterMs } = {}) {
  let checkOperation = null;
  // The version the staged download carries; the installer offer names it.
  let downloadedVersion = null;
  const logCheckFailure = (error, stage) => {
    try { updater.logger?.warn?.(describeCheckFailure(error, stage)); } catch { /* logging never blocks updating */ }
  };
  // A day of failed checks becomes one quiet notice; the first good check withdraws it.
  const health = createCheckHealth({
    now,
    ...(staleAfterMs === undefined ? {} : { thresholdMs: staleAfterMs }),
    onStale: (since) => setState({ staleCheckSince: since }),
    onRecovered: () => setState({ staleCheckSince: undefined }),
  });
  let retryAction = "check";
  // Set from downloadUpdate's resolution: the paths electron-updater staged.
  // Only the hand-off needs them; quitAndInstall reads its own copy.
  let downloadedFiles = null;
  let downloadOperation = null;
  let installOperation = null;
  let downloadedCandidate = null;
  // An opted-in verifier returns a recheck of the same signed digests. It
  // runs again at each install boundary, including cached continuation.
  let verifiedDownload = null;
  let verificationRefusal = null;
  let resumeRequested = false;
  // Staged files, installation instructions and failed user actions remain
  // actionable until the user explicitly asks for a fresh check.
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const logWarn = (line) => {
    try { updater.logger?.warn?.(line); } catch { /* logging never blocks updating */ }
  };

  // The dmg offer owns the card until the person asks for a fresh check.
  function offerInstaller(version, reason) {
    actionOwnsState = true;
    retryAction = "check";
    logWarn(`installer offered (${reason}) for ${version ?? "unknown version"}`);
    setState(installerFallback.offer(version));
  }

  // quitAndInstall was called and the app is still here: the server is stopped, so never leave it like this.
  function stallInstall(operation, reason) {
    operation.staged = operation.witness?.state().staged ?? operation.staged;
    operation.failed = true;
    clearTimer(operation.timer);
    operation.detachWatch?.();
    if (installOperation === operation) installOperation = null;
    if (returnAuthority?.userQuitRequested) return;
    try { operation.onFailure?.(new Error(`Update installation needs review: ${reason}`)); } catch { /* the startup observer owns fallback */ }
    offerInstaller(operation.version, reason);
    try {
      void Promise.resolve(installerFallback.recover({ version: operation.version, reason, staged: operation.staged === true, ...(operation.backedUp?{backedUp:true}:{}) }))
        .catch((error) => logWarn(`install recovery failed: ${updateErrorMessage(error)}`));
    } catch (error) { logWarn(`install recovery failed: ${updateErrorMessage(error)}`); }
  }

  // Squirrel.Mac reports nothing when it stops at an admin password prompt. Wait stallMs after quitAndInstall; a
  // native "update-downloaded" restarts the wait (the native quit comes next), "before-quit-for-update" ends it.
  function armInstallWatch(operation, timeoutError) {
    if (!installerFallback) {
      operation.timer = setTimeout(() => {
        if (installOperation === operation) routeError(true, timeoutError());
      }, 2 * 60 * 1000);
      operation.timer.unref?.();
      return;
    }
    operation.witness ??= createInstallWitness(installerFallback.events);
    const start = state => {
      operation.staged = state.staged;
      clearTimer(operation.timer);
      const ms = state.quitting ? 30_000 : installerFallback.stallMs ?? 180_000;
      operation.timer = setTimer(() => {
        if (installOperation === operation) stallInstall(operation, "install-stalled");
      }, ms);
      operation.timer?.unref?.();
    };
    operation.detachWatch = () => operation.witness.detach();
    operation.witness.subscribe(start);
  }
  const revoked = operation => returnAuthority && (returnAuthority.userQuitRequested || operation.generation !== returnAuthority.generation);
  const stop = operation => {
    if(!operation.launched)returnAuthority?.releasePendingInstall?.();
    clearTimer(operation.timer); operation.witness?.detach(); operation.detachWatch?.();
    if (installOperation === operation) installOperation = null;
    return {status:"stopped"};
  };
  function prepareLaunch(operation, backedUp = false) {
    operation.backedUp=backedUp;
    if (installerFallback) {
      if (!backedUp) installerFallback.persist?.({version:operation.version});
      operation.witness = createInstallWitness(installerFallback.events);
      operation.detachWatch = () => operation.witness.detach();
    }
  }

  const routeError = (manual, error) => {
    // After quitAndInstall the server is already stopped; an install error must bring the app back, not strand it.
    if (installerFallback && installOperation?.launched) {
      logWarn(`install failed after the restart was requested: ${updateErrorMessage(error)}`);
      if (error instanceof Error) routedErrors.add(error);
      stallInstall(installOperation, "install-error");
      return;
    }
    if(installOperation&&!installOperation.launched)returnAuthority?.releasePendingInstall?.();
    const message = installOperation?.prepared && !isUpdateVerificationError(error)
      ? `Murage has finished closing. Retry the update, or quit and reopen Murage. ${updateErrorMessage(error)}`
      : updateErrorMessage(error);
    if (installOperation) retryAction = "install";
    else if (downloadOperation) retryAction = "download";
    actionOwnsState = manual;
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) downloadOperation.failed = true;
    if (checkOperation) checkOperation.failed = true;
    const continuationFailure = installOperation?.onFailure;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation.detachWatch?.();
      installOperation = null;
    }
    try { continuationFailure?.(error); } catch { /* the startup observer owns fallback */ }
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message, ...(isUpdateVerificationError(error) ? { action: "download-from-murage" } : {}) });
  };

  async function refuseDownload(files, error) {
    downloadedFiles = null;
    downloadedCandidate = null;
    verifiedDownload = null;
    verificationRefusal = isUpdateVerificationError(error) ? error : updateVerificationError(error);
    const removals = await Promise.allSettled((files ?? []).filter(file => typeof file === "string").map(file => rm(file, { force: true })));
    for (const result of removals) if (result.status === "rejected") updater.logger?.error("Update cache removal failed", result.reason);
    throw verificationRefusal;
  }

  async function verifyDownloadedFiles(files, version) {
    try {
      const receipt = await verifyDownload({ files, version });
      if (typeof receipt?.recheck !== "function") throw new Error("Update verifier did not return an install check.");
      return receipt;
    } catch (error) { return refuseDownload(files, error); }
  }

  async function recheckDownload() {
    try {
      if (!verifiedDownload) throw new Error("Verified update is unavailable.");
      await verifiedDownload.recheck();
    } catch (error) { return refuseDownload(downloadedFiles, error); }
  }

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !actionOwnsState && !installOperation && !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      setState({ status: "available", version: info?.version, message: undefined, ...notesPatch(info) });
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) setState({ status: "idle" });
  });
  // downloadUpdate/checkForUpdates reject after most updater errors, but the
  // macOS native staging pass used by quitAndInstall is event-only. Without
  // this listener a Squirrel.Mac failure leaves the renderer on "Restarting"
  // forever because quitAndInstall itself returns void.
  updater.on("error", (error) => {
    // Shared events have no operation ID. During overlapping check/download
    // work, their promises attribute failures; native installation errors
    // remain event-driven and must still escape the restarting spinner.
    if (checkOperation?.supersededByDownload && !installOperation) return;
    // The fallback lookup answers this one; check() reports it only if the lookup cannot.
    if (fallbackFeed && checkOperation && !checkOperation.fallbackTried && !installOperation && !downloadOperation && isNoPublishedVersions(error)) return;
    // A late old-check event can arrive after its promise's finally cleared
    // checkOperation. Do not let that unattributed event erase a completed
    // action. Errors during a fresh user operation are still reported below.
    if (actionOwnsState && !checkOperation && !downloadOperation && !installOperation) return;
    const manual = Boolean(installOperation || downloadOperation || checkOperation?.manual);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) => {
    if (!downloadOperation || downloadOperation.failed || installOperation) return;
    const percent = Number(progress?.percent);
    if (Number.isFinite(percent)) setState({ status: "downloading", percent: Math.min(100, Math.max(0, Math.round(percent))) });
  });
  updater.on("update-downloaded", (info) => {
    // On macOS electron-updater emits this before Squirrel.Mac has finished
    // staging the ZIP. Keep the UI in downloading until both the transfer
    // promise and (on macOS) the native staging event have completed.
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      return;
    }
    // An event arriving after a failed/cancelled operation cannot restore
    // a ready state without its matching validated download result.
  });

  async function runCheck(operation) {
    try { fallbackFeed?.reset(); } catch (error) { logCheckFailure(error, "feed-reset"); }
    try {
      const result = await updater.checkForUpdates();
      health.succeeded();
      return result;
    } catch (error) {
      logCheckFailure(error, "provider");
      if (fallbackFeed && isNoPublishedVersions(error) && !operation.supersededByDownload) {
        operation.fallbackTried = true;
        let switched = false;
        try { switched = await fallbackFeed.activate(); } catch (lookupError) { logCheckFailure(lookupError, "fallback-lookup"); }
        if (switched) {
          try {
            const result = await updater.checkForUpdates();
            health.succeeded();
            return result;
          } catch (retryError) {
            logCheckFailure(retryError, "fallback-check");
            health.failed();
            throw retryError;
          }
        }
      }
      health.failed();
      throw error;
    }
  }

  function check(manual = false) {
    if (installOperation || (!manual && actionOwnsState)) return Promise.resolve();
    if (manual) retryAction = "check";
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    if (manual) actionOwnsState = false;
    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = runCheck(operation)
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download() {
    if (installOperation) return Promise.resolve();
    retryAction = "download";
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { downloadedInfo: null, failed: false, promise: null };
    downloadOperation = operation;
    if (verifyDownload) {
      downloadedFiles = null;
      downloadedCandidate = null;
      verifiedDownload = null;
      verificationRefusal = null;
    }
    // macOS finishes serving the ZIP before Squirrel validates and stages it.
    // Subscribe before the download starts so a fast native event is retained.
    let finishNativeStage = null;
    let startNativeStageTimeout = null;
    const nativeStage = nativeUpdater ? new Promise((resolve) => {
      let timer;
      let settled = false;
      const ready = () => finish(true);
      const failed = (error) => {
        if (!operation.failed) routeError(true, error);
        finish(false);
      };
      const finish = (ok) => {
        settled = true;
        clearTimeout(timer);
        nativeUpdater.removeListener("update-downloaded", ready);
        nativeUpdater.removeListener("error", failed);
        resolve(ok);
      };
      finishNativeStage = finish;
      nativeUpdater.once("update-downloaded", ready);
      nativeUpdater.once("error", failed);
      startNativeStageTimeout = () => {
        if (settled) return;
        timer = setTimeout(() => failed(new Error("The update could not be staged. Try downloading it again.")), 2 * 60 * 1000);
        timer.unref?.();
      };
    }) : Promise.resolve(true);
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
    try {
      operation.promise = Promise.resolve(updater.downloadUpdate())
        .then(async (result) => {
          if (operation.failed) return result;
          startNativeStageTimeout?.();
          if (!(await nativeStage)) return result;
          if (!operation.failed) {
            downloadedFiles = Array.isArray(result) ? result.filter((file) => typeof file === "string") : null;
            downloadedCandidate = null;
            if (verifyDownload) verifiedDownload = await verifyDownloadedFiles(downloadedFiles, operation.downloadedInfo?.version);
            if (operation.failed) return result;
            // Ordinary updates remain usable when the optional backup identity
            // cannot be built. An opted-in hook must refuse a null candidate.
            try { downloadedCandidate = await captureUpdateCandidate(updater, { downloadedFiles }); } catch { /* optional identity */ }
          }
          if (!operation.failed && operation.downloadedInfo) {
            downloadedVersion = typeof operation.downloadedInfo.version === "string" ? operation.downloadedInfo.version : null;
            actionOwnsState = true;
            setState({ status: "downloaded", version: operation.downloadedInfo?.version });
          }
          return result;
        })
        .catch((error) => handleRejectedOperation(true, error))
        .finally(() => {
          finishNativeStage?.(false);
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      finishNativeStage?.(false);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function install() {
    if (returnAuthority?.userQuitRequested) return Promise.resolve({status:"stopped"});
    if (installOperation) return installOperation.promise;
    if (downloadOperation) return downloadOperation.promise;
    retryAction = "install";
    if (!downloadedFiles?.length) {
      retryAction = "download";
      routeError(true, verificationRefusal ?? new Error("Download the update before installing it."));
      return;
    }
    actionOwnsState = true;
    if (handOffInstall) {
      if (verifyDownload) return handOff();
      handOff();
      return;
    }
    // Before anything stops: a copy this person cannot replace goes straight to the dmg, and the server keeps running.
    if (installerFallback) {
      let problem = null;
      try { problem = installerFallback.blocked(); } catch (error) { logWarn(`install pre-check failed: ${updateErrorMessage(error)}`); }
      if (problem) {
        offerInstaller(downloadedVersion, problem);
        return;
      }
    }
    const operation = { failed: false, timer: null, launched: false, version: downloadedVersion, generation:returnAuthority?.generation };
    installOperation = operation;
    returnAuthority?.markInstallPending?.();
    setState({ status: "installing" });
    const launch = (decision) => {
      if (installOperation !== operation || operation.failed) return;
      if (decision?.status === "stopped") return stop(operation);
      if (decision?.status === "deferred") {
        operation.deferred = true;
        returnAuthority?.releasePendingInstall?.();
        setState({ status: "deferred", message: decision.message ?? "The update is waiting for its pre-upgrade backup." });
        return decision;
      }
      if (decision !== undefined && (!decision || decision.status !== "continue")) {
        throw new Error("Update installation was not explicitly admitted.");
      }
      operation.prepared = Boolean(beforeInstall);
      prepareLaunch(operation);
      returnAuthority?.markNativeLaunch?.();
      if (revoked(operation)) return stop(operation);
      operation.launched = true;
      try { updater.quitAndInstall(true, true); }
      catch (error) { routeError(true, error); return; }
      // Start this bound only after readiness and owned shutdown have completed.
      if (installOperation === operation) {
        armInstallWatch(operation, () => new Error("The update could not be installed. Try restarting the update again."));
      }
    };
    if (beforeInstall || verifyDownload) {
      operation.promise = Promise.resolve().then(async () => {
        if (verifyDownload) await recheckDownload();
        // Refresh actual bytes at the admission boundary, not just at download.
        let candidate = null;
        if (downloadedCandidate) {
          try {
            candidate = await captureUpdateCandidate(updater, { downloadedFiles });
            if (candidate.candidateId !== downloadedCandidate.candidateId) candidate = null;
          } catch { /* opted-in hook refuses unavailable identity */ }
        }
        return beforeInstall?.(candidate);
      }).then(verifyDownload ? async (decision) => {
        if (decision?.status === "stopped") return stop(operation);
        if (decision?.status !== "deferred") await recheckDownload();
        return launch(decision);
      } : launch).catch((error) => routeError(true, error));
      return operation.promise;
    }
    return launch();
  }

  function resumeInstall(value, { beforeInstall: admit, assertActive = () => {}, onFailure } = {}) {
    let candidate;
    try {
      candidate = validateUpdateCandidate(value);
      if (returnAuthority?.userQuitRequested) return Promise.resolve({status:"stopped"});
      if (typeof admit !== "function" || handOffInstall || nativeUpdater) throw new Error("This update cannot resume a pre-upgrade installation.");
      if (installOperation?.candidateId === candidate.candidateId) return installOperation.promise;
      if (resumeRequested) throw new Error("The update installation was already requested. Review its outcome.");
      if (installOperation || downloadOperation || checkOperation) throw new Error("Another updater operation is active.");
    } catch (error) { return Promise.reject(error); }
    if(installerFallback){const problem=installerFallback.blocked();if(problem){offerInstaller(candidate.version,problem);return Promise.resolve({status:"installer-offered"});}}
    const operation = { generation:returnAuthority?.generation, candidateId: candidate.candidateId, failed: false, timer: null, promise: null, onFailure, launched: false, version: candidate.version };
    installOperation = operation;
    returnAuthority?.markInstallPending?.();
    actionOwnsState = true;
    const active = () => {
      assertActive();
      if (operation.failed || installOperation !== operation) throw new Error("The update continuation was interrupted.");
    };
    operation.promise = Promise.resolve().then(async () => {
      active();
      const checked = await updater.checkForUpdates();
      active();
      if (checked?.isUpdateAvailable !== true) throw new Error("The pending update is unavailable.");
      assertCandidateManifest(candidate, checked.updateInfo);
      // The normal verifier may reuse its cache or transfer the same candidate
      // once. No private state seeding, arbitrary path install or retry loop.
      const files = await updater.downloadUpdate();
      active();
      if (verifyDownload) {
        downloadedFiles = Array.isArray(files) ? files : null;
        verifiedDownload = await verifyDownloadedFiles(downloadedFiles, candidate.version);
        active();
      }
      if (!Array.isArray(files) || files.length < 1 || files.some((file) => typeof file !== "string")) throw new Error("The pending update download did not return verified files.");
      const actual = await captureUpdateCandidate(updater, { downloadedFiles: files });
      active();
      if (actual.candidateId !== candidate.candidateId) throw new Error("The selected update artifact changed.");
      const decision = await admit(actual);
      active();
      if (!decision || decision.status !== "continue") throw new Error("Update continuation was not explicitly admitted.");
      if (verifyDownload) {
        await recheckDownload();
        active();
      }
      operation.prepared = true;
      resumeRequested = true;
      setState({ status: "installing", version: candidate.version });
      prepareLaunch(operation, true);
      returnAuthority?.markNativeLaunch?.();
      if (revoked(operation)) return stop(operation);
      operation.launched = true;
      updater.quitAndInstall(true, true);
      if (operation.failed && operation.launched) return { status: "install-requested" };
      active();
      armInstallWatch(operation, () => new Error("The update installation outcome is unknown. Review the pending installation."));
      return { status: "install-requested" };
    }).catch((error) => {
      if (!operation.failed) routeError(true, error);
      if (operation.launched && installerFallback) return { status: "install-requested" };
      throw error;
    });
    return operation.promise;
  }

  // The platform owns the install from here: a terminal opens with the
  // command on the clipboard and the user finishes there. No quit — the
  // running app stays usable, and the new version is picked up next launch.
  function handOff() {
    const operation = { failed: false, timer: null };
    installOperation = operation;
    returnAuthority?.markInstallPending?.();
    setState({ status: "installing" });
    operation.promise = Promise.resolve()
      .then(verifyDownload ? async () => {
        await recheckDownload();
        if (installOperation !== operation || operation.failed) return;
        return handOffInstall(downloadedFiles);
      } : () => handOffInstall(downloadedFiles))
      .then((patch) => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "handed-off", ...patch });
      })
      .catch((error) => {
        if (installOperation !== operation) return;
        routeError(true, error);
      });
    return operation.promise;
  }

  const retry = () => retryAction === "download" ? download() : retryAction === "install" ? install() : check(true);
  // The relaunched app shows the offer its previous run made (installerFallback.takePendingOffer).
  const showInstallerOffer = (version, reason = "previous-run") => {
    if (!installerFallback || installOperation || downloadOperation) return false;
    offerInstaller(version, reason);
    return true;
  };
  return Object.freeze({ check, download, install, retry, resumeInstall, showInstallerOffer, supportsInstallContinuation: !handOffInstall && !nativeUpdater });
}
