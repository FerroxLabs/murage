// Transparent stdio bridge to the official Cua MCP server in a VPS
// container. Docker's SSH transport handles authentication through the
// user's normal SSH config and agent; this process stores no credentials.
import { spawn } from "node:child_process";

import { augmentedPath } from "./env-path.ts";
import { vpsContainerMcpArgs } from "./vps-computer.ts";

const [alias, containerName] = process.argv.slice(2);
let args: string[];
try {
  args = vpsContainerMcpArgs(alias ?? "", containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

const child = spawn("docker", args, {
  shell: false,
  env: { ...process.env, PATH: augmentedPath() },
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("error", (error) => {
  process.stderr.write(`could not connect to VPS Cua Driver: ${error.message}\n`);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.stderr.write(`VPS Cua Driver connection ended with ${signal}\n`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}
