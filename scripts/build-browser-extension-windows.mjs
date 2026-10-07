// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function buildBrowserExtensionWindows({ platform = process.platform, arch = process.arch, env = process.env, root = fileURLToPath(new URL('../', import.meta.url)), exec = execFileSync, exists = existsSync, mkdir = mkdirSync } = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw Error('Browser native helper requires Windows x64 with existing MSVC and Windows SDK.');
  const join = path.win32.join;
  const vswhere = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!exists(vswhere)) throw Error('Existing Visual Studio C++ build tools are required; no installation attempted.');
  const installation = exec(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  if (!installation || /[\r\n\x00"%!]/.test(installation)) throw Error('Invalid Visual Studio installation path.');
  const environment = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  if (!exists(environment)) throw Error('Visual Studio developer environment is missing.');
  const directory = join(root, 'dist-native', 'browser-extension', 'win32-x64'); mkdir(directory, { recursive: true });
  const command = `call "${environment}" -arch=x64 -host_arch=x64 && cl /nologo /std:c++20 /EHsc /W4 /D_WIN32_WINNT=0x0602 native\\browser-extension\\transport.cpp /Fo:dist-native\\browser-extension\\win32-x64\\ /Fe:dist-native\\browser-extension\\win32-x64\\murage-browser-host.exe /link Advapi32.lib`;
  exec(env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', command], { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true });
  const executable = join(directory, 'murage-browser-host.exe'); if (!exists(executable)) throw Error('Browser native build produced no executable.');
  return executable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildBrowserExtensionWindows();
