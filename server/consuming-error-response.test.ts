// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP error containment owner: afix-new3-g2b. Consuming writer owner: sc-safety-rd.
import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";

// Fail between the captured binding and route dispatch, before a response
// facade exists. Only this isolated fixture's capability table is changed.
const instrumentationSource = `
  const fs = await import('node:fs'), path = await import('node:path');
  const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
  const { makeLedgerDriver } = await import(${JSON.stringify(new URL("./testing/fake-ledger-driver.ts", import.meta.url).href)});
  const { InternalCapabilities } = await import(${JSON.stringify(new URL("./internal-capabilities.ts", import.meta.url).href)});
  BUILT_IN_DRIVERS.push(makeLedgerDriver());
  const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.instances.ledger = { driver: 'fakeLedger', environment: {
    FAKE_LEDGER_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'ledger-boundaries') } };
  fs.writeFileSync(file, JSON.stringify(cfg));
  const fault = path.join(process.env.MURAGE_DATA_DIR, 'error-response-fault');
  const resolve = InternalCapabilities.prototype.resolve;
  InternalCapabilities.prototype.resolve = function(header) {
    const claim = resolve.call(this, header);
    if (claim && fs.existsSync(fault)) {
      const state = JSON.parse(fs.readFileSync(fault, 'utf8'));
      if (++state.calls === 2) {
        if (state.retire) this.revokeThread(claim.threadId);
        state.triggered = true;
        fs.writeFileSync(fault, JSON.stringify(state));
        throw new Error(state.message);
      }
      fs.writeFileSync(fault, JSON.stringify(state));
    }
    return claim;
  };
`;

it.each([
  { retire: true, message: "fixture dispatch failed", status: 409 },
  { retire: true, message: "COORDINATION_CAPACITY", status: 409 },
  { retire: true, message: "SQLITE_BUSY", status: 409 },
  { retire: false, message: "fixture dispatch failed", status: 500 },
])("contains an error-response refusal and keeps HTTP alive ($message, retired=$retire)", async ({ retire, message, status }) => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  try {
    const secret = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret, "content-type": "application/json" };
    const created = await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: desktop,
      body: JSON.stringify({ name: "Response fixture", modelSelection: { instanceId: "ledger", model: "ledger-1" } }) });
    expect(created.status).toBe(201);
    const { bot } = await created.json() as { bot: { id: string; threadId: string } };
    expect((await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: "POST", headers: desktop,
      body: JSON.stringify({ text: "Hold the response fixture" }) })).status).toBe(202);
    const dump = join(fixture.info.dataDir, "ledger-boundaries");
    await expect.poll(() => existsSync(dump) && readFileSync(dump, "utf8").includes('"token"'), { timeout: 20_000 }).toBe(true);
    const row = readFileSync(dump, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.token);
    const fault = join(fixture.info.dataDir, "error-response-fault");
    writeFileSync(fault, JSON.stringify({ calls: 0, retire, message }));
    const response = await fetch(`${fixture.info.url}/api/internal/agents`, { headers: { authorization: `Bearer ${row.token}` } });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(retire ? LEDGER_REFUSAL_LINE : JSON.stringify({ error: message }));
    expect(JSON.parse(readFileSync(fault, "utf8"))).toMatchObject({ calls: 2, triggered: true });
    // A complete next control request must succeed after the terminal response.
    const doctor = await runControlMurage(["doctor", "--url", fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
    expect(doctor).toMatchObject({ ok: true });
    expect((await fetch(`${fixture.info.url}/api/health`)).status).toBe(200);
  } finally { await fixture.close(); }
}, 45_000);
