// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Room cancellation consumer owner: r3-room-interrupt. Provider teardown owner: r3-room-interrupt (fixture adapter).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

it("releases an interrupted room handshake after a void Stop when its exact teardown is confirmed", async () => {
  const driver = fileURLToPath(new URL("./drivers/claude.ts", import.meta.url));
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const fs = await import('node:fs'), path = await import('node:path');
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const { ClaudeDriver } = await import(${JSON.stringify(driver)});
    const create = ClaudeDriver.create;
    ClaudeDriver.create = async function(input) {
      const instance = await create.call(this, input);
      if (input.instanceId !== 'verification') return instance;
      const adapter = instance.adapter, send = adapter.sendTurn.bind(adapter);
      const stop = adapter.interruptTurn.bind(adapter), observe = adapter.awaitTurnTeardown.bind(adapter);
      const file = name => path.join(process.env.MURAGE_DATA_DIR, name);
      const log = row => fs.appendFileSync(file('room-teardown.jsonl'), JSON.stringify(row) + '\\n');
      adapter.sendTurn = async turn => {
        const accepted = await send(turn);
        log({ accepted: true, threadId: turn.threadId, turnId: accepted.turnId });
        fs.writeFileSync(file('room-handshake-ready'), 'ready');
        while (!fs.existsSync(file('room-stop-requested'))) await new Promise(resolve => setTimeout(resolve, 10));
        return accepted;
      };
      adapter.interruptTurn = async (threadId, turnId) => {
        fs.writeFileSync(file('room-stop-requested'), 'stopped');
        await stop(threadId, turnId);
        // A legacy Stop requests termination; its separate observer owns proof.
      };
      adapter.awaitTurnTeardown = async (threadId, turnId) => {
        const receipt = await observe(threadId, turnId);
        log({ observed: true, threadId, turnId, closeConfirmed: receipt.closeConfirmed });
        return receipt;
      };
      return instance;
    };
  ` });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "verification");
    const created = await api("POST", "/api/bots", { name: "Room reader",
      modelSelection: { instanceId: "verification", model: instance.models.default } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const grouped = await api("POST", "/api/groups", { name: "Interrupted handshake", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(grouped.status).toBe(201);
    const room = grouped.body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Keep running until stopped" })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "room-handshake-ready")), { timeout: 20_000 }).toBe(true);
    expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const current = state.groups.find((entry: any) => entry.id === room.id);
      return { working: current?.working, busyBotId: current?.busyBotId,
        botBusy: state.bots.find((entry: any) => entry.id === bot.id)?.busy };
    }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, botBusy: false });
    const receipts = readFileSync(join(fixture.info.dataDir, "room-teardown.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const accepted = receipts.find(row => row.accepted);
    expect(receipts).toContainEqual({ observed: true, threadId: room.threadId, turnId: accepted.turnId, closeConfirmed: true });
    expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: "After Stop" })).status).toBe(201);
  } catch (error) {
    console.error(readFileSync(fixture.info.logPath, "utf8").slice(-8000));
    throw error;
  } finally {
    writeFileSync(join(fixture.info.dataDir, "room-stop-requested"), "cleanup");
    await fixture.close();
  }
}, 45_000);
