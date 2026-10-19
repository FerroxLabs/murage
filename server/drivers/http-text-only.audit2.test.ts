// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { clearUnseenExcess, unseenExcessCalls, withContinuityInferenceLease } from "../memory/extract.ts";
import { learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { httpTextOnlyTurn } from "./http-text-only.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";

// Astra L3 r2 High 2 / r3: a paid reply nobody could read keeps its full reservation (never a body-size surcharge) and counts as unmetered
// on the month row, so the ceiling bound holds without guessing its cost. Each case starts with no unmetered replies.
beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); clearUnseenExcess(database()); });
const monthRow = () => { const row = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(learningSpendLedgerId(learningSpendMonth())); return row ? JSON.parse(String(row.intent)) : undefined; };
const ledgerOf = (botId: string) => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE ?").get(`continuity-budget:${botId}:%`)!.intent));
async function leasedTurn(botId: string, fetchImpl: typeof fetch) {
  mkdirSync(DATA_DIR, { recursive: true });
  const signal = new AbortController().signal;
  const input: TextOnlyTurnInput = { system: "system", text: "fixture", model: "fixture", signal, outputSchema: { type: "object", required: ["ok"] }, maxOutputBytes: 12000, maxOutputTokens: 3000, context: { botId, runId: "r", family: "lived", attempt: 1 } };
  await withContinuityInferenceLease(lease => lease.request(async () => (await httpTextOnlyTurn(input, { baseUrl: "https://fixture.invalid", apiKey: "fixture", buildBody: model => ({ model }), fetchImpl })).text,
    "system", 3000, signal, [{ role: "user", content: "fixture" }], "continuity", { botId, family: "lived" }).catch(() => null));
}
it("unreadable-reply: a declared over-cap body settles its reservation and counts as unmetered", async () => {
  await leasedTurn("http-declared", async () => new Response("x".repeat(70_000), { headers: { "content-length": "70000" } }));
  expect(ledgerOf("http-declared").output).toBe(3000);
  expect(unseenExcessCalls(monthRow()).settled).toBe(1);
});
it("unreadable-reply: a streamed over-cap body settles its reservation and counts as unmetered", async () => {
  await leasedTurn("http-streamed", async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(70_000))); c.close(); } })));
  expect(ledgerOf("http-streamed").output).toBe(3000);
  expect(unseenExcessCalls(monthRow()).settled).toBe(1);
});
it("unreadable-reply: a body that is not JSON settles its reservation and counts as unmetered", async () => {
  const body = '{"choices":[{"message":{"content":"x"}}],"usage":{"prompt_tokens":9000,"completion_tokens":26';
  await leasedTurn("http-notjson", async () => new Response(body));
  expect(ledgerOf("http-notjson").output).toBe(3000);
  expect(unseenExcessCalls(monthRow()).settled).toBe(1);
});

it("15: rejected HTTP content without usage keeps its reservation and counts as unmetered", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const content = '{"wrong":1}', signal = new AbortController().signal;
  const input: TextOnlyTurnInput = { system: "system", text: "fixture", model: "fixture", signal, outputSchema: { type: "object", required: ["ok"] }, maxOutputBytes: 12000, maxOutputTokens: 3000, context: { botId: "http-estimate", runId: "r", family: "lived", attempt: 1 } };
  await withContinuityInferenceLease(lease => lease.request(async () => {
    const result = await httpTextOnlyTurn(input, { baseUrl: "https://fixture.invalid", apiKey: "fixture", buildBody: model => ({ model }), fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] })) });
    expect(result.verdict.state).toBe("refused"); return result.text;
  }, "system", 3000, signal, [{ role: "user", content: "fixture" }], "continuity", { botId: "http-estimate", family: "lived" }));
  const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'continuity-budget:http-estimate:%'").get()!.intent));
  expect(ledger.output).toBe(3000);
  expect(unseenExcessCalls(monthRow()).settled).toBe(1);
});
