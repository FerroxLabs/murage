// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const lists = new Map<string, Promise<Set<string>>>();
/** Read the shipped proxy's actual tools/list, with no harness call or data. */
export function murageToolList(server: "agents" | "memory", role: "lead" | "member" | ""): Promise<Set<string>> {
  const key = `${server}:${role}`;
  let result = lists.get(key);
  if (result) return result;
  result = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL(`../drivers/${server}-proxy.ts`, import.meta.url))], {
      env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_PROJECT_ROLE: role }, stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "", answered = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Fixture tools/list timed out")); }, 10000);
    const send = (id: number, method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }) + "\n");
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); if (!answered) reject(new Error("Fixture proxy exited before tools/list")); });
    child.stdout.on("data", data => {
      buffer += String(data);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: { tools?: Array<{ name: string }> } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) send(2, "tools/list");
        if (message.id === 2 && message.result?.tools) {
          answered = true; clearTimeout(timer); child.kill(); resolve(new Set(message.result.tools.map(tool => tool.name)));
        }
      }
    });
    send(1, "initialize");
  });
  lists.set(key, result);
  return result;
}
