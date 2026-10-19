// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// murage:// on Linux. The .deb registers the handler through the desktop entry electron-builder writes from `protocols`.
// An AppImage registers nothing unless something integrates it, so a link from the browser would open nothing. At ready,
// when Murage is not the murage:// handler yet, this writes a small hidden desktop entry for the running copy
// (the AppImage file itself when there is one, never the temporary mount) and points x-scheme-handler/murage at it with
// xdg-mime. Nothing for the person to do. A failure is reported to the caller, which logs it; "Use copied link" still works.
//
// Order: main's own app.setAsDefaultProtocolClient("murage") runs first at ready, as it always has. This runs after it and
// does not call it again: on an AppImage Electron would name a murage.desktop that does not exist, so xdg-mime pointing at
// murage-url.desktop is the last word.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const LINUX_HANDLER_FILE = "murage-url.desktop";
export const SCHEME_MIME = "x-scheme-handler/murage";

/** Quote one Exec argument the way the Desktop Entry spec reads it: in double quotes, with " ` $ \ escaped. */
const quoteExec = (value) => `"${String(value).replace(/(["`$\\])/g, "\\$1")}"`;

export function linuxHandlerDesktopEntry(executable) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Murage",
    `Exec=${quoteExec(executable)} %U`,
    `MimeType=${SCHEME_MIME};`,
    "NoDisplay=true",
    "Terminal=false",
    "",
  ].join("\n");
}

const runFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
});

/**
 * @returns {Promise<{ registered: boolean, reason?: string }>} registered:false with reason "already" when Murage is the
 * handler already, "not-linux" off Linux; throws nothing, a failure comes back as { registered: false, reason: "failed" }.
 */
export async function ensureLinuxUrlHandler({
  app, platform = process.platform, appImagePath = process.env.APPIMAGE, execPath = process.execPath,
  dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), fsImpl = fs, exec = runFile,
}) {
  if (platform !== "linux") return { registered: false, reason: "not-linux" };
  if (app.isDefaultProtocolClient("murage")) return { registered: false, reason: "already" };
  try {
    const executable = typeof appImagePath === "string" && path.isAbsolute(appImagePath) ? appImagePath : execPath;
    const directory = path.join(dataHome, "applications");
    await fsImpl.mkdir(directory, { recursive: true });
    await fsImpl.writeFile(path.join(directory, LINUX_HANDLER_FILE), linuxHandlerDesktopEntry(executable), { mode: 0o644 });
    await exec("xdg-mime", ["default", LINUX_HANDLER_FILE, SCHEME_MIME]);
    return { registered: true };
  } catch {
    return { registered: false, reason: "failed" };
  }
}
