// SPDX-License-Identifier: AGPL-3.0-or-later
// Both fake-engine producer and field-replay consumer are owned by c3-memory.
// A private fixture mailbox asks the fake model to call its existing native
// session. It never calls a product HTTP route or opens a second relay.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function serveToolMailbox(directory: string | undefined, call: (server: string, name: string, args: Record<string, unknown>) => Promise<unknown>): void {
  if (!directory) return;
  const request = join(directory, `${process.pid}-request.json`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !existsSync(request)) return;
    busy = true;
    try {
      const row = JSON.parse(readFileSync(request, "utf8"));
      unlinkSync(request);
      const response = join(directory, `${process.pid}-${row.id}.json`);
      const reply = (value: unknown) => {
        writeFileSync(response + ".pending", JSON.stringify(value), { mode: 0o600 });
        renameSync(response + ".pending", response);
      };
      try { reply({ result: await call(row.server, row.name, row.args) }); }
      catch (error) { reply({ error: String(error) }); }
    } finally { busy = false; }
  }, 10);
  timer.unref();
}
