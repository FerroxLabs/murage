// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How the permission proxy is told where the broker listens, on its argv.
//
// 1.0.3 (Windows with Git Bash): Claude Code starts every stdio MCP server
// through the murage-exec shell prefix, which is a Bash script, so the server's
// command line crosses a Windows command line into Git Bash's bash.exe. Git
// Bash reads `\\` there as an escaped backslash, so the broker's named pipe
// `\\.\pipe\murage-perm-...` reached the proxy as `\.\pipe\murage-perm-...`
// (verified on Git for Windows: a native spawn of bash.exe -c with the quoted
// line). The proxy then connected to nothing and denied every ask with "broker
// unavailable", and no approval card ever opened. The forward-slash spelling
// `//./pipe/...` has no backslash to lose and names the same pipe.
//
// No side effects here: the proxy imports this before it connects.

/** The text the proxy denies with when it cannot reach the broker. The driver
 * looks for it in the engine's tool results to log the miss in the app log. */
export const BROKER_UNAVAILABLE_NOTE = "Murage: permission broker unavailable, so skip this action";

/** The broker path as the proxy's argv carries it: a Windows named pipe in the
 * forward-slash spelling, a POSIX socket path unchanged. */
export function brokerPathForArgv(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  return /^\\\\[.?]\\pipe\\/i.test(path) ? path.replace(/\\/g, "/") : path;
}

/** The proxy's side: back to the canonical `\\.\pipe\` spelling Node documents,
 * from the forward-slash form, or from the one-backslash form an older
 * launcher's shell left. A POSIX path is returned unchanged. */
export function brokerPathFromArgv(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const match = /^(?:\/\/|\\\\|\\)([.?])[\\/]pipe[\\/](.+)$/i.exec(path);
  return match ? `\\\\${match[1]}\\pipe\\${match[2]!.replace(/\//g, "\\")}` : path;
}

/** U22: the only broker paths the proxy connects to. Windows: Murage's own permission pipe on this machine
 * (`\\.\pipe\murage-perm-<pid>-<tag>[-<hex>]`, brokerSocketPath), never a remote `\\host\pipe\` or another program's pipe.
 * Elsewhere: an absolute path to a `.sock` file (the data folder's perm-<tag>.sock or the temp murage-perm-<hex>.sock). A path
 * outside these is refused: the proxy then connects to nothing and answers every ask as a broker that is gone. */
export function brokerPathAccepted(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (path.includes("\0")) return false;
  if (platform === "win32") return /^\\\\\.\\pipe\\murage-perm-[\w-]+$/.test(path);
  return path.startsWith("/") && path.endsWith(".sock") && path.length > "/.sock".length;
}
