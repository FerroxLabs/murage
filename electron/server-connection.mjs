import { randomUUID } from "node:crypto";

export function serverOrigin(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\s\\]/.test(value)) throw new Error("Enter a server address such as https://murage.example.com.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a complete HTTPS server address."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback))) {
    throw new Error("Use an HTTPS server address without a path, credentials, query or fragment.");
  }
  return url.origin;
}

export function sameServerOrigin(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !/[\\\s]/.test(value);
  } catch { return false; }
}

function isolate(contents, origin) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    contents.on(name, (event, url) => {
      if (!sameServerOrigin(typeof url === "string" ? url : event.url, origin)) event.preventDefault();
    });
  }
  contents.on("will-attach-webview", event => event.preventDefault());
}

async function clearPartition(partition) {
  // Attempt every cleanup even when an earlier operation fails.
  const results = await Promise.allSettled([
    partition.closeAllConnections(), partition.clearStorageData(), partition.clearCache(),
  ]);
  if (results.some(result => result.status === "rejected")) throw new Error("The server window closed, but its temporary session could not be fully cleared. Quit Murage to discard it.");
}

const webPreferences = partition => ({ partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });

export function createServerConnections({ BrowserWindow, session, onError = () => {}, allowLoopbackHttp = false }) {
  const connections = new Map();
  function disconnectEntry(entry) {
    if (entry.cleanup) return entry.cleanup;
    // Assign the promise before destroy(), whose closed event is synchronous.
    entry.cleanup = Promise.resolve().then(async () => {
      if (!entry.window.isDestroyed()) entry.window.destroy();
      try { await clearPartition(entry.partition); }
      finally { if (connections.get(entry.origin) === entry) connections.delete(entry.origin); }
    });
    return entry.cleanup;
  }
  return {
    async connect(value) {
      const origin = serverOrigin(value, { allowLoopbackHttp });
      const previous = connections.get(origin);
      if (previous?.cleanup) await previous.cleanup;
      else if (previous && !previous.window.isDestroyed()) {
        previous.window.show(); previous.window.focus(); return previous.window;
      }
      const partitionName = `murage-server-${randomUUID()}`;
      const partition = session.fromPartition(partitionName, { cache: false });
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      partition.on("will-download", event => event.preventDefault());
      const window = new BrowserWindow({ width: 1100, height: 800, minWidth: 390, minHeight: 500, title: `Murage server: ${origin}`, webPreferences: webPreferences(partitionName) });
      const entry = { origin, window, partition, cleanup: null };
      connections.set(origin, entry);
      isolate(window.webContents, origin);
      window.on("page-title-updated", event => event.preventDefault());
      window.on("closed", () => { void disconnectEntry(entry).catch(onError); });
      try { await window.loadURL(`${origin}/enter`); }
      catch {
        await disconnectEntry(entry);
        throw new Error(`Could not connect to ${origin}. Check the address and that the server is available.`);
      }
      return window;
    },
    async disconnect(window) {
      const entry = [...connections.values()].find(value => value.window === window);
      if (entry) await disconnectEntry(entry);
    },
  };
}

const promptAction = "https://murage-connect.invalid/";
export const serverPromptHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://murage-connect.invalid"><title>Connect to a Murage server</title><style>
:root{--canvas:#0a0a0a;--surface:#131313;--text:#ededed;--muted:#8a8a8a;--border:#5a5a5a;--focus:#ff6b35}*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--canvas);color:var(--text);font:17px/1.55 Inter,system-ui,sans-serif}h1{font-size:22px;line-height:1.3;margin:0 0 16px}p{margin:0 0 24px}label{display:block;margin-bottom:8px}input{width:100%;height:44px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font:inherit;padding:8px}small{display:block;color:var(--muted);font-size:14px;margin-top:8px}footer{display:flex;gap:16px;justify-content:flex-end;margin-top:24px}button{min-height:44px;padding:8px 16px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font:inherit}button[type=submit]{background:var(--text);color:var(--canvas)}:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
</style></head><body><main><h1>Connect to a Murage server</h1><p>Enter the address of your existing server, then sign in with its pairing code.</p><form action="${promptAction}" method="get"><label for="address">Server address</label><input id="address" name="address" type="url" placeholder="https://murage.example.com" autocomplete="off" spellcheck="false" autofocus required aria-describedby="hint"><small id="hint">Close the server window to disconnect. Your local workspace stays available.</small><footer><button type="submit" name="cancel" value="1" formnovalidate>Cancel</button><button type="submit">Connect</button></footer></form></main></body></html>`;

export function openServerPrompt({ BrowserWindow, session, connections, parent, onError }) {
  const partitionName = `murage-server-prompt-${randomUUID()}`;
  const partition = session.fromPartition(partitionName, { cache: false });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({ width: 560, height: 390, minWidth: 390, minHeight: 390, title: "Connect to a Murage server", ...(parent ? { parent } : {}), webPreferences: webPreferences(partitionName) });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-redirect", event => event.preventDefault());
  let connecting = false;
  window.webContents.on("will-navigate", (event, value) => {
    event.preventDefault();
    let url;
    try { url = new URL(value); } catch { return; }
    if (url.origin !== new URL(promptAction).origin || url.pathname !== "/" || connecting) return;
    if (url.searchParams.get("cancel") === "1") { window.close(); return; }
    connecting = true;
    void connections.connect(url.searchParams.get("address")).then(() => {
      if (!window.isDestroyed()) window.close();
    }).catch(onError).finally(() => { connecting = false; });
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); window.close(); }
  });
  window.on("closed", () => { void clearPartition(partition).catch(onError); });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(serverPromptHtml)}`).catch(onError);
  return window;
}
