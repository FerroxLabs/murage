// SPDX-License-Identifier: AGPL-3.0-or-later
// A Mac restart leaves the Podman machine stopped. A turn for a bot whose computer is the Local VM must start that machine itself, through the
// turn start of a booted server (index.ts startTurnAdmitting), and not fail with "Start podman first". The server's child sees a Mac only for
// podman-machine.ts (a one-token loader change, like local-setup-failure.test.ts T13) and a fake podman on its PATH: `info` answers only after
// `machine start`, and every call is logged.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

const instrumentationFor = (bin: string) => `
process.env.MURAGE_EXTRA_PATH = ${JSON.stringify(bin)};
` + String.raw`
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({load(url,context,next){
 if(!url.endsWith('/podman-machine.ts'))return next(url,context);
 let source=readFileSync(new URL(url),'utf8');
 const pin='platform = process.platform, now = Date.now';
 if(!source.includes(pin))throw new Error('podman platform anchor moved');
 source=source.replace(pin,'platform = "darwin", now = Date.now');
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;

it("a turn for a Local VM bot starts a stopped Podman machine before it looks for the runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "podman-turn-"));
  const bin = join(dir, "bin"), log = join(dir, "podman.log"), started = join(dir, "started");
  mkdirSync(bin);
  writeFileSync(join(bin, "podman"), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "info "*) [ -f "${started}" ] || exit 1; echo '{}' ;;
  "machine list --format json") echo '[{"Name":"podman-machine-default","Default":true,"Running":false,"Starting":false}]' ;;
  "machine start "*) touch "${started}"; echo "Machine started successfully" ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(join(bin, "podman"), 0o755);
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentationFor(bin) });
  try {
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.ok, `${method} ${path} ${response.status}`).toBe(true);
      return response.json() as Promise<any>;
    };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).secret };
    const model = (await api("GET", "/api/instances", undefined, headers)).instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
    const bot = (await api("POST", "/api/bots", { name: "Local VM fixture", modelSelection: { instanceId: "verification", model } }, headers)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm", composio: false, browser: false }, headers);
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the computer", threadId: bot.threadId }, headers);
    const machineStarts = () => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((line) => line.startsWith("machine start "));
    await expect.poll(() => machineStarts(), { timeout: 30_000 }).toEqual(["machine start podman-machine-default"]);
  } finally { await fixture.close(); rmSync(dir, { recursive: true, force: true }); }
}, 90_000);
