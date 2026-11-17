// SPDX-License-Identifier: AGPL-3.0-or-later
// HTTP receipt owner: tri3-g2. Native terminal-delivery contract owner: tri3-g1.
// Keep the independent HTTP half of the MAIN R1 ruling at the shared boundary.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSse } from './testing/sse.ts';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import type { Message } from './store.ts';
type DisplayMessage = Omit<Message, 'card'> & { card?: Omit<NonNullable<Message['card']>, 'requestId'> & { requestHandle?: string; requestId?: never } };
const FAKE_CLI = fileURLToPath(new URL('./testing/fake-acp-cli.ts', import.meta.url));
it("the real approval API returns 503 and records terminal failed delivery without a retry or grant", async () => {
  // Patch only this isolated server child's fake-engine transport and config.
  const instrumentationSource = `
    // The server child does not inherit the Vitest worker's in-memory hook.
    // Use the same test-only seam so this transport fixture needs no shipped bwrap.
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const awaitFs = await import('node:fs');
    const cp = (await import('node:child_process')).default;
    const spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const child = spawn(command, args, options);
      if (!args?.includes(${JSON.stringify(FAKE_CLI)})) return child;
      const write = child.stdin.write.bind(child.stdin);
      let failures = 3;
      const fs = awaitFs;
      child.stdin.write = function(chunk, done) {
        // Only JSON-RPC lines are the peer's; on Windows the job launcher's own
        // start frame goes down the same stdin first and must pass untouched.
        let message;
        try { message = JSON.parse(String(chunk)); } catch { return write(chunk, done); }
        if (message.result?.outcome) fs.appendFileSync(process.env.MURAGE_DATA_DIR+'/outcome-writes.jsonl',JSON.stringify({phase:'attempt'})+'\\n');
        if (message.result?.outcome && failures-- > 0) {
          throw Object.assign(new Error('fixture write failure'), { code: 'EPIPE' });
        }
        if(message.result?.outcome?.outcome==='selected')fs.appendFileSync(process.env.MURAGE_DATA_DIR+'/outcome-writes.jsonl',JSON.stringify({phase:'grant'})+'\\n');
        return write(chunk, done);
      };
      return child;
    };
    (await import('node:module')).syncBuiltinESMExports();
    const { createAcpDriver } = await import(${JSON.stringify(new URL("./drivers/acp/core.ts", import.meta.url).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({
      driverKind: 'approvalDelivery108', displayName: 'Approval fixture', defaultCli: process.execPath,
      models: { default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] },
      nativeSource: 'approval-fixture.acp', loginNote: 'Fixture only',
      spawnArgs: () => ['--experimental-strip-types', ${JSON.stringify(FAKE_CLI)}],
      pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
      fluxReach: () => 'elsewhere'
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'config.json'), JSON.stringify({ instances: {
      approval: { driver: 'approvalDelivery108', environment: { FAKE_ACP_MODE: 'permission-edit-file' }, config: { cli: process.execPath, fullAuto: false } }
    }}));
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  const stream = await openSse(fixture.info.url + "/api/events");
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const post = (path: string, body: unknown) => fetch(fixture.info.url + path, { method: "POST", headers, body: JSON.stringify(body) });
    const created = await post("/api/bots", { name: "Approval fixture", modelSelection: { instanceId: "approval", model: "fixture" } });
    expect(created.ok).toBe(true);
    const { bot } = await created.json() as { bot: { id: string; threadId: string } };
    const patched = await fetch(fixture.info.url + `/api/bots/${bot.id}`, { method: "PATCH", headers, body: JSON.stringify({ autoApprove: false, autoReview: "off", computer: "off" }) });
    expect(patched.ok).toBe(true);
    await stream.until(frame => frame.kind === "hello");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Ask for fixture approval", threadId: bot.threadId })).ok).toBe(true);
    // A file edit, not a command: a command's card waits for the shell environment
    // check, and PowerShell in this fixture's bare environment outlasts both Windows
    // budgets (10 s + 30 s, against 0.5 s on a real one). Delivery is the same for both.
    const opened = await stream.until(frame => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.card?.requestHandle, 30_000).catch((error: unknown) => {
      // A runner failure must be readable from the job log alone: every frame
      // the stream carried, and the end of the fixture server's own log.
      console.error(`[approval fixture frames]\n${stream.frames.map(frame => JSON.stringify(frame).slice(0, 1500)).join("\n")}`);
      try { console.error(`[fixture server log, last 12000 bytes]\n${readFileSync(fixture.info.logPath, "utf8").slice(-12000)}`); } catch { /* no log yet */ }
      throw error;
    });
    // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 / 3ad2b8f428: use the actual public handle; keep the 503, terminal receipt, one-write and zero-grant proofs.
    expect(opened.message.card.requestId).toBeUndefined();
    const requestHandle = opened.message.card.requestHandle;
    const respond = () => post(`/api/threads/${bot.threadId}/respond`, { requestHandle, action: "allow" });
    const failed = await respond();
    expect(failed.status).toBe(503);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(await failed.json()).toMatchObject({ error: expect.stringMatching(/could not be delivered|delivery/i) });
    const messages = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: DisplayMessage[] };
    const pending = messages.messages.find(message => message.card?.requestHandle === requestHandle)?.card;
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Missing pending approval card");
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(pending.answered).toMatch(/could not be delivered/);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(pending.dismissed).toBe(true);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect((await respond()).ok).toBe(false);
    const delivered = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: DisplayMessage[] };
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(delivered.messages.find(message => message.card?.requestHandle === requestHandle)?.card?.answered).toMatch(/could not be delivered/);
    const outcomes = readFileSync(join(fixture.info.dataDir, "outcome-writes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(outcomes.filter(row => row.phase === "attempt")).toHaveLength(1);
    expect(outcomes.filter(row => row.phase === "grant")).toHaveLength(0);
  } finally {
    stream.close();
    await fixture.close();
  }
}, 60000);
