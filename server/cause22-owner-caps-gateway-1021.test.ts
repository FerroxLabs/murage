// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps (Sean STANDING, MAIN-RULING local-memory-budget: an owner turn is never stopped, refused or sealed by a size or
// memory cap). Owners: lane cause22-caps owns the owner-turn behaviour of the model gateway's caps (model-gateway.ts readLimited,
// the translator's event and collection bounds in model-gateway-translate.ts, the 64 MiB cut answered as one failed request, and the
// credential count in model-gateway-release.ts; CAPS-INVENTORY rows A19-A22, A24). The real handleModelGateway over a real loopback
// socket, the real release budget and upstream reader of a bound turn; only the provider is a stand-in (as model-gateway.test.ts).
// On c187b11166 an error body over 64 KiB, or one translated event over 1 MiB, refused the owner's turn.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSignIns } from "./model-signin.ts";
import { gatewayBaseUrl, handleModelGateway } from "./model-gateway.ts";
import { issueGatewayTurnCredential, revokeGatewayTurnCredentials } from "./model-gateway-release.ts";
import type { ProviderCatalog } from "../shared/provider-connections.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import type { LineageVerdict } from "./memory/lineage-types.ts";
import { BUDGET_VERDICT } from "./memory/release-budget.ts";

const MIB = 1024 * 1024;
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const entry = (over: Record<string, unknown> = {}) => ({ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "rev-1", state: "connected", accessToken: "fixture-plan-token", accountId: "acct-9", expiresAt: Date.now() + 3_600_000, ...over });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const answer = (text: string) => [{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text }] } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }];

/** The gateway on a loopback socket for ONE bound turn. `owner`: the turn's budget is bound with the owner keep (as index.ts binds it). */
async function gateway(owner: boolean, upstream: (n: number) => Response) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const verdicts: LineageVerdict[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  const signIns = new ModelSignIns({ env: {} });
  signIns.apply({ type: "murage:model-signin", entries: [entry(), entry({ provider: "supergrok", connectionId: "signin-grok", revision: "g1", accessToken: "fixture-grok-token", accountId: undefined })] });
  const catalog = (id: string): ProviderCatalog => ({ connectionId: id, stale: false, assurance: "catalog-only", models: [] }) as unknown as ProviderCatalog;
  let calls = 0;
  const fetchStub = (async () => upstream(++calls)) as unknown as typeof fetch;
  const server: Server = createServer((req, res) => { void handleModelGateway(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname, { signIns, catalog, fetch: fetchStub }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const keys = { chatgpt: issueGatewayTurnCredential("signin-chatgpt", fixture.binding), grok: issueGatewayTurnCredential("signin-grok", fixture.binding) };
  cleanups.push(async () => {
    revokeGatewayTurnCredentials(fixture.binding.identity.dispatchGeneration);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.close();
  });
  const port = (server.address() as { port: number }).port;
  const post = (provider: "chatgpt" | "grok", route: string, body: unknown) => fetch(`${gatewayBaseUrl(port, provider === "grok" ? "signin-grok" : "signin-chatgpt")}/${route}`,
    { method: "POST", headers: { authorization: `Bearer ${keys[provider]}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { fixture, verdicts, post };
}

it("G1 owner turn: a provider error body of 200 KiB fails that one request with the provider's status; the turn is not refused and its next request is answered", async () => {
  const g = await gateway(true, n => n === 1 ? new Response(JSON.stringify({ error: { message: "m".repeat(200 * 1024) } }), { status: 500, headers: { "content-type": "application/json" } })
    : sse(answer("after the error")));
  const failed = await g.post("grok", "responses", { model: "grok-fixture", input: "hi" });
  expect(failed.status, "the request fails with the provider's own status, not a refusal").toBe(500);
  expect((await failed.json() as { error: { message: string } }).error.message).toMatch(/^The xAI service answered 500/);
  expect(g.verdicts, "an oversize error body does not refuse the owner's turn").toEqual([]);
  expect(g.fixture.budget.refused).toBe(false);
  const next = await g.post("chatgpt", "responses", { model: "gpt-5.5", input: "hi" });
  expect(next.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next.json())).toContain("after the error");
}, 120_000);

it("G2 owner turn: one translated event of 3 MiB and a 12 MiB collected answer pass the translator's 1 MiB and 8 MiB bounds, streamed and not", async () => {
  const big = "b".repeat(3 * MIB);
  const events = [...Array.from({ length: 4 }, () => ({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: big }] } })),
    { type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } }];
  const g = await gateway(true, () => sse(events));
  const collected = await g.post("chatgpt", "responses", { model: "gpt-5.5", input: "hi" });
  expect(collected.status, "the collected 12 MiB answer is delivered").toBe(200);
  expect((await collected.text()).length, "every byte of it").toBeGreaterThan(12 * MIB);
  expect(g.verdicts, "a 3 MiB event does not refuse the owner's turn").toEqual([]);
  const streamed = await g.post("chatgpt", "chat/completions", { model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] });
  expect(streamed.status).toBe(200);
  const text = await streamed.text();
  expect(text.endsWith("data: [DONE]\n\n"), "the stream ends cleanly").toBe(true);
  expect(text).not.toContain("upstream_error");
  expect(g.verdicts).toEqual([]);
  expect(g.fixture.budget.refused).toBe(false);
}, 240_000);

it("G3 owner turn: no 64 MiB reader ceiling: one 40 MiB provider event is passed whole and nothing is cut; the turn is not refused and its next request is answered", async () => {
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: one 70 MiB event was
  // cut at the upstream reader's 64 MiB ceiling (502, the fixed line, oversized.cut 1). That ceiling is gone. The translator's own owner
  // bound in model-gateway.ts (64 MiB + 1 MiB per event) belongs to another lane, so this event stays under it.
  const big = 40 * MIB;
  const g = await gateway(true, n => n === 1 ? sse(answer("c".repeat(big))) : sse(answer("after the big one")));
  const whole = await g.post("chatgpt", "responses", { model: "gpt-5.5", input: "hi" });
  expect(whole.status, "the 40 MiB answer is delivered").toBe(200);
  expect((await whole.text()).length, "every byte of it").toBeGreaterThan(big);
  expect(g.verdicts, "not a refusal").toEqual([]);
  expect(g.fixture.budget.refused).toBe(false);
  expect(g.fixture.budget.oversized, "nothing is cut or marked on the turn's budget").toEqual({ event: 0, body: 0, cut: 0 });
  const next = await g.post("chatgpt", "responses", { model: "gpt-5.5", input: "hi" });
  expect(next.status, "the next request of the same turn is answered").toBe(200);
  expect(JSON.stringify(await next.json())).toContain("after the big one");
}, 240_000);

// MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29:39Z): "NO transport size or count caps at all", every turn. This row asserted
// that every other turn is refused at the gateway's 64 KiB error body; group C deleted that refusal (model-gateway.ts MAX_ERROR_BODY now
// keeps the first 64 KiB and drops the rest), so the error body half pins the ruling (Astra ffbc0af7af). The 3 MiB event half
// follows group D (memory/upstream-reader.ts event cap deleted): the release budget no longer refuses it.
it("G4 every other turn: a 200 KiB error body fails that request with the provider's status (no gateway cap, no refusal); a 3 MiB event is no longer refused by the release budget", async () => {
  const body = await gateway(false, () => new Response(JSON.stringify({ error: { message: "m".repeat(200 * 1024) } }), { status: 500, headers: { "content-type": "application/json" } }));
  const failed = await body.post("grok", "responses", { model: "grok-fixture", input: "hi" });
  expect(failed.status, "a non-owner turn gets the provider's own status for a 200 KiB error body, not a refusal").toBe(500);
  expect(body.verdicts, "a large error body does not refuse the turn").toEqual([]);
  const event = await gateway(false, () => sse(answer("b".repeat(3 * MIB))));
  const stopped = await event.post("chatgpt", "responses", { model: "gpt-5.5", input: "hi" });
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the upstream reader's
  // 1 MiB event cap refused this turn as checking:retained-budget (deleted by group D), and the translator's 1 MiB event bound refused it
  // next (group C's gateway no longer applies it). On the combined candidate the 3 MiB event is read whole and the turn answers.
  expect(stopped.status, "a 3 MiB event is read whole on every turn (no event cap)").toBe(200);
  expect(event.fixture.budget.refused, "the release budget did not refuse the 3 MiB event").toBe(false);
  expect(event.verdicts[0]).not.toEqual(BUDGET_VERDICT);
}, 120_000);

it("G5 a full credential table (4096) never refuses the owner's turn; it still refuses every other turn", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const verdicts: LineageVerdict[] = [];
  const live = consumingFixture(undefined, { botId: randomUUID() });
  const owner = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); }, continuePending: () => true });
  const other = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { verdicts.push(verdict); } });
  cleanups.push(() => { for (const f of [live, owner, other]) { revokeGatewayTurnCredentials(f.binding.identity.dispatchGeneration); f.close(); } });
  for (let n = 0; n < 4096; n++) issueGatewayTurnCredential("signin-grok", live.binding);
  const issue = (binding: typeof owner.binding) => { try { return issueGatewayTurnCredential("signin-grok", binding); } catch (error) { return `refused: ${(error as Error).message}`; } };
  // the table is full of live credentials
  expect(issue(owner.binding), "the owner's turn is issued its credential regardless").toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(verdicts, "no count refuses the owner's turn").toEqual([]);
  expect(issue(other.binding), "every other turn is still refused at 4096").toBe("refused: MEMORY_CONTEXT_REVOKED");
  expect(verdicts).toEqual([BUDGET_VERDICT]);
}, 120_000);
