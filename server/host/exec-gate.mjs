// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fix/1022-o1m2 owns both the host launcher and the gate.
import { closeSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

// Read only the private release fd. The engine inherits stdin untouched.
function readExact(size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    try {
      const count = readSync(3, bytes, offset, size - offset, null);
      if (count === 0) return;
      offset += count;
    } catch (error) {
      if (error.code !== "EINTR") throw error;
    }
  }
  return bytes;
}

try {
  const [separator, executable, ...args] = process.argv.slice(2);
  if (separator !== "--" || !executable || !isAbsolute(executable) || !process.execve) process.exit(127);
  const header = readExact(4);
  if (!header) process.exit(0);
  const size = header.readUInt32BE();
  // A single release envelope is bounded well above the OS exec environment limit.
  if (size === 0 || size > 64 * 1024 * 1024) process.exit(127);
  const body = readExact(size);
  if (!body) process.exit(0);
  const { cwd, env } = JSON.parse(body.toString("utf8"));
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !env || typeof env !== "object" || Array.isArray(env)
      || Object.entries(env).some(([name, value]) => !name || /[=\0]/.test(name) || typeof value !== "string" || value.includes("\0"))) process.exit(127);
  closeSync(3);
  process.chdir(cwd);
  process.execve(executable, [executable, ...args], env);
  process.exit(127);
} catch {
  // Diagnostics must never include the environment, argv or cwd from a release envelope.
  process.exit(127);
}
