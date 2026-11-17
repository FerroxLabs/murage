import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createConsumingIngress, createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { registerConsumingDescriptor } from "../consuming-turn-response.ts";

describe("S1 generation retirement", () => {
  it("T-H1-RETIRE: success drops late frames; premature exit seals authority without a memory refusal", () => {
    const f = consumingFixture();
    try {
      const ingress = createConsumingIngress(f.binding, "retired");
      expect(ingress.retire).toBeTypeOf("function"); // red: base has no retirement
      const child = new EventEmitter(); ingress.supervise(child);
      ingress.retire(); child.emit("exit");
      expect(() => ingress.upstream(1)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(f.refusals).toBe(0);
      const live = createConsumingIngress(f.binding, "live");
      const early = new EventEmitter(); live.supervise(early); early.emit("exit");
      expect(live.sealed).toBe(true);
      expect(() => live.upstream(1)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(f.refusals).toBe(0);
    } finally { f.close(); }
  });
  it("T-H1-RETIRE-DISPOSE: seal and disposal after retirement do not refuse", () => {
    const f = consumingFixture();
    try {
      const caps = new InternalCapabilities();
      caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
      const authority = createProxyReleaseAuthority(caps);
      const instance = authority.register(f.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
      expect(instance.ingress.retire).toBeTypeOf("function"); // red: missing API
      instance.ingress.retire(); instance.ingress.seal(); instance.dispose();
      expect(f.refusals).toBe(0);
    } finally { f.close(); }
  });
  it("T-A3F-DISPOSE-RESIDUAL: late HTTP close/abort/timeout/error cannot refuse a disposed generation", () => {
    const f = consumingFixture();
    const next = consumingFixture(undefined, { threadId: "next" });
    try {
      const caps = new InternalCapabilities();
      caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
      const authority = createProxyReleaseAuthority(caps);
      const instance = authority.register(f.binding, registerConsumingDescriptor("proxy:custom:frame", "body"), () => []);
      const claim = caps.resolve(`Bearer ${instance.token}`)!;
      expect(claim).toBeTruthy();
      expect(instance.ingress.retire).toBeTypeOf("function"); // red: missing API; later callbacks also refused on base
      instance.ingress.retire(); instance.dispose();
      const http = new EventEmitter();
      for (const event of ["close", "aborted", "timeout", "error"]) {
        http.on(event, () => authority.seal(claim)); http.emit(event);
      }
      expect(() => authority.verdict(claim, {})).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(() => authority.reserveUpstream(claim, {})).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(instance.ingress.sealed).toBe(false);
      expect(f.refusals).toBe(0); expect(next.refusals).toBe(0);
      const fresh = createConsumingIngress(next.binding, "next");
      let sent = false;
      fresh.request('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', () => { sent = true; });
      expect(sent).toBe(true); fresh.retire();
    } finally { f.close(); next.close(); }
  });
});
