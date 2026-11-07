import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelSelection } from "./contracts.ts";
import type { ScanReading } from "./harness/registry.ts";
import { birthCandidate, nativeModel } from "./birth-reading.ts";
const models: ModelCatalog = { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "flux-auto", label: "Flux" }, { id: "custom", label: "Custom", custom: true }, { id: "provider", label: "Provider", provider: "other" }] };
const row = (instanceId: string, driverKind = "claudeAgent", billing: "subscription" | "metered" = "subscription") => ({ instanceId, driverKind, enabled: true, authenticated: true, billing });
function pick(rows = [row("claude")], paidOnly = true, source: ModelSelection | null = null, live = (_id: string) => ({ driverKind: "claudeAgent", models })) {
  return birthCandidate({ reading: { seq: 1, epoch: 1, rows }, paidOnly, source, live });
}
describe("ENGINE-DEFAULT native subscription birth", () => {
  it("R1 orders verified engines, then fleet rows, under A and B", () => {
    const rows = [row("codex", "codex"), row("claude", "claudeAgent", "metered")];
    expect(pick(rows)?.instanceId).toBe("codex");
    expect(pick(rows, false)?.instanceId).toBe("claude");
    expect(pick([row("codex", "codex"), row("second"), row("first")])?.instanceId).toBe("second");
  });
  it.each(["grokAgent", "kimi", "droid", "pi", "hermes", "openai-compat", "fuigoAgent"])("R2 excludes %s under both policies", driver => {
    for (const paid of [true, false]) expect(pick([row("other", driver)], paid)).toBeNull();
  });
  it("R3 excludes a signed-out engine even with stale billing", () => {
    expect(pick([{ ...row("codex", "codex"), authenticated: false }])).toBeNull();
  });
  it("R4 skips missing, disabled and non-native live instances", () => {
    for (const refused of [null, { driverKind: "claudeAgent", enabled: false, models }, { driverKind: "claudeAgent", models: { default: "", options: [] } }]) {
      expect(birthCandidate({ reading: { seq: 1, epoch: 1, rows: [row("bad"), row("good")] }, paidOnly: true, source: null, live: id => id === "bad" ? refused : { driverKind: "claudeAgent", models } })?.instanceId).toBe("good");
    }
  });
  it("R5 refuses Flux, custom and provider rows including defaults", () => {
    for (const id of ["flux-auto", "custom", "provider"]) expect(nativeModel({ ...models, default: id })).toBe("sonnet");
    expect(nativeModel({ default: "flux-auto", options: models.options.slice(2) })).toBe("");
  });
  it("R6 copies only a native Chief model without a connection override", () => {
    expect(pick(undefined, true, { instanceId: "claude", model: "opus" })?.model).toBe("opus");
    for (const source of [{ instanceId: "claude", model: "opus", connectionId: "x" }, ...["", "flux-auto", "custom", "provider"].map(model => ({ instanceId: "claude", model })), { instanceId: "other", model: "opus" }]) expect(pick(undefined, true, source)?.model).toBe("sonnet");
  });
  it("R7 null reading cannot consult a remembered winner", () => {
    expect(birthCandidate({ reading: null as ScanReading | null, paidOnly: true, source: null, live: () => { throw Error("must not read"); } })).toBeNull();
  });
});
