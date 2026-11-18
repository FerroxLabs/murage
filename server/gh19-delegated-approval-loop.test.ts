// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GH-19: a Chief routine delegates to Macro's persistent conversation. Allow
// must not produce the same approval again without execution. The report does
// not include native RPC IDs or command text: this pins the answered-RPC replay
// case, not a claim that the reporter's engine sent this exact protocol trace.
// The report also showed missing=agents. A mounted turn whose mount reports an
// error now ends before any prompt (no card to loop on), so the replay runs with
// every mount ready and a third delegation pins the missing=agents outcome.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { openSse } from "./testing/sse.ts";
import type { Message } from "./store.ts";
// Windows carry the card's public handle, never its native request id.
type DisplayMessage = Omit<Message, "card"> & { card?: Omit<NonNullable<Message["card"]>, "requestId"> & { requestHandle?: string; requestId?: never } };
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";

const fakeCli = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
const command = "echo briefing && echo macro";

it("GH-19: Allow on a delegated Macro card never reopens an answered native request, including the next routine on the same thread", async () => {
  const instrumentationSource = `
    process.env.NODE_ENV = 'test';
    process.env.MURAGE_MCP_RECOVERY_MS = '100';
    process.env.MURAGE_MCP_RECONNECT_WAIT_MS = '100';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const { createAcpDriver } = await import(${JSON.stringify(new URL("./drivers/acp/core.ts", import.meta.url).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({
      driverKind: 'gh19Fixture', displayName: 'Macro fixture', defaultCli: process.execPath,
      models: { default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] },
      nativeSource: 'gh19-fixture.acp', loginNote: 'Fixture only',
      mcpListMethod: '_fuigo/mcp/list',
      spawnArgs: () => ['--experimental-strip-types', ${JSON.stringify(fakeCli)}],
      pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
      // A fixture engine that sends no model request: Flux Memory choices never apply.
      fluxReach: () => 'elsewhere'
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const configPath = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const macro = (mcpList) => ({
      driver: 'gh19Fixture',
      environment: { FAKE_ACP_MODE: 'permission', FAKE_ACP_PERMISSION_TWICE: 'replay', FAKE_ACP_MCP_LIST: mcpList,
        FAKE_ACP_PERMISSION_SESSION: '1', FAKE_ACP_PERMISSION_COMMAND: ${JSON.stringify(command)} },
      config: { cli: process.execPath, fullAuto: false }
    });
    config.instances.macro = macro('all:ready');
    config.instances.macroDown = macro(JSON.stringify({ agents: 'error' }));
    fs.writeFileSync(configPath, JSON.stringify(config));
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource, dumpLog: true });
  const stream = await openSse(fixture.info.url + "/api/events");
  try {
    const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const post = async (path: string, body: unknown, auth: Record<string, string> = headers, method = "POST") => {
      const response = await fetch(fixture.info.url + path, { method, headers: auth, body: JSON.stringify(body) });
      const value = await response.json() as any;
      expect(response.ok, JSON.stringify(value)).toBe(true);
      return value;
    };
    const { bot: chief } = await post("/api/bots", { name: "Chief of Staff", modelSelection: { instanceId: "verification", model: "fixture" } });
    const { bot: macro } = await post("/api/bots", { name: "Macro", modelSelection: { instanceId: "macro", model: "fixture" } });
    const { bot: macroDown } = await post("/api/bots", { name: "Macro Standby", modelSelection: { instanceId: "macroDown", model: "fixture" } });
    for (const bot of [macro, macroDown]) await post(`/api/bots/${bot.id}`, { autoApprove: false, autoReview: "off", computer: "off" }, headers, "PATCH");
    const { routine } = await post("/api/routines", {
      name: "Daily briefing", botId: chief.id, enabled: false,
      prompt: "GH19_CHIEF __fixture_hold_authority__", permissionMode: "ask", timeoutMinutes: 20,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() },
    });
    const seenHandles = new Set<string>();
    for (let run = 0; run < 3; run++) {
      const target = run < 2 ? macro : macroDown;
      const runStart = stream.frames.length;
      // A result can wake the Chief between runs. Give this run its own marker
      // so a wake that quotes the previous briefing cannot supply its token.
      const tag = `GH19_CHIEF_${run}`;
      await post(`/api/routines/${routine.id}`, { prompt: `${tag} __fixture_hold_authority__` }, headers, "PATCH");
      await post(`/api/routines/${routine.id}/run`, {});
      type ChiefTurn = { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } };
      const latestTurn = (): ChiefTurn | undefined => {
        let lines: string[] = [];
        try { lines = readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n"); } catch { /* starting */ }
        const line = lines.reverse().find(line => line.includes(tag));
        return line ? withTurnSecrets(JSON.parse(line) as ChiefTurn) : undefined;
      };
      let chiefTurn: ChiefTurn | undefined;
      let delegated: { status: number; body: { queued?: boolean; error?: string } } | undefined;
      for (const started = Date.now(); Date.now() - started < 40_000;) {
        chiefTurn = latestTurn();
        const env = Object.values(chiefTurn?.mcpConfig?.mcpServers ?? {}).map(server => server.env).find(env => env?.MURAGE_COMMS_TOKEN);
        if (env) {
          const response = await fetch(fixture.info.url + "/api/internal/delegate-bot", {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}` },
            body: JSON.stringify({ fromBotId: chief.id, fromThreadId: env.MURAGE_THREAD_ID, toBotId: target.id, message: "Prepare the daily macro briefing." }),
          });
          const body = await response.json() as { queued?: boolean; error?: string };
          // A policy redispatch can rotate the fixture token after its dump.
          // Only a definite auth refusal is retryable: never repeat an accepted
          // or ambiguous hand-off. Re-read the latest matching dump each time.
          if (response.status !== 401) { delegated = { status: response.status, body }; break; }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(delegated?.status, JSON.stringify(delegated)).toBe(200);
      expect(delegated?.body.queued).toBe(true);
      if (!chiefTurn) throw new Error("Chief fixture did not start");
      writeFileSync(join(fixture.fixtureFinishGateDir, String(chiefTurn.pid)), "finish");
      if (target === macroDown) {
        // missing=agents: the delegated turn ends visibly before its prompt, so no card can open or loop.
        const ended = await stream.until(frame => frame.kind === "runtime" && frame.event?.threadId === macroDown.threadId && frame.event.type === "turn.completed", 60_000);
        expect(ended.event.ok).toBe(false);
        const { messages } = await (await fetch(fixture.info.url + `/api/threads/${macroDown.threadId}/messages`, { headers })).json() as { messages: DisplayMessage[] };
        expect(messages.some(message => message.text === LEDGER_REFUSAL_LINE)).toBe(true);
        expect(messages.filter(message => message.card?.requestHandle)).toEqual([]);
        expect(stream.frames.some(frame => frame.kind === "runtime" && frame.event?.threadId === macroDown.threadId && frame.event.type === "request.opened")).toBe(false);
        continue;
      }
      // A window sees the card's public handle only; the runtime frame names the native request.
      const opened = await stream.until(frame => frame.kind === "message" && frame.threadId === macro.threadId &&
        frame.message?.card?.requestHandle && !seenHandles.has(frame.message.card.requestHandle), 60_000);
      expect(opened.message.card.requestId).toBeUndefined();
      const requestHandle = opened.message.card.requestHandle as string;
      seenHandles.add(requestHandle);
      // Window runtime frames carry neither the native request id nor the turn id:
      // this run's frames are the Macro frames after the run started, in stream order.
      const after = (from: number) => (frame: any) => stream.frames.indexOf(frame) > from && frame.kind === "runtime" && frame.event?.threadId === macro.threadId;
      const cardAt = stream.frames.indexOf(opened);
      const answered = await post(`/api/threads/${macro.threadId}/respond`, { requestHandle, action: "allow" });
      expect(answered.outcome).toBe("allowed-once");
      // Wait for an observable outcome, not a quiet-time guess: a reopened card
      // is the RED; a visible terminal failure is the report's safe alternative.
      const outcome = await stream.until(frame => after(cardAt)(frame) && (frame.event.type === "turn.completed" || frame.event.type === "request.opened"), 30_000);
      expect(outcome.event.type, "Allow must not lead straight back to the same approval card").toBe("turn.completed");
      expect(outcome.event).toMatchObject({ ok: false, stopReason: "approval_request_replayed" });
      expect(stream.frames.some(frame => after(cardAt)(frame) && frame.event.type === "runtime.error" && /already answered/.test(frame.event.message))).toBe(true);
      const { messages } = await (await fetch(fixture.info.url + `/api/threads/${macro.threadId}/messages`, { headers })).json() as { messages: DisplayMessage[] };
      const cards = messages.filter(message => message.card?.requestHandle === requestHandle);
      expect(cards).toHaveLength(1);
      expect(cards[0].card?.answered).toBe("allow");
      expect(messages.filter(message => message.card?.requestHandle && !message.card.answered && !message.card.dismissed)).toEqual([]);
      const runFrames = stream.frames.slice(runStart, stream.frames.indexOf(outcome) + 1).filter(after(-1));
      expect(runFrames.filter(frame => frame.event.type === "request.opened")).toHaveLength(1);
      expect(runFrames.filter(frame => frame.event.type === "request.resolved")).toEqual([expect.objectContaining({ event: expect.objectContaining({ behavior: "allow", source: "user" }) })]);
    }
  } catch (error) {
    // A runner failure must be readable from the job log alone.
    console.error(`[gh19 frames]\n${stream.frames.filter(frame => frame.kind === "runtime" || frame.message?.card).map(frame => JSON.stringify(frame).slice(0, 600)).join("\n")}`);
    console.error(readFileSync(fixture.info.logPath, "utf8").slice(-12000));
    throw error;
  } finally {
    stream.close();
    await fixture.close();
  }
}, 180_000);
