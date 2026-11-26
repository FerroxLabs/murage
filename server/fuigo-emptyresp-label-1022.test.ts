// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22: a Fuigo session/prompt failure with error kind empty_response is worded by Murage keyed on the kind field
// (never the message text), and an error that carries a kind never reads "could not show the reason".
// Owners: lane fuigo-emptyresp-label-1022 owns this test, owner-display.ts shownErrorReason/shownErrorDetails and
// engineKindReason (shared/provider-error.ts); the ACP driver (server/drivers/acp/core.ts) owns the errorKind field.
import { describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import * as providerError from "../shared/provider-error.ts";
const { ENGINE_ERROR_CATEGORIES } = providerError;
// read through the namespace so a build without the helper fails at the assertion below, not at call time
const engineKindReason = (kind: string): string | undefined => (providerError as { engineKindReason?: (kind: string) => string | undefined }).engineKindReason?.(kind);
import { EXPECTED_KIND_LINES } from "./testing/engine-kind-lines.ts";
import { ERROR_REASON_WITHHELD, routinePresentation, shownErrorDetails, shownErrorReason } from "./owner-display.ts";

const SECRET = "api_key=" + "FIXTURESECRET123456";
const LABEL = "The model thought it through but sent no reply. Try again or switch model.";
const ENGINE_TEXT = "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop";

function fakeInstance(instanceId: string) {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId, driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  return { instance: instance as unknown as ProviderInstance, emit: (event: RuntimeEvent, source?: SourceContext) => emitFn?.(event, source) };
}

/** A runtime.error that reaches the audience projection with no admitted turn: the message projects to the bare marker. */
function maskedError(fields: object) {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const delivered: RuntimeEvent[] = [];
  bus.subscribe(event => { delivered.push(event); }, { durable: false });
  const engine = fakeInstance("engine-b");
  bus.attach([engine.instance]);
  engine.emit({ provider: "fake", threadId: "t", createdAt: "t", eventId: "err-1", type: "runtime.error", ...fields } as RuntimeEvent, undefined);
  const execution = delivered.at(-1)! as RuntimeEvent & { message?: string; details?: string; errorKind?: string };
  const display = bus.audienceFor(execution).map(v => v.event).find(v => v.type === "runtime.error") as { message?: string; details?: string } | undefined;
  return { execution, display };
}

describe("empty_response label keyed on the error kind", () => {
  for (const [audience, ownerOnly] of [["shared", false], ["owner", true]] as const) {
    it(`${audience}: a masked reason with kind empty_response reads Murage's words, details name the kind`, () => {
      const { execution, display } = maskedError({ message: ENGINE_TEXT, details: `ACP request: session/prompt ${SECRET}`, errorKind: "empty_response" });
      expect(display?.message).toBe("«redacted»");
      expect(shownErrorReason(display?.message, ownerOnly ? `x ${SECRET}` : execution.message, ownerOnly, execution.errorKind)).toBe(LABEL);
      expect(shownErrorDetails(display?.details, execution.details, ownerOnly, "empty_response")).toBe("Engine error kind: empty_response");
    });
  }

  it("no kind keeps the withheld sentence; an unknown kind or a kind spelled in the message gets no label", () => {
    expect(shownErrorReason("«redacted»", "x", false)).toBe(ERROR_REASON_WITHHELD);
    expect(shownErrorReason("«redacted»", "x", false, "not_a_kind")).toBe(ERROR_REASON_WITHHELD);
    expect(shownErrorReason("«redacted»", "Engine error kind: empty_response", false)).toBe(ERROR_REASON_WITHHELD);
    expect(shownErrorDetails("«redacted»", "x", false, "not_a_kind")).toBeUndefined();
  });

  it("a readable reason is still the engine's own words (the label is only for a reason that cannot be shown)", () => {
    expect(shownErrorReason(ENGINE_TEXT, ENGINE_TEXT, true, "empty_response")).toBe(ENGINE_TEXT);
  });

  it("a routine run's error reads the label too", () => {
    const event = { type: "runtime.error", message: ENGINE_TEXT, errorKind: "empty_response" };
    const presented = routinePresentation(event, { ...event, message: "«redacted»" }, false);
    expect(presented.message).toBe(LABEL);
  });

  it("every recognized kind has its own plain line, word for word: no em dash, none is the withheld sentence, no two alike", () => {
    expect([...ENGINE_ERROR_CATEGORIES].sort()).toEqual(Object.keys(EXPECTED_KIND_LINES).sort());
    for (const kind of ENGINE_ERROR_CATEGORIES) {
      expect(engineKindReason(kind)).toBe(EXPECTED_KIND_LINES[kind]);
      expect(EXPECTED_KIND_LINES[kind]).not.toMatch(/—/);
      expect(EXPECTED_KIND_LINES[kind]).not.toBe(ERROR_REASON_WITHHELD);
    }
    expect(new Set(Object.values(EXPECTED_KIND_LINES)).size).toBe(ENGINE_ERROR_CATEGORIES.length);
    expect(engineKindReason("rate_limit")).toBe(EXPECTED_KIND_LINES.rate_limited);
  });
});
