// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

it("Signal settings actions return and log a permission cause through the real isolated server", async () => {
  // Replace only activation and the Signal service with a throwing fake; keep the production HTTP adapter and error mapper.
  const instrumentation = `
    const fs = await import('node:fs');
    const { registerHooks } = await import('node:module');
    registerHooks({ load(url, context, next) {
      if (!url.endsWith('/server/index.ts')) return next(url, context);
      let source = fs.readFileSync(new URL(url), 'utf8');
      const enabled = /function signalEnabled\\(\\) \\{[\\s\\S]*?\\n\\}/;
      if (!enabled.test(source)) throw Error('Signal activation anchor changed');
      source = source.replace(enabled, 'function signalEnabled() { return !isCloudHome(); }');
      const start = source.indexOf('if (signalParkVerdict.state === "held") signal = makeSignalHold();');
      const end = source.indexOf('\\nfunction whatsappSettings()', start);
      if (start < 0 || end < 0) throw Error('Signal service anchor changed');
      source = source.slice(0, start) + \`
        const fixtureFailure = async () => { throw Object.assign(new Error("private Signal fixture canary"), { code: "EPERM" }); };
        signal = { status: () => ({ state: "not-linked" }), disconnect: fixtureFailure, finishRevocation: fixtureFailure,
          fixPermissions: fixtureFailure, retryNotes: fixtureFailure, settle: fixtureFailure, stop: async () => {} };
      \` + source.slice(end);
      return { format: 'module-typescript', shortCircuit: true, source };
    } });
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation });
  console.log("Signal error fixture", JSON.stringify(fixture.info));
  try {
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const actions = ["disconnect", "finish-revocation", "fix-permissions", "retry-notes", "leave-it", "dismiss"];
    for (const action of actions) {
      const body = action === "leave-it" || action === "dismiss" ? { deliveryId: "a".repeat(64) } : {};
      const response = await fetch(`${fixture.info.url}/api/signal/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Murage does not have permission to change the Signal files on this computer." });
    }
    const log = readFileSync(fixture.info.logPath, "utf8");
    for (const action of actions) expect(log).toContain(`[signal] action failed: ${action} EPERM`);
    expect(log).not.toContain("private Signal fixture canary");
  } finally { await fixture.close(); }
}, 90_000);
