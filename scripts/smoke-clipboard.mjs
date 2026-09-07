// Manual macOS native-image fixture. This does not prove Finder file copying
// or the Composer upload flow; those require separate acceptance evidence.
// Run only after permission to temporarily replace the native clipboard:
// pnpm exec electron scripts/smoke-clipboard.mjs --allow-native-clipboard --case=image
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pasteMenuItem } from "../electron/paste-menu-item.mjs";

if (process.platform !== "darwin" || !process.argv.includes("--allow-native-clipboard") || !process.argv.includes("--case=image")) {
  console.error("REFUSED: macOS, --allow-native-clipboard and --case=image are required. No clipboard accessed. Finder is a separate unverified case.");
  app.exit(64);
} else {
  await runFixture();
}

async function runFixture() {
  const profile = mkdtempSync(join(tmpdir(), "murage-native-clipboard-"));
  app.setPath("userData", profile);
  app.setPath("sessionData", join(profile, "session"));
  app.commandLine.appendSwitch("disable-background-networking");
  const channel = `clipboard-fixture-${randomUUID()}`;
  const nonce = randomUUID();
  const preload = join(profile, "preload.cjs");
  writeFileSync(preload, `
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('fixture', {
      start: () => ipcRenderer.invoke(${JSON.stringify(channel)}, 'start'),
      finish: () => ipcRenderer.invoke(${JSON.stringify(channel)}, 'finish'),
      paste: (report) => ipcRenderer.invoke(${JSON.stringify(channel)}, 'paste', report),
    });
  `, { mode: 0o600 });

  let win;
  let original;
  let owned;
  let finished = false;
  let nextPath = null;
  const observations = [];
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const formats = () => [...clipboard.availableFormats()].sort();
  const equalFormats = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const supportedText = new Set(["text/plain", "public.utf8-plain-text", "NSStringPboardType"]);

  function stillOwned() {
    if (!owned || !equalFormats(formats(), owned.formats)) return false;
    return clipboard.readText() === "" && digest(clipboard.readImage().toPNG()) === owned.image;
  }

  function restore() {
    if (!original || !owned) return "not-needed";
    if (!stillOwned()) return "skipped-clipboard-changed";
    if (original.formats.length === 0) clipboard.clear();
    else clipboard.writeText(original.text);
    const restored = formats();
    const ok = original.formats.length === 0
      ? restored.length === 0
      : restored.every(format => supportedText.has(format)) && clipboard.readText() === original.text;
    return ok ? "restored-supported-original" : "restore-unverified";
  }

  function finish() {
    if (finished) return;
    finished = true;
    let restoration;
    try { restoration = restore(); }
    catch { restoration = "restore-failed"; }
    // Never log original clipboard content, image bytes, filenames or paths.
    original = undefined;
    owned = undefined;
    const passed = ["cmd-v", "context-menu"].every(path => observations.some(item =>
      item.path === path && item.trusted && item.files.some(file => file.type.startsWith("image/")),
    ));
    const result = {
      fixture: "manual-macos-native-image",
      acceptance: passed ? "native-image-observed" : "native-image-pending",
      observations, restoration,
      finderFileCopy: "unverified-separate-case",
      composerUpload: "not-covered-by-this-fixture",
    };
    console.log(JSON.stringify(result));
    process.exitCode = passed && restoration === "restored-supported-original" ? 0 : 2;
    return result;
  }

  app.on("before-quit", finish);
  app.on("window-all-closed", () => app.quit());
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { finish(); app.quit(); });
  app.on("will-quit", () => {
    ipcMain.removeHandler(channel);
    // This exact temporary profile is owned exclusively by this fixture.
    rmSync(profile, { recursive: true, force: true });
  });

  try {
    await app.whenReady();
    win = new BrowserWindow({
      width: 780, height: 610, title: "Native image clipboard fixture",
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Clipboard fixture", submenu: [{ role: "quit" }] },
      { label: "Edit", submenu: [{ role: "paste", accelerator: "Command+V" }] },
    ]));
    win.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && input.meta && !input.alt && !input.shift && input.key.toLowerCase() === "v") nextPath = "cmd-v";
    });
    win.webContents.on("context-menu", (_event, params) => {
      if (!owned || !params.isEditable) return;
      nextPath = null;
      const item = pasteMenuItem(params, clipboard, win.webContents);
      if (item.click) {
        const activate = item.click;
        item.click = () => {
          nextPath = "context-menu";
          activate();
        };
      }
      // A native role can bypass click callbacks. Its paste event stays
      // unattributed; merely opening this menu must never count as selecting it.
      console.log(JSON.stringify({ fixture: "native-menu", enabled: item.enabled, path: item.click ? "webContents.paste" : "native-role" }));
      Menu.buildFromTemplate([item]).popup({ window: win, frame: params.frame });
    });
    ipcMain.handle(channel, (event, action, report) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Unexpected fixture sender");
      if (finished) return { error: "Fixture already finished." };
      if (action === "finish") {
        const result = finish();
        setImmediate(() => app.quit());
        return result;
      }
      if (action === "start") {
        if (owned) return { error: "The synthetic image is already installed." };
        const beforeFormats = formats();
        if (beforeFormats.some(format => !supportedText.has(format))) {
          return { error: "Refused: the clipboard has unsupported formats. Nothing was changed. Only empty or plain-text clipboard contents can be preserved by this fixture." };
        }
        const text = beforeFormats.length ? clipboard.readText() : "";
        if (Buffer.byteLength(text, "utf8") > 1_048_576) return { error: "Refused: original clipboard text exceeds the fixture limit. Nothing was changed." };
        if (!equalFormats(beforeFormats, formats()) || clipboard.readText() !== text) return { error: "Clipboard changed during capture. Nothing was changed." };
        original = { formats: beforeFormats, text };
        // Generated local 2x2 red image; no file, provider or network input.
        const image = nativeImage.createFromBitmap(Buffer.from([
          0, 0, 255, 255, 0, 0, 255, 255,
          0, 0, 255, 255, 0, 0, 255, 255,
        ]), { width: 2, height: 2 });
        const imageHash = digest(image.toPNG());
        clipboard.writeImage(image);
        owned = { formats: formats(), image: imageHash };
        if (!stillOwned()) return { error: "Synthetic image ownership could not be confirmed. Finish the fixture; restoration will not overwrite a changed clipboard." };
        return { ready: true };
      }
      if (action === "paste" && owned) {
        if (!stillOwned()) return { error: "Clipboard changed; this event is not test-owned. Finish to retain your new clipboard." };
        if (!report || !Array.isArray(report.files) || report.files.length > 10) return { error: "Malformed paste report." };
        const observation = {
          path: nextPath ?? "unattributed-native-paste",
          trusted: report.trusted === true,
          files: report.files.map(file => ({
            type: typeof file.type === "string" ? file.type.slice(0, 100) : "",
            size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
          })),
        };
        nextPath = null;
        observations.push(observation);
        console.log(JSON.stringify({ fixture: "paste-observation", ...observation }));
        return observation;
      }
      return { error: "Start the fixture first." };
    });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
      <html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'"><title>Native image clipboard fixture</title>
      <style>body{font:16px system-ui;margin:32px;line-height:1.45;color:#17212b;background:#f8fafc}button{font:inherit;padding:8px 14px;margin:8px 8px 8px 0}textarea{display:block;width:100%;height:100px;box-sizing:border-box;font:inherit;margin:16px 0}pre{white-space:pre-wrap;font-size:13px}</style></head>
      <body><h1>Native image clipboard fixture</h1>
      <p>Start temporarily replaces an empty or plain-text clipboard with a synthetic image. Original text stays only in memory. Finish restores it only if the clipboard still contains this image. Do not force-quit this fixture.</p>
      <p>After Start: focus the field and press <strong>Cmd-V</strong>. Then right-click the same field and choose native <strong>Paste</strong>. This requires your physical actions; no keyboard automation runs.</p>
      <p>Finder file copying and Composer uploads remain separate, unverified cases.</p>
      <button id="start">Start image test</button><button id="finish">Finish and restore</button>
      <label for="target">Native paste target</label><textarea id="target" spellcheck="false" placeholder="Paste the synthetic image here"></textarea>
      <pre id="result" role="status">Awaiting Start. Clipboard has not been accessed.</pre>
      <script nonce="${nonce}">
      const result = document.getElementById('result');
      const target = document.getElementById('target');
      const show = value => { result.textContent = JSON.stringify(value, null, 2); };
      document.getElementById('start').onclick = async () => {
        const reply = await window.fixture.start(); show(reply);
        if (reply.ready) { document.getElementById('start').disabled = true; target.focus(); }
      };
      document.getElementById('finish').onclick = async () => show(await window.fixture.finish());
      target.addEventListener('paste', async event => {
        event.preventDefault();
        show(await window.fixture.paste({ trusted: event.isTrusted, files: Array.from(event.clipboardData?.files ?? [], file => ({ type: file.type, size: file.size })) }));
      });
      </script></body></html>` )}`);
  } catch (error) {
    console.error("Clipboard fixture failed to initialize; closing and attempting guarded restoration.");
    finish();
    app.quit();
    // Error messages are deliberately omitted to avoid logging clipboard data.
    void error;
  }
}
