// Native demonstration recorder lifecycle.
//
// The renderer owns screen/audio MediaStreams because Chromium already gives
// them a permission-aware lifecycle. This module owns the macOS global-input
// helper that must stay outside the sandboxed renderer. The filesystem
// boundary where a reviewed recording becomes a reusable skill lives in
// skill-recording-store.mjs (no Electron import), re-exported below.
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
  buildRecorderHelper,
  recorderHelperBinary,
  recorderHelperBundle,
} from "./build-recorder-helper.mjs";

export { compileSkillMarkdown, saveSkillRecording, skillSlug } from "./skill-recording-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, "resources", "recorder-helper.swift");
const INFO = path.join(__dirname, "resources", "recorder-helper-Info.plist");
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "Murage Recorder.app")
  : recorderHelperBundle;
const BINARY = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "recorder-helper")
  : recorderHelperBinary;

let active = null;

function ensureBuilt() {
  if (app.isPackaged) return;
  const stale = !existsSync(BINARY) ||
    Math.max(statSync(SOURCE).mtimeMs, statSync(INFO).mtimeMs) > statSync(BINARY).mtimeMs;
  if (stale) buildRecorderHelper();
}

function emit(win, channel, payload) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

export function recorderPermissionStatus() {
  if (process.platform !== "darwin") {
    return { supported: false, reason: "unsupported-platform" };
  }
  return { supported: true };
}

export function startRecorder(win) {
  stopRecorder();
  const permission = recorderPermissionStatus();
  if (!permission.supported) throw new Error("Skill recording is currently available on macOS.");
  ensureBuilt();
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "murage-recorder-"));
  const outputPath = path.join(sessionDir, "events.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
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
        "--stop-file",
        stopPath,
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }

  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const session = { proc, sessionDir, outputPath, errorPath, stopPath };
  active = session;
  let offset = 0;
  let buffer = "";
  const drain = () => {
    let content;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buffer += content.slice(offset);
    offset = content.length;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (active === session) {
          emit(win, "skill-recorder:event", event);
          if (!readySettled) {
            readySettled = true;
            resolveReady({ recording: true });
          }
        }
      } catch {
        // A malformed helper line is diagnostic noise, never recording data.
      }
    }
  };
  watchFile(outputPath, { interval: 40, persistent: false }, drain);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", (code) => {
    drain();
    const detail = readError(errorPath);
    cleanup();
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(detail || "The action recorder could not start"));
    }
    if (active !== session) return;
    active = null;
    emit(win, "skill-recorder:end", {
      code,
      reason: code === 0 ? "stopped" : detail || "recorder-helper-exited",
    });
  });
  proc.on("error", (error) => {
    cleanup();
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (active !== session) return;
    active = null;
    emit(win, "skill-recorder:end", { code: 1, reason: error.message });
  });
  const timeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    stopRecorder();
    rejectReady(new Error("The action recorder did not become ready. Check Accessibility and Input Monitoring permissions."));
  }, 5_000);
  timeout.unref();
  return ready.finally(() => clearTimeout(timeout));
}

function readError(file) {
  try {
    return readFileSync(file, "utf8").trim().slice(0, 500);
  } catch {
    return "";
  }
}

export function stopRecorder() {
  if (!active) return { recording: false };
  const session = active;
  active = null;
  try {
    writeFileSync(session.stopPath, "stop");
  } catch {}
  return { recording: false };
}
