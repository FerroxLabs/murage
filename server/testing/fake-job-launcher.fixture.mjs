#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stand-in for the Windows engine job launcher (server/job-launcher.ts) on any OS, for the ACP tree-stop test (U24 T11):
// the process the server spawns is this one, and the engine CLI is its child, so the server's child.pid (this launcher)
// and the engine's pid differ exactly as they do on Windows. argv: [command, ...args]. Stdio is inherited, so the driver
// talks to the CLI. Each start appends "<launcher pid> <cli pid>" to FAKE_LAUNCHER_LOG (the real launcher reports the
// CLI pid on fd 3). The exit is the CLI's.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit" });
child.on("spawn", () => {
  if (process.env.FAKE_LAUNCHER_LOG) appendFileSync(process.env.FAKE_LAUNCHER_LOG, `${process.pid} ${child.pid}\n`);
});
child.on("error", () => process.exit(127));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
