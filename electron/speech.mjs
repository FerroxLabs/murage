// Speech helper lifecycle, main-process side. The Swift recognizer is a tiny
// background app because current macOS privacy enforcement requires the code
// calling Speech/AVFoundation to be launched with its own Info.plist identity.
// Compiled lazily in development; each recording session is one helper app.
import { spawn } from "node:child_process";
import {
  appendFileSync,
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
import { sessionTraceLine, writeCallTrace } from "./call-trace.mjs";
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
const ruleWords = (t) => t.toLowerCase().split(/\s+/).map((w) => w.replace(/[.,?!]+$/, "")).filter(Boolean);

/** THE shared segment rule (also speech-helper.swift `restates` and
 *  call-turns.ts `restates`): `text` restates `kept` when it is the same
 *  words, or those words followed by more. Whole words, ignoring case and
 *  trailing punctuation. */
export function restates(kept, text) {
  const k = ruleWords(kept);
  if (!k.length) return false;
  const t = ruleWords(text);
  return t.length >= k.length && k.every((w, i) => w === t[i]);
}

export function speechActive() { return child !== null; }
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

const ENDPOINT_LONG_DEFAULT_MS = 2_800;

/** The helper's endpoint flags. The base window clamps to 250-5000 ms; the
 *  long one (used when the last word sounds unfinished, decided inside the
 *  helper) to 250-8000 ms and never below the base. No `endpointMs` means
 *  composer dictation, which keeps listening until stopped. */
export function speechArgs(options) {
  const requested = Number(options?.endpointMs);
  if (!(Number.isFinite(requested) && requested > 0)) return [];
  const endpointMs = Math.min(5_000, Math.max(250, Math.round(requested)));
  const longRequested = Number(options?.endpointLongMs);
  const wanted = Number.isFinite(longRequested) && longRequested > 0 ? Math.round(longRequested) : ENDPOINT_LONG_DEFAULT_MS;
  const endpointLongMs = Math.max(endpointMs, Math.min(8_000, Math.max(250, wanted)));
  return ["--endpoint-ms", String(endpointMs), "--endpoint-long-ms", String(endpointLongMs)];
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
  const args = speechArgs(options);
  // Call mode feeds the helper the renderer's echo-cancelled microphone
  // instead of letting it open the mic (see speech-helper.swift, --pcm-file).
  const fed = options?.fed === true;
  const hints = Array.isArray(options?.hints)
    ? options.hints.filter((h) => typeof h === "string" && h.trim()).slice(0, 20).map((h) => h.trim().slice(0, 64))
    : [];
  for (const hint of hints) args.push("--hint", hint);

  try {
    ensureBuilt();
  } catch {
    sendEnd(win, { code: 1, reason: "helper-build-failed" });
    return;
  }
  launchSpeechSession(win, args, { fed });
}

/** Append renderer audio (16 kHz mono s16le) to the fed session, if any.
 *  Audio for a session that is not fed, or already stopping, is dropped. */
export function feedSpeech(bytes) {
  const session = child;
  if (!session?.pcmPath || session.stopRequested) return;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 64_000) return;
  try {
    appendFileSync(session.pcmPath, bytes);
  } catch {
    // the session is being torn down; its close event reports the outcome
  }
}

/**
 * Launch and own one helper session. startSpeech applies the platform and
 * build gates first; this is exported so the lifecycle tests can drive it
 * with a fake `open` waiter on every CI platform.
 */
export function launchSpeechSession(win, args = [], { fed = false } = {}) {
  // A direct spawn of Contents/MacOS/speech-helper loses the app-bundle
  // identity and TCC kills it for lacking a usage description. LaunchServices
  // preserves that identity. `open` redirects its stdout/stderr to files,
  // which we tail to retain the helper's NDJSON streaming contract.
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "murage-speech-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  const pcmPath = fed ? path.join(sessionDir, "mic.pcm") : null;
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");
  if (pcmPath) writeFileSync(pcmPath, "");

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
        ...(pcmPath ? ["--pcm-file", pcmPath] : []),
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
    pcmPath,
    sessionDir,
    stopRequested: false,
    exit: createHelperExit(),
  };
  child = speechSession;
  let buf = "";
  let offset = 0;
  let reportedError = null;
  let completed = false;
  // The last non-empty transcript of this session. Apple can reset the
  // transcript to "" after a pause, or end with an empty final or an error;
  // words already shown must still reach the call as the final.
  let lastText = "";
  // Words before an Apple recognizer reset, and the segment since it.
  let committed = "";
  let segment = "";
  let recoveredFinal = false;
  const stats = { partials: 0, emptyPartials: 0, lastPartialChars: 0, finalChars: null, longEndpoint: false };

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
        let parsed = JSON.parse(line);
        if (typeof parsed.text === "string") {
          const raw = parsed.text.trim();
          if (raw) {
            // Apple can reset its transcript to "" and start over mid-sentence:
            // the words before the reset stay in front of the new ones. A
            // helper that merges its own segments already starts with them.
            const merged = committed && !restates(committed, parsed.text) ? `${committed} ${parsed.text}` : parsed.text;
            if (merged !== parsed.text) parsed = { ...parsed, text: merged };
            segment = raw;
          }
          if (parsed.partial === false) {
            if (!raw && lastText) {
              parsed = { ...parsed, text: lastText, recovered: true };
              recoveredFinal = true;
            }
            stats.finalChars = parsed.text.length;
            if (parsed.longEndpoint === true) stats.longEndpoint = true;
          } else if (!raw) {
            stats.partials += 1;
            stats.emptyPartials += 1;
            if (segment) {
              committed = lastText;
              segment = "";
            }
          } else {
            stats.partials += 1;
            stats.lastPartialChars = parsed.text.length;
          }
          if (raw) lastText = parsed.text;
        }
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
  proc.on("close", (exitCode) => {
    let code = exitCode;
    drain();
    cleanup();
    speechSession.exit.markExited();
    // A stopped session still leaves its summary (counts only), so a turn
    // lost to a hush or a mute shows in call-trace.log.
    if (speechSession.stopRequested) {
      writeCallTrace(sessionTraceLine({ ...stats, recovered: recoveredFinal, code, reason: "stopped" }));
    }
    if (child !== speechSession) return;
    child = null;
    // A requested stop is intentional. Suppressing its close event is
    // essential in call mode: TTS muting must not look like the natural end
    // of a spoken turn.
    if (speechSession.stopRequested) return;
    // The session ended (error, crash) with words shown and no final:
    // deliver them as the final rather than losing the turn.
    if (!completed && lastText && !win.isDestroyed()) {
      win.webContents.send("speech:transcript", {
        partial: false,
        text: lastText,
        recovered: true,
        ...(stats.longEndpoint ? { longEndpoint: true } : {}),
      });
      recoveredFinal = true;
      completed = true;
      stats.finalChars = lastText.length;
      code = 0;
      reportedError = null;
    }
    const traceReason = reportedError ?? (completed && code === 0 ? "completed" : "helper-exited");
    writeCallTrace(sessionTraceLine({ ...stats, recovered: recoveredFinal, code, reason: traceReason }));
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
