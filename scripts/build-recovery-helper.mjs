import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Recovery helper build requires Windows x64 with MSVC and Windows SDK.");
const root = fileURLToPath(new URL("../", import.meta.url));
const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
if (!existsSync(vswhere)) throw new Error("Existing Visual Studio C++ build tools are required; no installation or service changes were attempted.");
const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
if (!installation || /[\r\n\x00"%!]/.test(installation)) throw new Error("Visual Studio installation could not be resolved safely.");
const environment = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
if (!existsSync(environment)) throw new Error("Visual Studio developer environment is missing.");
mkdirSync(path.join(root, "dist-native", "recovery", "win32-x64"), { recursive: true });
const command = `call "${environment}" -arch=x64 -host_arch=x64 && cl /nologo /std:c++20 /EHsc /W4 /D_WIN32_WINNT=0x0602 native\\recovery-snapshot\\capture.cpp native\\recovery-snapshot\\broker.cpp /Fo:dist-native\\recovery\\win32-x64\\ /Fe:dist-native\\recovery\\win32-x64\\murage-recovery.exe /link VssApi.lib Ole32.lib OleAut32.lib Advapi32.lib Uuid.lib Shell32.lib`;
execFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], { cwd: root, stdio: "inherit", windowsVerbatimArguments: true });
if (!existsSync(path.join(root, "dist-native", "recovery", "win32-x64", "murage-recovery.exe"))) throw new Error("Recovery helper build did not produce its executable.");
