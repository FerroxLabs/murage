// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writer and installer for the `murage-exec` Claude shell prefix
// (APP-GRANT-DESIGN Rule 69f / 74b). The wrapper text is the file
// server/drivers/murage-exec beside this one (packaging must ship it, as it
// ships the permission proxy). The installed wrapper and the per-turn
// environment file are sensitive rows: an engine that could rewrite either
// would rewrite what every command runs under.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Names the wrapper reads from the file itself; never part of the command's environment. */
export const EXEC_CWD = "MURAGE_EXEC_CWD";
export const EXEC_SHELL = "MURAGE_EXEC_SHELL";
/** The one name in the wrapper's own environment. */
export const EXEC_ENV_FILE = "MURAGE_EXEC_ENV_FILE";

export const WRAPPER_SOURCE = readWrapperSource();

function readWrapperSource(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "murage-exec"), "utf8");
}

let installDir: string | null = null;
/** A private (0700) folder made for this process; removed at exit. */
function privateDir(): string {
  if (!installDir || !existsSync(installDir)) {
    installDir = mkdtempSync(join(tmpdir(), "murage-exec-"));
    const dir = installDir;
    chmodSync(dir, 0o700);
    process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return installDir;
}

/** Install the wrapper (0755) and return its path. Named by content hash, written once. */
export function installMurageExec(): string {
  const hash = createHash("sha256").update(WRAPPER_SOURCE).digest("hex").slice(0, 16);
  const path = join(privateDir(), `murage-exec-${hash}`);
  if (!existsSync(path)) {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(temp, WRAPPER_SOURCE, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, path);
  }
  return path;
}

/** The value Claude is handed as `CLAUDE_CODE_SHELL_PREFIX`. On Windows Claude puts it into a Git Bash command line, so
 *  the path is spelled with forward slashes (a backslash there is an escape). */
export function murageExecPrefix(platform: NodeJS.Platform = process.platform): string {
  const path = installMurageExec();
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/** The environment file text: NUL-separated name=value, the directory and the shell first. */
export function execEnvFileText(env: Readonly<Record<string, string>>, cwd: string, shell: string): string {
  const pairs = [`${EXEC_CWD}=${cwd}`, `${EXEC_SHELL}=${shell}`];
  for (const [name, value] of Object.entries(env)) {
    if (name.includes("=") || name.includes("\0") || value.includes("\0") || name === EXEC_CWD || name === EXEC_SHELL) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.map((pair) => `${pair}\0`).join("");
}

/** Write (or rewrite) one thread's environment file, 0600, and return its path. */
export function writeExecEnvFile(key: string, env: Readonly<Record<string, string>>, cwd: string, shell: string): string {
  const dir = join(privateDir(), "env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, createHash("sha256").update(key).digest("hex").slice(0, 24));
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, execEnvFileText(env, cwd, shell), { mode: 0o600 });
  renameSync(temp, path);
  return path;
}

/** Set only on an MCP server's own env in the mcp.json: the names of that env, comma separated. Claude starts each stdio
 *  server through the shell prefix with that env on the prefix process, and the wrapper carries exactly these names over
 *  its `env -i`. Never in Claude's own environment, so a Bash command gains nothing from it. */
export const EXEC_KEEP = "MURAGE_EXEC_KEEP";
const KEEPABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The same servers with MURAGE_EXEC_KEEP on every stdio server (one with a `command`) that has env of its own, naming
 *  exactly that env (its ELECTRON_RUN_AS_NODE, its credential-file names, an owner server's own variables). */
export function withExecKeep(servers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const stanza = server as { command?: unknown; env?: unknown } | null;
    if (!stanza || typeof stanza !== "object" || typeof stanza.command !== "string" || !stanza.env || typeof stanza.env !== "object") {
      out[name] = server;
      continue;
    }
    const env = { ...(stanza.env as Record<string, string>) };
    delete env[EXEC_KEEP];
    const names = Object.keys(env).filter((key) => KEEPABLE_NAME.test(key) && !key.startsWith("MURAGE_EXEC_"));
    out[name] = names.length ? { ...stanza, env: { ...env, [EXEC_KEEP]: names.join(",") } } : { ...stanza, env };
  }
  return out;
}
