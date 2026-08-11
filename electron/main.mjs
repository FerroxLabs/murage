import { app, BrowserWindow, desktopCapturer, ipcMain, shell, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
const SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
let serverProc = null;
async function startServerPackaged() {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  serverProc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(SERVER_PORT),
    },
    stdio: "inherit",
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs)
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/bots`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (app.isPackaged) {
    win.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  } else {
    win.loadURL(DEV_URL);
  }
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  registerCuaIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  if (app.isPackaged) await startServerPackaged();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
