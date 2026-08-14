// Speech helper lifecycle, main-process side. The Swift helper is spawned
// from HERE (never the harness server) so the Microphone + Speech
// Recognition permission prompts attribute to the app. Compiled lazily on
// first use; each recording session is one helper process.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
// packaged: the helper ships pre-built + signed in Resources (a signed app
// bundle must never be written into — lazy compile would break the seal)
const BIN = app.isPackaged
  ? path.join(process.resourcesPath, "speech-helper")
  : path.join(__dirname, "resources", "speech-helper");

let child = null;

function ensureBuilt() {
  if (app.isPackaged) return; // pre-built at package time
  const stale = !existsSync(BIN) || statSync(BIN).mtimeMs < statSync(SRC).mtimeMs;
  if (!stale) return;
  // Xcode CLT required; ~2s once, then cached until the source changes
  execFileSync("swiftc", ["-O", SRC, "-o", BIN], { stdio: "pipe", timeout: 120_000 });
}

function sendEnd(win, info) {
  if (!win.isDestroyed()) win.webContents.send("speech:end", info);
}

/**
 * Start one recognition session. `endpointMs` is call-mode-only: composer
 * dictation deliberately keeps listening until its mic button is pressed.
 */
export function startSpeech(win, options = {}) {
  stopSpeech();
  if (process.platform !== "darwin") {
    // the helper is a Swift SFSpeechRecognizer binary — macOS only; tell
    // the renderer with a distinct code so it can say why
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

  let proc;
  try {
    proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
    return;
  }
  child = proc;

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        // A stopped/replaced helper can flush one last chunk. Never let it
        // leak into the session that replaced it.
        if (child === proc && !win.isDestroyed()) {
          win.webContents.send("speech:transcript", JSON.parse(line));
        }
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  });
  proc.on("close", (code) => {
    // stopSpeech() clears child before killing it. Suppressing that close
    // event is essential in call mode: otherwise muting for TTS looks like
    // a natural end and immediately reopens the microphone during playback.
    if (child !== proc) return;
    child = null;
    sendEnd(win, { code: code === 0 ? 0 : 1, reason: code === 0 ? "completed" : "helper-exited" });
  });
  proc.on("error", () => {
    if (child !== proc) return;
    child = null;
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
  });
}

export function stopSpeech() {
  if (!child) return;
  const proc = child;
  // Mark it intentional before sending the signal so its asynchronous close
  // handler cannot be mistaken for the end of a spoken turn.
  child = null;
  try {
    proc.kill("SIGTERM");
  } catch {}
}
