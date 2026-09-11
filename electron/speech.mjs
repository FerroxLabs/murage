// Speech helper lifecycle, main-process side. The Swift recognizer is a tiny
// background app because current macOS privacy enforcement requires the code
// calling Speech/AVFoundation to be launched with its own Info.plist identity.
// Compiled lazily in development; each recording session is one helper app.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  buildSpeechHelper,
  speechHelperBinary,
  speechHelperBundle,
} from "./build-speech-helper.mjs";
import { createHelperExit, stopOwnedHelper } from "./helper-stop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
// Packaged: the helper bundle ships pre-built + signed in Resources. A signed
// app bundle must never be rewritten — lazy compilation would break its seal.
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "Murage Speech.app")
  : speechHelperBundle;
const BIN = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;

// The one owned recognizer session. It stays set while a requested stop is
// pending and is cleared only when the helper's exit is observed (B5).
let child = null;
// Bumped by every Start and every explicit Stop, so a Start that had to wait
// for an earlier helper cannot launch after a newer Start or Stop.
let startGeneration = 0;

function ensureBuilt() {
  if (app.isPackaged) return;
  const binaryMtime = existsSync(BIN) ? statSync(BIN).mtimeMs : 0;
  const stale = binaryMtime < Math.max(statSync(SRC).mtimeMs, statSync(INFO).mtimeMs);
  if (!stale) return;
  buildSpeechHelper();
}

function sendEnd(win, info) {
  if (!win.isDestroyed()) win.webContents.send("speech:end", info);
}

/**
 * Start one recognition session. `endpointMs` is call-mode-only: composer
 * dictation deliberately keeps listening until its mic button is pressed.
 */
export async function startSpeech(win, options = {}) {
  const generation = ++startGeneration;
  const previous = stopOwnedSpeech();
  if (previous) {
    try {
      await previous;
    } catch {
      // The previous helper is still owned (its stop marker failed or it has
      // not exited). Never start a second recognizer beside it.
      if (generation === startGeneration) sendEnd(win, { code: 1, reason: "helper-stop-pending" });
      return;
    }
    if (generation !== startGeneration) return;
  }
  if (process.platform !== "darwin") {
    sendEnd(win, { code: 2, reason: "unsupported-platform" });
    return;
  }
  const requested = Number(options?.endpointMs);
  const endpointMs = Number.isFinite(requested) && requested > 0
    ? Math.min(5_000, Math.max(250, Math.round(requested)))
    : 0;
  const args = endpointMs ? ["--endpoint-ms", String(endpointMs)] : [];

  try {
    ensureBuilt();
  } catch {
    sendEnd(win, { code: 1, reason: "helper-build-failed" });
    return;
  }
  launchSpeechSession(win, args);
}

/**
 * Launch and own one helper session. startSpeech applies the platform and
 * build gates first; this is exported so the lifecycle tests can drive it
 * with a fake `open` waiter on every CI platform.
 */
export function launchSpeechSession(win, args = []) {
  // A direct spawn of Contents/MacOS/speech-helper loses the app-bundle
  // identity and TCC kills it for lacking a usage description. LaunchServices
  // preserves that identity. `open` redirects its stdout/stderr to files,
  // which we tail to retain the helper's NDJSON streaming contract.
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "murage-speech-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        BUNDLE,
        "--args",
        ...args,
        "--stop-file",
        stopPath,
        "--finish-file",
        finishPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
    return;
  }

  const speechSession = {
    proc,
    outputPath,
    errorPath,
    stopPath,
    finishPath,
    sessionDir,
    stopRequested: false,
    exit: createHelperExit(),
  };
  child = speechSession;
  let buf = "";
  let offset = 0;
  let reportedError = null;
  let completed = false;

  const drain = () => {
    let content;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buf += content.slice(offset);
    offset = content.length;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.error === "string") reportedError = parsed.error;
        if (parsed.partial === false && typeof parsed.text === "string") completed = true;
        // A stopping or replaced helper can flush one last chunk. Never leak
        // it into the renderer or the session that replaced it.
        if (child === speechSession && !speechSession.stopRequested && !win.isDestroyed()) {
          win.webContents.send("speech:transcript", parsed);
        }
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  };
  watchFile(outputPath, { interval: 50, persistent: false }, drain);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", (code) => {
    drain();
    cleanup();
    speechSession.exit.markExited();
    if (child !== speechSession) return;
    child = null;
    // A requested stop is intentional. Suppressing its close event is
    // essential in call mode: TTS muting must not look like the natural end
    // of a spoken turn.
    if (speechSession.stopRequested) return;
    if (reportedError) {
      sendEnd(win, { code: 1, reason: reportedError });
    } else if (completed && code === 0) {
      sendEnd(win, { code: 0, reason: "completed" });
    } else {
      sendEnd(win, { code: 1, reason: "helper-exited" });
    }
  });
  proc.on("error", () => {
    cleanup();
    speechSession.exit.markExited();
    if (child !== speechSession) return;
    child = null;
    if (speechSession.stopRequested) return;
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
  });
}

function stopOwnedSpeech() {
  const session = child;
  if (!session) return null;
  return stopOwnedHelper(session, {
    name: "Dictation",
    writeMarker: () => writeFileSync(session.stopPath, "stop"),
  });
}

/**
 * Stop the owned recognizer. Resolves once its helper has exited (or when
 * nothing is owned). Rejects, keeping the session owned for a retry, when the
 * stop marker cannot be written or the helper has not exited within the
 * owned-work deadline.
 */
export async function stopSpeech() {
  startGeneration += 1;
  await stopOwnedSpeech();
}

/** Finalize the active request and keep it owned until the recognizer emits
 * its final transcript. Used by push-to-talk key release. */
export function finishSpeech() {
  if (!child || child.stopRequested) return;
  try {
    writeFileSync(child.finishPath, "finish");
  } catch {}
}
