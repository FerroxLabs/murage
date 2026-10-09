// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

/** Uses the packaged supervisor and Electron executable; the bridge never opens a socket. */
export async function probeWhatsApp({ server, runtime, platform, arch, electronVersion, timeoutMs = 30_000, cleanupMs = 3_000, Host }) {
  if (!server || !runtime || !platform || !arch || !/^\d+\.\d+\.\d+$/.test(electronVersion ?? "")) throw Error("Pass --server-directory, --runtime, --platform, --arch and --electron-version from the packaged target");
  const root = mkdtempSync(join(tmpdir(), "murage-whatsapp-probe-"));
  let host, child, timer, exit, stopping;
  const stop = () => stopping ??= (async () => {
    let cleanup;
    try {
      await Promise.race([Promise.resolve().then(() => host?.stop()), new Promise((_, reject) => {
        cleanup = setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* the child may already be gone */ }
          reject(Error("Packaged WhatsApp cleanup timed out"));
        }, cleanupMs);
      })]);
    } finally { clearTimeout(cleanup); }
  })();
  try {
    const BridgeHost = Host ?? (await import(pathToFileURL(join(server, "channels/whatsapp/bridge-host.js")).href)).BridgeHost;
    const home = join(root, "home"); mkdirSync(home);
    let resolveProbe, rejectProbe;
    const ready = new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
    timer = setTimeout(() => rejectProbe(Error("Packaged WhatsApp handshake timed out")), timeoutMs);
    host = new BridgeHost({ connectionId: "probe", dataDir: join(root, "data"), mode: "self-chat", appVersion: "qualification", dryRun: true,
      getAuthKey: () => randomBytes(32).toString("hex"), script: join(server, "channels/whatsapp/bridge.js"),
      fork: (script, args, options) => {
        child = fork(script, args, { ...options, execPath: runtime });
        child.once("error", () => rejectProbe(Error("Packaged WhatsApp runtime could not spawn")));
        return child;
      },
      env: { HOME: home, USERPROFILE: home, TMPDIR: root, TEMP: root, TMP: root },
      onMessage: message => {
        if (message.kind === "fatal") rejectProbe(Error("Packaged WhatsApp bridge refused initialization"));
        if (message.kind !== "ready" || !message.baileysVersion) return;
        if (message.baileysVersion !== "7.0.0-rc14" || message.jimp !== true || message.platform !== platform || message.arch !== arch || message.electronVersion !== electronVersion) rejectProbe(Error("Packaged WhatsApp runtime mismatch"));
        else resolveProbe({ baileysVersion: message.baileysVersion, jimp: true, platform: message.platform, arch: message.arch, electronVersion: message.electronVersion });
      },
      onLifecycle: event => { if (event.kind === "exited") exit = event; if (["exited", "spawn-error", "handshake-timeout", "key-unavailable"].includes(event.kind)) rejectProbe(Error("Packaged WhatsApp bridge exited before qualification")); },
    });
    const report = await Promise.all([host.start(), ready]).then(([, report]) => report);
    clearTimeout(timer);
    await stop();
    if (!exit || exit.code !== 0 || exit.signal !== null) throw Error("Packaged WhatsApp bridge did not exit cleanly");
    return { ...report, runtime, server, socketFree: true, checkedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); await stop().catch(() => undefined); safeWipeSync(root); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  console.log(JSON.stringify(await probeWhatsApp({ server: option("--server-directory"), runtime: option("--runtime"), platform: option("--platform"), arch: option("--arch"), electronVersion: option("--electron-version") }), null, 2));
}
