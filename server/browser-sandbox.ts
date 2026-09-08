// Chromium's Windows AppContainer needs RX on the shipped browser binaries.
// This grants no write access and never changes the sandbox or a user profile.
import { execFile } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { browserBundlePaths, browserBundleSpec } from "./browser-bundle-release.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { verifyWindowsBrowserImage, verifyWindowsBrowserSignatures, WINDOWS_BROWSER_IMAGE_PINS, WINDOWS_BROWSER_POWERSHELL_SETUP } from "./browser-windows-identity.ts";
const prepared = new Map<string, Promise<void>>();
export async function ensureBrowserSandboxAccess(spec: AgentBrowserSpec): Promise<void> {
  if (process.platform !== "win32") return;
  const directory = spec.env.MURAGE_BROWSER_BUNDLE_DIR;
  if (!directory) throw new Error("Windows browser requires Murage's verified bundled Chromium");
  const root = resolve(directory), paths = browserBundlePaths(root, "win32-x64"), pin = browserBundleSpec("win32-x64");
  if (resolve(spec.command) !== paths.engine || resolve(spec.env.AGENT_BROWSER_EXECUTABLE_PATH ?? "") !== paths.chrome) throw new Error("Browser bundle identity does not match its launch configuration");
  if (prepared.has(root)) return prepared.get(root)!;
  const operation = (async () => {
    const signed: string[] = [];
    for (const [file, original] of [[paths.engine, WINDOWS_BROWSER_IMAGE_PINS.engine], [paths.chrome, WINDOWS_BROWSER_IMAGE_PINS.chrome]] as const) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Browser bundle file is invalid");
      if (verifyWindowsBrowserImage(readFileSync(file), original).signed) signed.push(file);
    }
    if (!lstatSync(paths.licenses).isDirectory()) throw new Error("Browser bundle failed identity verification");
    if (signed.length) await verifyWindowsBrowserSignatures(signed, spec.env.SystemRoot);
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    if (manifest.engine?.sha256 !== pin.engine.sha256 || manifest.chrome?.executableSha256 !== pin.chrome.executableSha256) throw new Error("Browser bundle manifest is invalid");
    const chromeDirectory = dirname(paths.chrome);
    if (lstatSync(chromeDirectory).isSymbolicLink()) throw new Error("Browser bundle directory cannot be a link");
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    // Check existing permissions first: Program Files may already grant RX,
    // and a standard user should not need elevation to use a correct install.
    const script = WINDOWS_BROWSER_POWERSHELL_SETUP + `$root=${quote(chromeDirectory)}; $sid='S-1-15-2-1'; $rx=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute; $needs=$false; foreach($item in @((Get-Item -LiteralPath $root))+(Get-ChildItem -LiteralPath $root -Recurse -Force)){ $ok=$false; foreach($rule in (Get-Acl -LiteralPath $item.FullName).Access){try{$id=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{continue}; if($id -eq $sid -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $rx) -eq $rx){$ok=$true}}; if(-not $ok){$needs=$true;break}}; if($needs){ & (Join-Path $env:SystemRoot 'System32\\icacls.exe') $root /grant '*S-1-15-2-1:(OI)(CI)(RX)' /T /C | Out-Null; if($LASTEXITCODE -ne 0){throw 'Browser sandbox file access could not be prepared'}}`;
    await new Promise<void>((done, fail) => execFile(join(spec.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20_000, maxBuffer: 8192 }, error => error ? fail(new Error("Windows browser sandbox file access needs repair. Reinstall Murage or repair its bundled browser permissions.")) : done()));
  })();
  prepared.set(root, operation);
  try { await operation; } catch (error) { prepared.delete(root); throw error; }
}
