// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PARITYFIX E5/E6 real-Electron harness. Runs as an Electron MAIN entry (electron <this file> <work dir>), never under node.
// installCloudHome() gets the real electron protocol/session/BrowserWindow/net; cloud.open() loads the home's page; the page
// itself asks for notifications, the microphone and downloads, so Electron delivers every permission check/request and
// will-download to the handlers open() really installed. Nothing here calls a handler. Prints one line: RESULT <json>.
// Run under a D-Bus session bus (dbus-run-session) with libnotify loadable: the harness puts a desktop notification server
// (org.freedesktop.Notifications) on that bus, so a page notification Electron really displays arrives there.
import { app, BrowserWindow, net, protocol, session } from "electron";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installCloudHome } from "./cloud-home-window.mjs";

const HOME = "home-a";
const work = path.resolve(process.argv.at(-1));
const dist = path.join(work, "dist");
const downloads = path.join(work, "Downloads");
const saved = path.join(work, "saved");
for (const dir of [dist, downloads, saved]) mkdirSync(dir, { recursive: true });
app.setPath("userData", path.join(work, "user-data"));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
writeFileSync(path.join(dist, "index.html"), "<!doctype html><meta charset=utf-8><title>home</title><body>home</body>");
writeFileSync(path.join(dist, "app.bin"), "app asset bytes");
const FILE_BYTES = "fixture report bytes\n";

const server = createServer((req, res) => {
  if (req.url === "/api/files/att-1/download") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.pdf"' });
    res.end(FILE_BYTES);
    return;
  }
  res.writeHead(404); res.end();
});
let origin = null; // set once the fixture home listens (before any page asks)

const cloud = installCloudHome({
  protocol, session, BrowserWindow, net, packaged: false, env: { MURAGE_DESKTOP_CLOUD: "1" }, distDir: dist,
  userDataDir: path.join(work, "user-data"), shell: { openExternal: async () => {} }, downloadsDir: () => downloads,
  provider: (homeId) => (homeId === HOME && origin ? { homeId, origin, getAccessToken: () => "fixture-token" } : null),
});

const result = { electron: process.versions.electron };
const step = (name) => process.stderr.write(`STEP ${name}\n`);
// One budget for the whole run: a hang prints what was reached and exits non-zero, never a silent wait.
setTimeout(() => { process.stdout.write(`RESULT ${JSON.stringify({ ...result, hung: true })}\n`); app.exit(3); }, 150_000).unref?.();
const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(`timeout:${label}`), ms))]);
const run = (win, code) => withTimeout(win.webContents.executeJavaScript(code, true).catch((error) => `error:${error?.message ?? error}`), 15_000, "page");
const loaded = (win) => new Promise((resolve) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", resolve) : resolve()));

// The X server's window titles (python3 + libX11 through ctypes; no X tools needed). Run without blocking the main loop,
// which has to keep running to draw a native dialog.
const X11_TITLES = `
import ctypes, json
x = ctypes.cdll.LoadLibrary("libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]; x.XDefaultRootWindow.restype = ctypes.c_ulong
U = ctypes.c_ulong; P = ctypes.POINTER
x.XQueryTree.argtypes = [ctypes.c_void_p, U, P(U), P(U), P(P(U)), P(ctypes.c_uint)]
x.XFetchName.argtypes = [ctypes.c_void_p, U, P(ctypes.c_char_p)]
d = x.XOpenDisplay(None); names = []
def walk(w, depth):
    r, p, ch, n = U(), U(), P(U)(), ctypes.c_uint()
    if not x.XQueryTree(d, w, ctypes.byref(r), ctypes.byref(p), ctypes.byref(ch), ctypes.byref(n)): return
    for i in range(n.value):
        name = ctypes.c_char_p()
        if x.XFetchName(d, ch[i], ctypes.byref(name)) and name.value: names.append(name.value.decode("utf-8", "replace"))
        if depth < 2: walk(ch[i], depth + 1)
if d: walk(x.XDefaultRootWindow(d), 0)
print(json.dumps(names))`;
const windowTitles = () => new Promise((resolve) => execFile("python3", ["-c", X11_TITLES], { timeout: 5_000 }, (error, stdout) => {
  try { resolve(error ? [`error:${error.message}`] : JSON.parse(stdout)); } catch { resolve(["error:unparsed"]); }
}));

// A desktop notification server on the session bus (python3 + libgio through ctypes): it answers Notify like a desktop
// does and prints "NOTIFY <the call's arguments>" for each notification Electron actually hands to the desktop.
const NOTIFY_SERVER = String.raw`
import ctypes, sys
g = ctypes.cdll.LoadLibrary("libgio-2.0.so.0")
V = ctypes.c_void_p; S = ctypes.c_char_p
g.g_bus_get_sync.restype = V; g.g_bus_get_sync.argtypes = [ctypes.c_int, V, V]
g.g_dbus_node_info_new_for_xml.restype = V; g.g_dbus_node_info_new_for_xml.argtypes = [S, V]
g.g_dbus_node_info_lookup_interface.restype = V; g.g_dbus_node_info_lookup_interface.argtypes = [V, S]
g.g_variant_parse.restype = V; g.g_variant_parse.argtypes = [V, S, V, V, V]
g.g_variant_print.restype = ctypes.c_char_p; g.g_variant_print.argtypes = [V, ctypes.c_int]
g.g_dbus_method_invocation_return_value.argtypes = [V, V]
g.g_dbus_connection_register_object.restype = ctypes.c_uint
g.g_dbus_connection_register_object.argtypes = [V, S, V, V, V, V, V]
g.g_dbus_connection_call_sync.restype = V
g.g_dbus_connection_call_sync.argtypes = [V, S, S, S, S, V, V, ctypes.c_int, ctypes.c_int, V, V]
g.g_main_loop_new.restype = V; g.g_main_loop_new.argtypes = [V, ctypes.c_int]; g.g_main_loop_run.argtypes = [V]
XML = b"""<node><interface name='org.freedesktop.Notifications'>
<method name='Notify'><arg type='s' direction='in'/><arg type='u' direction='in'/><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='as' direction='in'/><arg type='a{sv}' direction='in'/><arg type='i' direction='in'/><arg type='u' direction='out'/></method>
<method name='CloseNotification'><arg type='u' direction='in'/></method>
<method name='GetCapabilities'><arg type='as' direction='out'/></method>
<method name='GetServerInformation'><arg type='s' direction='out'/><arg type='s' direction='out'/><arg type='s' direction='out'/><arg type='s' direction='out'/></method>
</interface></node>"""
CB = ctypes.CFUNCTYPE(None, V, S, S, S, S, V, V, V)
count = [0]
def call(conn, sender, path, iface, method, params, inv, data):
    m = method.decode()
    if m == "Notify":
        count[0] += 1
        print("NOTIFY " + g.g_variant_print(params, 0).decode("utf-8", "replace"), flush=True)
        reply = b"(uint32 %d,)" % count[0]
    elif m == "GetCapabilities": reply = b"(['body', 'actions'],)"
    elif m == "GetServerInformation": reply = b"('fixture', 'fixture', '1', '1.2')"
    else: reply = b"()"
    g.g_dbus_method_invocation_return_value(inv, g.g_variant_parse(None, reply, None, None, None))
cb = CB(call)
class VT(ctypes.Structure): _fields_ = [("m", CB), ("g", V), ("s", V), ("pad", V * 8)]
vt = VT(cb, None, None)
conn = g.g_bus_get_sync(2, None, None)
if not conn: print("NOBUS", flush=True); sys.exit(2)
iface = g.g_dbus_node_info_lookup_interface(g.g_dbus_node_info_new_for_xml(XML, None), b"org.freedesktop.Notifications")
g.g_dbus_connection_register_object(conn, b"/org/freedesktop/Notifications", iface, ctypes.byref(vt), None, None, None)
r = g.g_dbus_connection_call_sync(conn, b"org.freedesktop.DBus", b"/org/freedesktop/DBus", b"org.freedesktop.DBus", b"RequestName",
  g.g_variant_parse(None, b"('org.freedesktop.Notifications', uint32 4)", None, None, None), None, 0, -1, None, None)
print("READY " + (g.g_variant_print(r, 0).decode() if r else "none"), flush=True)
g.g_main_loop_run(g.g_main_loop_new(None, 0))
`;
const shownOnDesktop = [];
let notifyServer = "no session bus (DBUS_SESSION_BUS_ADDRESS unset)";
function startNotifyServer() {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return Promise.resolve();
  return new Promise((resolve) => {
    const child = execFile("python3", ["-c", NOTIFY_SERVER], { timeout: 170_000 });
    let buffered = "";
    notifyServer = "not ready";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (let at; (at = buffered.indexOf("\n")) >= 0;) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        if (line.startsWith("READY")) { notifyServer = line === "READY (1,)" ? "ready" : line; resolve(); }
        if (line.startsWith("NOTIFY ")) shownOnDesktop.push(line.slice("NOTIFY ".length));
      }
    });
    child.on("exit", (code) => { if (notifyServer !== "ready") notifyServer = `exited ${code}`; resolve(); });
    child.unref?.();
  });
}
const SHOW_NOTIFICATION = (title) => `new Promise((resolve) => { const n = new Notification(${JSON.stringify(title)}); n.onshow = () => resolve("show");
  n.onerror = () => resolve("error"); setTimeout(() => resolve("no-event"), 3000); })`;
/** What the desktop notification server received for `title`, after giving the bus a moment. */
async function desktopGot(title) {
  for (let i = 0; i < 10 && !shownOnDesktop.some((call) => call.includes(`'${title}'`)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return shownOnDesktop.filter((call) => call.includes(`'${title}'`)).length;
}

/** Starts a download from `win`'s page and reports what Electron did with it after open()'s will-download ran. */
function download(ses, win, href, { choose = true } = {}) {
  let listener = null;
  const seen = new Promise((resolve) => {
    ses.once("will-download", listener = (_event, item, contents) => {
      // Registered after open()'s listener, so this sees the item exactly as the Cloud handler left it.
      const dialog = item.getSaveDialogOptions();
      const name = item.getFilename();
      const fromWindow = contents === win.webContents;
      const chain = item.getURLChain();
      if (!choose) { resolve({ state: item.getState(), dialog, fromWindow, chain, item }); return; } // nobody chooses: Electron shows its dialog
      if (item.getState() !== "progressing") { resolve({ state: item.getState(), dialog, fromWindow, chain, bytes: null }); return; } // already ended
      // THE DIALOG BOUNDARY (MAIN-RULING cl-pf-l5-native-dialog): the OS save dialog is the operating system's and cannot be
      // driven here, so this replaces ONLY its result, the path a person would pick. Everything before it (Electron's
      // will-download, open()'s refusal and dialog options, read back above) and after it (Electron writing the bytes) is real.
      item.setSavePath(path.join(saved, name));
      item.once("done", (_e, state) => {
        let bytes = null;
        try { bytes = state === "completed" ? readFileSync(path.join(saved, name), "utf8") : null; } catch {}
        resolve({ state, dialog, fromWindow, chain, bytes });
      });
    });
  });
  const linkName = href.startsWith("blob-of:") ? "notes.txt" : href.startsWith("data:") ? "data.bin" : "";
  const anchor = href.startsWith("blob-of:")
    ? `URL.createObjectURL(new Blob([${JSON.stringify(href.slice("blob-of:".length))}], { type: "application/octet-stream" }))` : JSON.stringify(href);
  // A link to another origin is not downloaded (Chromium navigates instead, and open()'s guard stops that), so another home's
  // URL is loaded the way a page can reach it: in a subframe, whose attachment response Electron turns into a download.
  if (href.startsWith("frame:")) void run(win, `(() => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(href.slice("frame:".length))}; document.body.append(f); return true; })()`);
  else void run(win, `(() => { const a = document.createElement("a"); a.href = ${anchor}; a.download = ${JSON.stringify(linkName)}; document.body.append(a); a.click(); return true; })()`);
  // A row that times out takes its listener with it, so it can never catch (and misreport) the next row's download.
  return withTimeout(seen, 15_000, "will-download").then((outcome) => { ses.removeListener("will-download", listener); return outcome; });
}

app.on("window-all-closed", () => {});
// No top-level await: an ESM main entry's top-level await holds back app "ready".
void main();
async function main() {
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
await startNotifyServer();
await app.whenReady();
const ses = session.fromPartition(`persist:cloud-${HOME}`);
// A home answer that redirects, for the redirect-chain rows. The protocol layer refuses an upstream redirect itself
// (cloud-home-protocol.mjs "redirect refused"), so this wrapper stands in for a redirect that got past it: two fixture URLs
// answer 302 here; every other request goes to the handler open() installs, untouched. Electron follows the redirect and
// hands will-download the whole chain. One more fixture URL stands in for another home's file reaching this session (this
// session's handler answers only its own home).
const REDIRECTS = new Map([
  [`murage-home://home-b/api/files/att-1/download`, `murage-home://${HOME}/api/files/att-1/download`], // starts in another home
  [`murage-home://${HOME}/api/files/att-1/moved`, `murage-home://${HOME}/app.bin`], // leaves the home's file routes
]);
const handle = ses.protocol.handle.bind(ses.protocol);
const DATA_FILE = "data:application/octet-stream,fixture%20data%20bytes%0A";
const OTHER_HOME_FILE = "murage-home://home-b/api/files/att-1/other";
ses.protocol.handle = (scheme, handler) => handle(scheme, (request) => (REDIRECTS.has(request.url)
  ? new Response(null, { status: 302, headers: { location: REDIRECTS.get(request.url) } })
  : request.url === OTHER_HOME_FILE ? new Response("other home bytes\n", { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="other.pdf"' } })
  : handler(request)));
// Pass-through recorder: whatever handler open() installs still answers every check; this only notes what Electron handed
// it (which window, top frame or not, a requestingUrl or none) so the run shows the shapes the real app sees.
const checks = [];
const install = ses.setPermissionCheckHandler.bind(ses);
ses.setPermissionCheckHandler = (handler) => install(handler && ((contents, permission, requestingOrigin, details) => {
  const answer = handler(contents, permission, requestingOrigin, details);
  checks.push({ permission, sender: contents === null ? "none" : contents === win?.webContents ? "owned" : "other", isMainFrame: details?.isMainFrame,
    requestingUrl: details?.requestingUrl ?? null, requestingOrigin, answer });
  return answer;
}));
result.checks = checks;
step("open");
let win = null;
win = cloud.open(HOME);
await withTimeout(loaded(win), 20_000, "load");
step("loaded " + win.webContents.getURL());

result.notificationRequest = await run(win, "Notification.requestPermission()");
result.notificationPermission = await run(win, "Notification.permission");
result.microphone = await run(win, "navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'stream'; }, (e) => e.name)");
result.camera = await run(win, "navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'stream'; }, (e) => e.name)");
result.microphoneQuery = await run(win, "navigator.permissions.query({ name: 'microphone' }).then((s) => s.state, (e) => e.name)");
result.subframe = await run(win, `new Promise((resolve) => { const f = document.createElement("iframe"); f.src = "/index.html?frame=1";
  f.onload = async () => { const w = f.contentWindow; resolve({ notification: w.Notification.permission,
    microphone: await w.navigator.permissions.query({ name: "microphone" }).then((s) => s.state, (e) => e.name),
    stream: await w.navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return "stream"; }, (e) => e.name) }); };
  document.body.append(f); })`);
// What else asks the check: a dedicated worker on this home's origin, and showing a notification.
const WORKER_NOTIFICATION = `new Promise((resolve) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(self.Notification ? Notification.permission : 'none')"], { type: "text/javascript" })));
  w.onmessage = (e) => resolve(e.data); w.onerror = (e) => resolve("error:" + e.message); })`;
result.workerNotification = await run(win, WORKER_NOTIFICATION);
result.notifyServer = notifyServer;
result.showNotification = await run(win, SHOW_NOTIFICATION("fixture-owned"));
result.desktopOwned = await desktopGot("fixture-owned");
result.homeFile = await download(ses, win, "/api/files/att-1/download");
result.appAsset = await download(ses, win, "/app.bin");
result.blobFile = await download(ses, win, "blob-of:fixture blob bytes\n");
// A data: URL link the page clicks (the window's request filter lets data: through, so Electron makes it a download).
result.dataFile = await download(ses, win, DATA_FILE);
result.otherHome = await download(ses, win, `frame:${OTHER_HOME_FILE}`);
result.redirectIn = await download(ses, win, "frame:murage-home://home-b/api/files/att-1/download");
result.redirectOut = await download(ses, win, `murage-home://${HOME}/api/files/att-1/moved`);

// A browser pop-out page on the same session (same partition and origin), not the owned Cloud window.
const popout = new BrowserWindow({ show: true, webPreferences: { partition: `persist:cloud-${HOME}`, contextIsolation: true, sandbox: true } });
await popout.loadURL(`murage-home://${HOME}/?surface=browser-popout&bot=bot-1`).catch(() => {});
result.popoutNotificationRequest = await run(popout, "Notification.requestPermission()");
result.popoutNotificationPermission = await run(popout, "Notification.permission");
result.popoutWorkerNotification = await run(popout, WORKER_NOTIFICATION);
result.popoutShowNotification = await run(popout, SHOW_NOTIFICATION("fixture-popout"));
result.desktopPopout = await desktopGot("fixture-popout");
result.popoutMicrophone = await run(popout, "navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'stream'; }, (e) => e.name)");
result.popoutMicrophoneQuery = await run(popout, "navigator.permissions.query({ name: 'microphone' }).then((s) => s.state, (e) => e.name)");
// The pop-out page drops its ?surface= query from its own URL: only "not the owned window" is left to refuse it.
result.popoutRewritten = await run(popout, `(async () => { history.replaceState(null, "", "/"); return { url: location.href, notification: Notification.permission,
  microphone: await navigator.permissions.query({ name: "microphone" }).then((s) => s.state, (e) => e.name) }; })()`);
result.popoutDownload = await download(ses, popout, "/api/files/att-1/download");
// Last: a home file nobody picks a path for, so Electron itself opens the native save dialog; the X server shows its title.
const before = new Set(await windowTitles());
const shown = await download(ses, win, "/api/files/att-1/download", { choose: false });
let opened = [];
for (let i = 0; i < 40 && opened.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  opened = (await windowTitles()).filter((title) => !before.has(title));
}
result.nativeSaveDialog = { state: typeof shown === "string" ? shown : shown.state, opened };
if (typeof shown === "object") { try { shown.item.cancel(); } catch {} }
result.downloadsDir = downloads;

process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
server.close();
app.exit(0);
}
