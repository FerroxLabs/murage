// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FLUX-BURN-COPY-1018: Flux's hourly spend gate (the hourly burn check) answers 429 with
// detail {"error":"hourly_burn_limit", ..., "retry_after": <seconds>}. Fuigo relays it as ACP -32003 with the sentence
// "API error (status 429 Too Many Requests): None: hourly_burn_limit". It is read as its own Flux code: never resent, one card
// that says the Flux hourly limit is reached, and the reset time only when the body carries retry_after.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fluxHourlyResetsAt, fluxRefusalCode, fluxRefusalFinal, FLUX_REFUSAL_CODES } from "./flux-refusal.ts";
import { gatewayBusy, gatewayBusyFacts, LimitTurns, type LimitTurn } from "./limit-continuation.ts";
import { classifyError } from "./drivers/retry.ts";

const NOW = 1_800_000_000_000;
// The recorded Fuigo 1.0.37 relay: JSON-RPC error -32003, error_kind rate_limited, the code only in the sentence.
const RPC_32003 = { code: -32003, message: "API error (status 429 Too Many Requests): None: hourly_burn_limit", data: { error_kind: "rate_limited" } };
// The Flux service's HTTPException detail, as the Flux key route receives the raw body.
const DETAIL = { detail: { error: "hourly_burn_limit", subscription_tier: "pro", spent_usd_last_hour: 12.5, inflight_usd: 0.2, threshold_usd: 12, retry_after: 1800 } };
// LiteLLM flattens the same dict into error.message as a Python repr.
const REPR = "{'error': 'hourly_burn_limit', 'subscription_tier': 'pro', 'spent_usd_last_hour': 12.5, 'inflight_usd': 0.2, 'threshold_usd': 12, 'retry_after': 1800}";

describe("hourly_burn_limit is its own Flux code", () => {
  it("is read from the -32003 sentence, the raw body, the repr and a structural flux_code, and is final", () => {
    expect(FLUX_REFUSAL_CODES.has("hourly_burn_limit")).toBe(true);
    expect(fluxRefusalCode(RPC_32003.message, RPC_32003.data)).toBe("hourly_burn_limit");
    expect(fluxRefusalCode(JSON.stringify(DETAIL))).toBe("hourly_burn_limit");
    expect(fluxRefusalCode({ error: { message: REPR, type: "None", code: "429" } })).toBe("hourly_burn_limit");
    expect(fluxRefusalCode({ flux_code: "hourly_burn_limit" })).toBe("hourly_burn_limit");
    expect(fluxRefusalFinal("hourly_burn_limit")).toBe(true);
  });
  it("a spent allowance and a credit code still win; the hourly code wins over a hold", () => {
    expect(fluxRefusalCode("hourly_burn_limit", "free_cap_reached")).toBe("free_cap_reached");
    expect(fluxRefusalCode("hourly_burn_limit", "credit_exhausted")).toBe("credit_exhausted");
    expect(fluxRefusalCode("hourly_burn_limit", { "x-flux-hold-reason": "concurrency" })).toBe("hourly_burn_limit");
    expect(fluxRefusalCode("hourly burn limit")).toBeUndefined();
  });
  it("the HTTP retry layer never resends it", () => {
    const err = Object.assign(new Error("HTTP 429"), { data: { http_status: 429, message: REPR, flux_code: "hourly_burn_limit" } });
    expect(classifyError(err).transient).toBe(false);
  });
});

describe("the reset time comes only from the body", () => {
  it("retry_after seconds in the raw body, the repr or RPC data name the reset", () => {
    expect(fluxHourlyResetsAt(NOW, JSON.stringify(DETAIL))).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, { message: "API error", data: DETAIL })).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, Object.assign(new Error("HTTP 429"), { data: { body: JSON.stringify({ error: { message: REPR } }) } }))).toBe(NOW + 1_800_000);
  });
  it("no retry_after, or one outside a sane window, names no time", () => {
    expect(fluxHourlyResetsAt(NOW, RPC_32003.message, RPC_32003.data)).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: 0 })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: 999_999 })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "'retry_after': -5")).toBeUndefined();
  });
});

const fuigo = { driverKind: "fuigoAgent", viaGateway: false };
const turnOf = (): LimitTurn => ({ botId: "b", threadId: "t", selection: { instanceId: "f", model: "m" }, engineName: "Fuigo", driverKind: "fuigoAgent", viaGateway: false,
  sendIds: ["s"], sourceMessageId: "m", sourceText: "hi", ownerDirect: true, routine: false, onFailover: false, activity: false });

describe("one hourly card, with its reset when Flux sent one", () => {
  it("the code, or the code word in the text, is the hourly card, with or without a reset time", () => {
    expect(gatewayBusy({ ...fuigo, errorText: "Fuigo could not finish this turn.", gatewayCode: "hourly_burn_limit" }, { resetsAt: null })).toBe("hourly");
    expect(gatewayBusy({ ...fuigo, errorText: RPC_32003.message }, { resetsAt: null })).toBe("hourly");
    expect(gatewayBusy({ ...fuigo, errorText: RPC_32003.message }, { resetsAt: NOW + 60_000 })).toBe("hourly");
    expect(gatewayBusy({ driverKind: "claudeAgent", viaGateway: false, errorText: RPC_32003.message, gatewayCode: "hourly_burn_limit" }, { resetsAt: null })).toBeNull();
  });
  it("the runtime error's reset travels to the card's facts; any other reason carries none", () => {
    const turns = new LimitTurns();
    turns.begin(turnOf());
    turns.observe({ type: "turn.started", threadId: "t", turnId: "p1" });
    turns.observe({ type: "runtime.error", threadId: "t", turnId: "p1", message: "Fuigo could not finish this turn.", gatewayCode: "hourly_burn_limit", gatewayResetsAt: NOW + 1_800_000 });
    const turn = turns.get("t")!;
    expect(gatewayBusyFacts(turn, "hourly")).toEqual({ engine: "Fuigo", reason: "hourly", resetsAt: NOW + 1_800_000 });
    expect(gatewayBusyFacts(turn, "busy")).toEqual({ engine: "Fuigo", reason: "busy" });
    turns.observe({ type: "runtime.error", threadId: "t", turnId: "p1", message: "again", gatewayCode: "hourly_burn_limit" });
    expect(gatewayBusyFacts(turns.get("t")!, "hourly")).toEqual({ engine: "Fuigo", reason: "hourly" });
    turns.observe({ type: "runtime.error", threadId: "t", turnId: "p1", message: "x", gatewayCode: "hourly_burn_limit", gatewayResetsAt: Number.NaN });
    expect(gatewayBusyFacts(turns.get("t")!, "hourly")).toEqual({ engine: "Fuigo", reason: "hourly" });
  });
});

describe("the reset time is read from the body only (Astra FB14)", () => {
  it("never from a header object, a prose sentence or a bare key=value", () => {
    expect(fluxHourlyResetsAt(NOW, { headers: { retry_after: "60" }, error: "hourly_burn_limit" })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { error: "hourly_burn_limit", response: { Headers: { retry_after: 60 } } })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "hourly_burn_limit; retry_after=60")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "Flux said hourly_burn_limit and retry_after: 60")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"headers\": {\"retry_after\": 60}, \"error\": \"hourly_burn_limit\"}")).toBeUndefined();
  });
  it("still from the body: a property, a JSON text, a repr text", () => {
    expect(fluxHourlyResetsAt(NOW, DETAIL)).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, JSON.stringify(DETAIL))).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, REPR)).toBe(NOW + 1_800_000);
  });
  it("the whole number must be a time: an exponent or trailing characters are refused", () => {
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"retry_after\":1e9}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"retry_after\":1e3}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"retry_after\":60x}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"retry_after\":60.5}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: "1e9" })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: 7201 })).toBeUndefined();
  });
});

describe("a final hourly rejection keeps the reset an earlier retry notice named (Astra FB14)", () => {
  it("keeps it when the rejection names none, takes the new one when it names one, never invents one for another code", async () => {
    const { fluxRefusalFieldsKeeping } = await import("./flux-refusal.ts");
    const saved = { code: "hourly_burn_limit" as const, resetsAt: NOW + 600_000 };
    expect(fluxRefusalFieldsKeeping("hourly_burn_limit", NOW, saved, "API error (status 429 Too Many Requests): None: hourly_burn_limit")).toEqual({ gatewayCode: "hourly_burn_limit", gatewayResetsAt: NOW + 600_000 });
    expect(fluxRefusalFieldsKeeping("hourly_burn_limit", NOW, saved, REPR)).toEqual({ gatewayCode: "hourly_burn_limit", gatewayResetsAt: NOW + 1_800_000 });
    expect(fluxRefusalFieldsKeeping("credit_exhausted", NOW, saved, "credit_exhausted")).toEqual({ gatewayCode: "credit_exhausted" });
    expect(fluxRefusalFieldsKeeping("hourly_burn_limit", NOW, undefined, "hourly_burn_limit")).toEqual({ gatewayCode: "hourly_burn_limit" });
  });
});

// Design r16 (Astra FB14b): retry_after only from a whole body document, at its top level or under detail/error/data/body, or
// LiteLLM's error.message repr string. R1..R20 each gave a reset before r16.
const NEST40 = `${"{\"detail\":".repeat(40)}{"retry_after":60}${"}".repeat(40)}`;
describe("red r16: no reset from prose, a partial document, arrays, other keys or malformed text (Astra FB14b)", () => {
  it("R1-R6 a string must be one whole object document", () => {
    expect(fluxHourlyResetsAt(NOW, "hourly_burn_limit {} 'retry_after': 60 {}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"message\":\"wait 'retry_after': 60\"}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":\"hourly_burn_limit\",\"note\":\"{'retry_after': 60}\"}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "[{\"retry_after\":60}]")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "hourly_burn_limit; example {\"retry_after\":60}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":60} trailing")).toBeUndefined();
  });
  it("R7-R10 message is read only as a whole document string directly under error", () => {
    expect(fluxHourlyResetsAt(NOW, { error: "hourly_burn_limit", message: "Example: {'retry_after':60}" })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { message: { retry_after: 60 } })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { error: { message: { retry_after: 60 } } })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { data: { message: "{'retry_after': 60}" } })).toBeUndefined();
  });
  it("R11-R16 arrays and keys other than the wrappers are never read", () => {
    expect(fluxHourlyResetsAt(NOW, { error: "hourly_burn_limit", diagnostics: [{ retry_after: 60 }] })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, JSON.stringify({ error: "hourly_burn_limit", diagnostics: [{ retry_after: 60 }] }))).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { meta: { retry_after: 60 } })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, [{ retry_after: 60 }])).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { error: [{ retry_after: 60 }] })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":{\"items\":[{\"retry_after\":60}]}}")).toBeUndefined();
  });
  it("R17-R20 a duplicate key, a trailing comma, a bad escape or nesting past the limit fails the document", () => {
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":60,\"retry_after\":60}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":60,}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"x\":\"\\q\",\"retry_after\":60}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, NEST40)).toBeUndefined();
  });
});

describe("controls r16: the recorded shapes still name the reset", () => {
  it("prefixed and wrapped reprs and JSON texts", () => {
    expect(fluxHourlyResetsAt(NOW, `429 Too Many Requests: ${REPR}`)).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, { error: { message: REPR } })).toBe(NOW + 1_800_000);
    expect(fluxHourlyResetsAt(NOW, "{'error': 'hourly_burn_limit', 'message': \"Your account's hourly spend is reached\", 'tier': None, 'retry_after': 900}")).toBe(NOW + 900_000);
    expect(fluxHourlyResetsAt(NOW, { data: { body: { detail: { retry_after: 120 } } } })).toBe(NOW + 120_000);
    expect(fluxHourlyResetsAt(NOW, "{\"detail\":{\"error\":\"hourly_burn_limit\",\"note\":\"caf\\u00e9\\nline\",\"retry_after\":300}}")).toBe(NOW + 300_000);
    expect(fluxHourlyResetsAt(NOW, `API error (status 429 Too Many Requests): None: ${JSON.stringify(DETAIL)}`)).toBe(NOW + 1_800_000);
  });
  it("boundaries: wrapper depth, 1 and 7200 seconds, text length", () => {
    const nest = (levels: number) => { let value: unknown = { retry_after: 60 }; for (let i = 0; i < levels; i++) value = { detail: value }; return value; };
    expect(fluxHourlyResetsAt(NOW, nest(4))).toBe(NOW + 60_000);
    expect(fluxHourlyResetsAt(NOW, nest(7))).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: 1 })).toBe(NOW + 1_000);
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":7200}")).toBe(NOW + 7_200_000);
  });
});

describe("red r16: a body text over the cap is refused, not cut and read (Astra FBD16b)", () => {
  it("R21 a 16 385 character text holding a readable value gives no reset", () => {
    const text = `{"retry_after":60}${" ".repeat(16_367)}`;
    expect(text.length).toBe(16_385);
    expect(fluxHourlyResetsAt(NOW, text)).toBeUndefined();
  });
});

describe("r16 escapes decode to their real characters (Astra FBC16)", () => {
  it("an escaped key is not retry_after, decoded duplicates fail, escaped whitespace inside a nested document still reads", () => {
    expect(fluxHourlyResetsAt(NOW, "{\"\\retry_after\":60}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"\\tretry_after\":60}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":60,\"\\r\":1,\"\\u000d\":2}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":60,\"\\n\":1,\"\\x0a\":2}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, "{\"error\":{\"message\":\"{'retry_after':\\n\\t60}\"}}")).toBe(NOW + 60_000);
    expect(fluxHourlyResetsAt(NOW, "{\"error\":{\"message\":\"{'note': '\\\\n', 'retry_after': 90}\"}}")).toBe(NOW + 90_000);
  });
});

describe("r16 plain values only (Astra FBC16b)", () => {
  it("a digit string with a trailing line break is not plain digits; a non-plain object carries no body", () => {
    expect(fluxHourlyResetsAt(NOW, "{\"retry_after\":\"60\\n\"}")).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: "60\n" })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { retry_after: "60\r\n" })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, Object.assign(new Date(0), { retry_after: 60 }))).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, { error: Object.assign(new Map(), { retry_after: 60 }) })).toBeUndefined();
    expect(fluxHourlyResetsAt(NOW, Object.assign(Object.create(null), { retry_after: 60 }))).toBe(NOW + 60_000);
  });
});

describe("the person's message is kept (MurageSite copy check: the card says so)", () => {
  it("the hourly card goes only on the turn's own error row; a person's message is never that row, so it stays as sent", async () => {
    const { isGatewayBusyRow } = await import("./limit-continuation.ts");
    const person = { role: "user", turnId: "p1", text: "Book a table for two at eight" };
    const reply = { role: "bot", turnId: "p1", text: "Looking now" };
    const errorRow = { role: "bot", turnId: "p1", tool: { name: "error: API error (status 429 Too Many Requests): None: hourly_burn_limit" } };
    const earlierTurn = { ...errorRow, turnId: "p0" };
    expect([errorRow, reply, person, earlierTurn].filter((message) => isGatewayBusyRow(message, "p1"))).toEqual([errorRow]);
    expect(isGatewayBusyRow(person, "p1")).toBe(false);
    expect(isGatewayBusyRow(person)).toBe(false);
    // even a person's row that quotes an error line is never patched into a card
    expect(isGatewayBusyRow({ role: "user", turnId: "p1", tool: { name: "error: hourly_burn_limit" } }, "p1")).toBe(false);
  });
});

describe("the server loads the refusal reader as plain Node", () => {
  // The server runs its .ts files under Node type stripping, which refuses parameter properties, enums and namespaces.
  it("imports flux-refusal.ts with Node type stripping and reads a refusal", () => {
    const code = "import(process.argv[1]).then(m => { process.stdout.write(String(m.fluxRefusalCode(\"API error (status 429 Too Many Requests): None: hourly_burn_limit\"))); })";
    const out = execFileSync(process.execPath, ["-e", code, new URL("./flux-refusal.ts", import.meta.url).href], { windowsHide: true, encoding: "utf8" });
    expect(out).toBe("hourly_burn_limit");
  });
});
