// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 Windows gate (Git Bash, Ask): the broker's named pipe lost a backslash on its way through Git Bash, the proxy
// reached nothing and every ask was denied with no card. These pin the argv spelling the driver hands the proxy.

import { describe, expect, it } from "vitest";
import { brokerPathAccepted, brokerPathForArgv, brokerPathFromArgv } from "./permission-pipe.ts";

/** What Git for Windows' bash.exe does to `\\` in the command line it is started with (measured on Git for Windows:
 * a native spawn of `bash.exe -c "'node' 'client.js' '\\.\pipe\x'"` hands node `\.\pipe\x`). */
const throughGitBash = (word: string): string => word.replace(/\\\\/g, "\\");

describe("permission broker path on the proxy's argv", () => {
  const pipe = "\\\\.\\pipe\\murage-perm-5828-ba2a1d2e";

  it("a Windows pipe crosses Git Bash intact and the proxy connects to the very pipe the broker bound", () => {
    const argv = brokerPathForArgv(pipe, "win32");
    expect(argv).not.toContain("\\");
    expect(throughGitBash(argv)).toBe(argv);
    expect(brokerPathFromArgv(throughGitBash(argv), "win32")).toBe(pipe);
  });

  it("a fallback pipe (random suffix) and the \\\\?\\ form keep their names", () => {
    const fallback = `${pipe}-a1b2c3`;
    expect(brokerPathFromArgv(throughGitBash(brokerPathForArgv(fallback, "win32")), "win32")).toBe(fallback);
    const verbatim = "\\\\?\\pipe\\murage-perm-1-x";
    expect(brokerPathFromArgv(brokerPathForArgv(verbatim, "win32"), "win32")).toBe(verbatim);
  });

  it("the proxy repairs the one-backslash form a mangling shell leaves", () => {
    expect(brokerPathFromArgv(throughGitBash(pipe), "win32")).toBe(pipe);
    expect(brokerPathFromArgv(pipe, "win32")).toBe(pipe);
  });

  it("POSIX socket paths pass through untouched both ways", () => {
    const sock = "/home/u/.murage/perm-ba2a1d2e.sock";
    expect(brokerPathForArgv(sock, "linux")).toBe(sock);
    expect(brokerPathFromArgv(sock, "darwin")).toBe(sock);
    // a POSIX path that merely looks like a pipe is not rewritten off Windows
    expect(brokerPathFromArgv("//./pipe/x", "linux")).toBe("//./pipe/x");
  });
});

describe("U22: the broker paths the proxy will connect to", () => {
  it("Windows: only Murage's own permission pipe on this machine, as the driver binds it", () => {
    for (const ok of ["\\\\.\\pipe\\murage-perm-5828-ba2a1d2e", "\\\\.\\pipe\\murage-perm-5828-t_1x9f3a-a1b2c3"]) {
      expect(brokerPathAccepted(ok, "win32")).toBe(true);
      expect(brokerPathAccepted(brokerPathFromArgv(brokerPathForArgv(ok, "win32"), "win32"), "win32")).toBe(true);
    }
    for (const bad of ["", "\\\\host\\pipe\\murage-perm-1-x", "\\\\.\\pipe\\other-perm-1", "\\\\.\\pipe\\murage-perm-", "\\\\.\\pipe\\murage-perm-1\\..\\x",
      "\\\\?\\pipe\\murage-perm-1-x", "C:\\Users\\a\\perm-1.sock", "\\\\.\\pipe\\murage-perm-1 x", "\\\\.\\pipe\\murage-perm-1\0"]) {
      expect(brokerPathAccepted(bad, "win32")).toBe(false);
    }
  });

  it("macOS and Linux: an absolute path to a .sock file", () => {
    for (const ok of ["/home/a/.murage/perm-t1ab12.sock", "/tmp/murage-perm-0123456789abcdef.sock"]) expect(brokerPathAccepted(ok, "linux")).toBe(true);
    for (const bad of ["", "perm-1.sock", "/tmp/evil", "/.sock", "/tmp/x.sock\0", "/tmp/x.sock.txt"]) expect(brokerPathAccepted(bad, "darwin")).toBe(false);
  });
});
