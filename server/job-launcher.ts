// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows engine job launcher (U24 design R2). The server cannot create a process suspended, so the first process of an engine
// turn's tree is this one: it is put in the turn's job while it is still blocked here, and only then does it start the CLI.
// Windows puts a process into its creator's jobs at CreateProcess, before its first instruction, and the job allows no
// breakaway, so the CLI and everything it ever starts are in the job by construction.
//
// Contract with server/procs.ts (spawnCli):
//   argv            [launcher, "--", command, ...args]
//   environment     fixed and minimal (ELECTRON_RUN_AS_NODE plus what the runtime needs to load); nothing of the turn's, so
//                   no NODE_OPTIONS or loader can run code before the gate below
//   fd 0            the frame, written only after jobAssign succeeded: "<byte length>\n" then that many bytes of JSON
//                   { env, cwd }. Read with synchronous reads of exactly those bytes, never through process.stdin, so the
//                   driver's prompt bytes that follow in the same pipe stay for the CLI (it inherits fd 0).
//   fd 3            one line back: {"pid":N} once the CLI runs, or {"error":{code,syscall,path}} and exit 127 when it could
//                   not start. EOF on fd 0 before a frame: exit 0, nothing started.
//   exit            the CLI's exit code (1 for a signal), so the server's child object reports the engine's own result.
import { spawn } from "node:child_process";
import { readSync, writeSync } from "node:fs";

const readExact = (count: number): Buffer | null => {
  const out = Buffer.alloc(count);
  let have = 0;
  while (have < count) {
    let got: number;
    try { got = readSync(0, out, have, count - have, null); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      if ((error as NodeJS.ErrnoException).code === "EOF") return null;
      throw error;
    }
    if (got === 0) return null;
    have += got;
  }
  return out;
};

const readLine = (): string | null => {
  const bytes: number[] = [];
  for (;;) {
    const one = readExact(1);
    if (one === null) return null;
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(one[0]);
    if (bytes.length > 16) return null; // a length line is a few digits
  }
};

const report = (line: Record<string, unknown>): void => {
  try { writeSync(3, `${JSON.stringify(line)}\n`); } catch { /* the server may already be gone */ }
};

const main = (): void => {
  const separator = process.argv.indexOf("--");
  const command = separator >= 0 ? process.argv[separator + 1] : undefined;
  const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
  if (!command) { report({ error: { code: "EINVAL", syscall: "spawn", path: "" } }); process.exit(127); }
  const lengthLine = readLine();
  if (lengthLine === null) process.exit(0); // the server closed stdin without a frame: nothing to start
  const length = Number(lengthLine);
  if (!Number.isInteger(length) || length <= 0 || length > 64 * 1024 * 1024) { report({ error: { code: "EINVAL", syscall: "spawn", path: command } }); process.exit(127); }
  const frame = readExact(length);
  if (frame === null) process.exit(0);
  let env: Record<string, string> = {};
  let cwd: string | undefined;
  try {
    const parsed = JSON.parse(frame.toString("utf8")) as { env?: Record<string, string>; cwd?: string };
    env = parsed.env && typeof parsed.env === "object" ? parsed.env : {};
    cwd = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined;
  } catch { report({ error: { code: "EINVAL", syscall: "spawn", path: command } }); process.exit(127); }
  let child: ReturnType<typeof spawn>;
  try { child = spawn(command, args, { stdio: "inherit", env, cwd, windowsHide: true }); }
  catch (error) {
    // Node refuses some launches before any process exists (a .cmd or .bat without a shell: EINVAL). Reported like any other
    // spawn failure, so the server's child gets its `error` event instead of a silent exit.
    const failure = error as NodeJS.ErrnoException;
    report({ error: { code: failure.code ?? "ESPAWN", syscall: "spawn", path: failure.path ?? command } });
    process.exit(127);
  }
  child.on("error", (error: NodeJS.ErrnoException) => {
    // Node's syscall field carries the path ("spawn /x/cli"); the report keeps the bare syscall and the path apart.
    report({ error: { code: error.code ?? "ESPAWN", syscall: "spawn", path: error.path ?? command } });
    process.exit(127);
  });
  child.on("spawn", () => report({ pid: child.pid }));
  child.on("exit", (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
};

main();
