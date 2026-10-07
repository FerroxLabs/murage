// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { withContinuityInferenceLease } from "../memory/extract.ts";
import { httpTextOnlyTurn } from "./http-text-only.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";

it("15: rejected HTTP content without usage settles received bytes", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const content = '{"wrong":1}', signal = new AbortController().signal;
  const input: TextOnlyTurnInput = { system: "system", text: "fixture", model: "fixture", signal, outputSchema: { type: "object", required: ["ok"] }, maxOutputBytes: 12000, maxOutputTokens: 3000, context: { botId: "http-estimate", runId: "r", family: "lived", attempt: 1 } };
  await withContinuityInferenceLease(lease => lease.request(async () => {
    const result = await httpTextOnlyTurn(input, { baseUrl: "https://fixture.invalid", apiKey: "fixture", buildBody: model => ({ model }), fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] })) });
    expect(result.verdict.state).toBe("refused"); return result.text;
  }, "system", 3000, signal, [{ role: "user", content: "fixture" }], "continuity", { botId: "http-estimate", family: "lived" }));
  const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'continuity-budget:http-estimate:%'").get()!.intent));
  expect(ledger.output).toBe(Math.ceil(Buffer.byteLength(content) / 3.5));
});
