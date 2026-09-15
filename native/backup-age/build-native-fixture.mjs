import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32" || process.arch !== "x64") throw Error("Windows x64 fixture only");
const root = dirname(fileURLToPath(import.meta.url));
const environment = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat";
const command = `call "${environment}" -arch=x64 -host_arch=x64 && cl /nologo /std:c++20 /EHsc /W4 native\\backup-age\\native-fixture.cpp /Fo:native-probe.obj /Fe:native-probe.exe /link Advapi32.lib Kernel32.lib`;
execFileSync("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], { cwd: root, stdio: "inherit", windowsVerbatimArguments: true,
  env: { ...process.env, TEMP: join(root, "compiler-temp"), TMP: join(root, "compiler-temp") } });
