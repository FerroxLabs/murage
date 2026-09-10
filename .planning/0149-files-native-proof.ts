import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const mainSource = join(root, "electron/main.mjs"), preload = join(root, "electron/preload.cjs");
const source = readFileSync(mainSource, "utf8");
const start = source.indexOf('ipcMain.handle("desktop:artifact-action",');
const end = source.indexOf('\n\nipcMain.handle("desktop:save-file",', start);
assert(start >= 0 && end > start && source.indexOf('ipcMain.handle("desktop:artifact-action",', start + 1) === -1);
const handler = source.slice(start, end);
assert(handler.trimEnd().endsWith("});"));
assert.equal((handler.match(/ipcMain\.handle\(/g) ?? []).length, 1);
new Function("ipcMain", "BrowserWindow", "app", "SERVER_PORT", "DEV_URL", "desktopSurfaceSecret", "fetch", "dialog", "verifiedArtifactNativePath", "ownedDesktopDataDir", "path", "shell", handler);
const handlerSha256 = digest(handler), preloadSha256 = digest(readFileSync(preload));
if (process.argv.includes("--prepare-only")) {
  console.log(JSON.stringify({ sourceExtraction: "passed", handlerSha256, preloadSha256, noNativeInvocation: true }));
} else {
  assert.equal(process.platform, "darwin");
  const exec = promisify(execFile);
  const scratch = mkdtempSync(join(tmpdir(), "murage-files-native-"));
  const evidence = join(root, ".planning", `0149-files-native-${Date.now()}`);
  mkdirSync(evidence, { mode: 0o700 });
  const report: Record<string, any> = { status: "running", startedAt: new Date().toISOString(), scratch, evidence, handlerSha256, preloadSha256, limits: "Actual preload + verbatim current IPC handler + real owner HTTP + real macOS shell dispatch. No full app startup, vendor model, Windows/Linux or document-rendering proof." };
  let fixture: VerificationServer | undefined, child: ChildProcess | undefined, ui: ReturnType<typeof createServer> | undefined, privateConfig: string | undefined;
  let stdout = "", stderr = "";
  const frontmost = async () => {
    const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit");var app=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(app.processIdentifier),bundle:String(ObjC.unwrap(app.bundleIdentifier)||"")});']);
    return JSON.parse(stdout.trim());
  };
  let originalFront: { pid: number; bundle: string } | undefined;
  try {
    originalFront = await frontmost();
    fixture = await launchVerificationServer({});
    report.fixture = { ...fixture.info };
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture!.info.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      assert(response.ok, `${method} ${path}: ${response.status}`); return await response.json() as any;
    };
    const bot = (await api("POST", "/api/bots", { name: "Native Files fixture" })).bot;
    const workspace = join(fixture.info.dataDir, "workspaces", bot.id); mkdirSync(workspace, { recursive: true });
    const text = "Murage native Files verification\n\nBenign temporary report.\nThe silver lantern is ready.\n";
    writeFileSync(join(workspace, "report.txt"), text, { mode: 0o600 });
    const artifact = (await api("POST", "/api/artifacts/register", { botId: bot.id, threadId: bot.threadId, relativePath: "report.txt", name: "Native Files report" })).artifact;
    assert.equal(artifact.sha256, digest(text));
    const native = await api("GET", `/api/artifacts/${artifact.id}/native`);
    assert.equal(digest(readFileSync(native.path)), artifact.sha256);
    report.artifact = { id: artifact.id, sha256: artifact.sha256, savedPath: native.path, originalPath: join(workspace, "report.txt") };
    const page = `<!doctype html><meta charset="utf-8"><title>Murage native Files verification</title><style>body{font:18px system-ui;padding:36px;background:#f5f6f8;color:#182432}button{font:inherit;padding:12px 24px;margin-right:12px}pre{white-space:pre-wrap}</style><h1>Native Files verification</h1><p>Benign report.txt · verified immutable saved copy</p><button data-action="open">Open report</button><button data-action="reveal">Reveal report</button><pre id="result">Ready</pre><script>document.querySelectorAll('button').forEach(button=>button.addEventListener('click',async()=>{const action=button.dataset.action;window.actionResult={action,status:'running'};try{await window.muragebox.artifactAction(${JSON.stringify(artifact.id)},action);window.actionResult={action,status:'passed'};}catch(error){window.actionResult={action,status:'failed',error:String(error)};}document.querySelector('#result').textContent=JSON.stringify(window.actionResult,null,2);}));</script>`;
    ui = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page); });
    await new Promise<void>((resolve, reject) => { ui!.once("error", reject); ui!.listen(0, "127.0.0.1", resolve); });
    const address = ui.address(); assert(address && typeof address !== "string");
    const uiUrl = `http://127.0.0.1:${address.port}`;
    report.uiUrl = uiUrl;
    const userData = join(scratch, "electron-user-data"), home = join(scratch, "home"), temp = join(scratch, "tmp");
    for (const path of [userData, home, temp]) mkdirSync(path, { mode: 0o700 });
    privateConfig = join(scratch, "private-fixture.json");
    const output = join(evidence, "native-receipt.json");
    writeFileSync(privateConfig, JSON.stringify({ userData, mainSource, preload, handlerSha256, preloadSha256, serverPort: Number(new URL(fixture.info.url).port), uiUrl, desktopSecret: proof.secret, dataDir: fixture.info.dataDir, savedPath: native.path, sha256: artifact.sha256, artifactId: artifact.id, output, screenshot: join(evidence, "native-fixture.png") }), { mode: 0o600 });
    const executable = join(root, "node_modules/electron/dist", readFileSync(join(root, "node_modules/electron/path.txt"), "utf8").trim());
    report.executable = executable;
    child = spawn(executable, [join(root, ".planning/0149-files-native-child.mjs")], { cwd: scratch, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, MURAGE_FILES_NATIVE_CONFIG: privateConfig }, stdio: ["ignore", "pipe", "pipe"] });
    report.nativePid = child.pid;
    child.stdout!.on("data", chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child?.kill("SIGTERM"); });
    child.stderr!.on("data", chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child?.kill("SIGTERM"); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child?.kill("SIGTERM"); reject(new Error("Native fixture timeout")); }, 45000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Native fixture exit ${code}`)); });
    });
    writeFileSync(join(evidence, "native-stdout.log"), stdout); writeFileSync(join(evidence, "native-stderr.log"), stderr);
    report.native = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.native.status, "passed");
    assert.equal(digest(readFileSync(native.path)), artifact.sha256);
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message : "Native Files check failed"; process.exitCode = 1;
  } finally {
    try {
      if (child) await waitForExit(child, { signal: "SIGTERM" });
      writeFileSync(join(evidence, "native-stdout.log"), stdout); writeFileSync(join(evidence, "native-stderr.log"), stderr);
      const nativeReceipt = join(evidence, "native-receipt.json");
      if (existsSync(nativeReceipt)) report.native = JSON.parse(readFileSync(nativeReceipt, "utf8"));
      if (ui) await new Promise<void>((resolve, reject) => { ui!.close(error => error ? reject(error) : resolve()); ui!.closeAllConnections(); });
      if (privateConfig) rmSync(privateConfig, { force: true });
      if (fixture) {
        if (existsSync(fixture.info.logPath)) copyFileSync(fixture.info.logPath, join(evidence, "server.log"));
        // Keep the opened benign document path valid. Do not close a shared
        // editor/Finder or delete the backing file while its ownership is unclear.
        await waitForExit(fixture.child, { signal: "SIGTERM" });
        report.retainedProfile = fixture.info.dataDir;
      }
      report.cleanup = "Owned Electron/backend/UI listener stopped; private capability config removed. Benign document and temporary profile retained; no existing editor/Finder documents closed.";
      if (originalFront) {
        const script = `ObjC.import("AppKit");var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${originalFront.pid});if(Number(a.processIdentifier)!==${originalFront.pid}||String(ObjC.unwrap(a.bundleIdentifier)||"")!==${JSON.stringify(originalFront.bundle)})throw Error("Original app identity changed");a.activateWithOptions(2);`;
        await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
        report.foregroundRestored = JSON.stringify(await frontmost()) === JSON.stringify(originalFront);
      }
    } catch (error) { report.cleanupError = error instanceof Error ? error.message : "cleanup pending"; report.status = "failed"; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(evidence, "receipt.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  }
}
