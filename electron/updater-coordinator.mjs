// `handOffInstall` swaps the terminal step: instead of quitting and letting
// electron-updater run the installer, the downloaded file is handed to the
// user. Ubuntu system packages use it — see electron/updater.mjs for why a
// chat app must not run dpkg itself. Everything before the install is shared.
// It receives the staged paths and resolves with an optional state patch
// describing what is left to do, which the card renders.
export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeUpdater = null, beforeInstall = null } = {}) {
  let checkOperation = null;
  let retryAction = "check";
  // Set from downloadUpdate's resolution: the paths electron-updater staged.
  // Only the hand-off needs them; quitAndInstall reads its own copy.
  let downloadedFiles = null;
  let downloadOperation = null;
  let installOperation = null;
  // Staged files, installation instructions and failed user actions remain
  // actionable until the user explicitly asks for a fresh check.
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    const message = installOperation?.prepared
      ? `Murage has finished closing. Retry the update, or quit and reopen Murage. ${String(error?.message ?? error)}`
      : String(error?.message ?? error);
    if (installOperation) retryAction = "install";
    else if (downloadOperation) retryAction = "download";
    actionOwnsState = manual;
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) downloadOperation.failed = true;
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation = null;
    }
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message });
  };

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
      setState({ status: "available", version: info?.version, message: undefined });
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
      operation.promise = Promise.resolve(updater.checkForUpdates())
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
          }
          if (!operation.failed && operation.downloadedInfo) {
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
    if (installOperation) return installOperation.promise;
    if (downloadOperation) return downloadOperation.promise;
    retryAction = "install";
    if (!downloadedFiles?.length) {
      retryAction = "download";
      routeError(true, new Error("Download the update before installing it."));
      return;
    }
    actionOwnsState = true;
    if (handOffInstall) {
      handOff();
      return;
    }
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    const launch = () => {
      if (installOperation !== operation || operation.failed) return;
      operation.prepared = Boolean(beforeInstall);
      try { updater.quitAndInstall(true, true); }
      catch (error) { routeError(true, error); return; }
      // Start this bound only after readiness and owned shutdown have completed.
      if (installOperation === operation) {
        operation.timer = setTimeout(() => {
          if (installOperation !== operation) return;
          routeError(true, new Error("The update could not be installed. Try restarting the update again."));
        }, 2 * 60 * 1000);
        operation.timer.unref?.();
      }
    };
    if (beforeInstall) {
      operation.promise = Promise.resolve().then(beforeInstall).then(launch).catch((error) => routeError(true, error));
      return operation.promise;
    }
    launch();
  }

  // The platform owns the install from here: a terminal opens with the
  // command on the clipboard and the user finishes there. No quit — the
  // running app stays usable, and the new version is picked up next launch.
  function handOff() {
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    Promise.resolve()
      .then(() => handOffInstall(downloadedFiles))
      .then((patch) => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "handed-off", ...patch });
      })
      .catch((error) => {
        if (installOperation !== operation) return;
        routeError(true, error);
      });
  }

  const retry = () => retryAction === "download" ? download() : retryAction === "install" ? install() : check(true);
  return { check, download, install, retry };
}
