import { describe, expect, it } from "vitest";
import { InternalCapabilities, type InternalCapabilityKind } from "./internal-capabilities.ts";

function mint(registry: InternalCapabilities, threadId = "thread", generation = "generation", kind: InternalCapabilityKind = "agents") {
  const token = registry.mint({ botId: "bot", threadId, generation, kind, depth: 0, skillAuthoring: false });
  return { token, claim: registry.resolve(`Bearer ${token}`)! };
}

describe("internal turn capabilities", () => {
  it("returns immutable exact claims and rejects malformed bearers and forged objects", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const { token, claim } = mint(registry);
    expect(Object.isFrozen(claim)).toBe(true);
    expect(registry.resolve(`Bearer ${token}`)).toBe(claim);
    expect(registry.isActive({ ...claim })).toBe(false);
    for (const header of [undefined, [token], token, `bearer ${token}`, `Bearer ${token} `, `Bearer ${"0".repeat(48)}`]) {
      expect(registry.resolve(header)).toBeNull();
    }
    expect(() => registry.mint({ ...claim, botId: "other" })).toThrow();
    expect(() => registry.mint({ ...claim, depth: -1 })).toThrow();
    expect(() => registry.mint({ ...claim, depth: 0.5 })).toThrow();
  });

  it("expires claims and pending reservations using its injected clock", () => {
    let now = 1;
    const registry = new InternalCapabilities({ now: () => now, orphanMs: 10 });
    registry.begin("bot", "thread", "generation");
    const { token, claim } = mint(registry);
    const reservation = registry.reserve(claim, "create")!;
    now = 11;
    expect(registry.isActive(claim)).toBe(false);
    expect(registry.resolve(`Bearer ${token}`)).toBeNull();
    expect(reservation.commit()).toBe(false);
  });

  it("refuses terminal-before-bind and distinguishes identical turn ids in different threads", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const first = mint(registry);
    registry.completeProviderTurn("other-thread", "provider-turn");
    expect(registry.bindProviderTurn("thread", "generation", "provider-turn")).toBe(true);
    expect(registry.isActive(first.claim)).toBe(true);
    registry.completeProviderTurn("thread", "provider-turn");
    expect(registry.isActive(first.claim)).toBe(false);
    registry.begin("bot", "thread", "next");
    const next = mint(registry, "thread", "next");
    registry.completeProviderTurn("thread", "fast-turn");
    expect(registry.bindProviderTurn("thread", "next", "fast-turn")).toBe(false);
    expect(registry.isActive(next.claim)).toBe(false);
  });

  it("old completion, binding and cleanup cannot revoke a replacement generation", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const old = mint(registry);
    registry.bindProviderTurn("thread", "generation", "old-turn");
    registry.begin("bot", "thread", "next");
    const next = mint(registry, "thread", "next");
    registry.completeProviderTurn("thread", "old-turn");
    registry.revokeGeneration("thread", "generation");
    expect(registry.bindProviderTurn("thread", "generation", "late-turn")).toBe(false);
    expect(registry.isActive(old.claim)).toBe(false);
    expect(registry.isActive(next.claim)).toBe(true);
  });

  // RED2I: the harness fold clears a thread's internal turn owner only when
  // its generation ended. A late terminal event of a stopped, unbound turn
  // must leave the replacement generation active — token minted or not.
  it("reports the active generation until its own bound provider turn completes", () => {
    const registry = new InternalCapabilities();
    expect(registry.activeGeneration("thread")).toBeUndefined();
    registry.begin("bot", "thread", "generation");
    registry.bindProviderTurn("thread", "generation", "refused-turn");
    registry.revokeGeneration("thread", "generation");
    registry.begin("bot", "thread", "next");
    // No token minted yet by "next"; the refused child's terminal event lands.
    registry.completeProviderTurn("thread", "refused-turn");
    expect(registry.activeGeneration("thread")).toBe("next");
    const next = mint(registry, "thread", "next");
    expect(registry.isActive(next.claim)).toBe(true);
    expect(registry.bindProviderTurn("thread", "next", "next-turn")).toBe(true);
    registry.completeProviderTurn("thread", "next-turn");
    expect(registry.activeGeneration("thread")).toBeUndefined();
    expect(registry.isActive(next.claim)).toBe(false);
  });

  it("bounds terminal tombstones", () => {
    const registry = new InternalCapabilities({ tombstoneLimit: 2 });
    for (const id of ["old", "middle", "new"]) registry.completeProviderTurn("thread", id);
    registry.begin("bot", "thread", "generation");
    expect(registry.bindProviderTurn("thread", "generation", "old")).toBe(true);
    expect(registry.bindProviderTurn("thread", "generation", "new")).toBe(false);
  });

  it("shares budgets across generation tokens and reserves concurrent admission atomically", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const a = mint(registry), b = mint(registry, "thread", "generation", "connectors");
    const slots = Array.from({ length: 4 }, () => registry.reserve(a.claim, "handoff")!);
    expect(registry.reserve(b.claim, "handoff")).toBeNull();
    slots[0]!.release(); slots[0]!.release();
    const replacement = registry.reserve(b.claim, "handoff")!;
    expect(replacement.commit()).toBe(true);
    expect(replacement.commit()).toBe(true);
    replacement.release();
    expect(registry.reserve(a.claim, "handoff")).toBeNull();
    expect(registry.reserve(a.claim, "create")).not.toBeNull();
    registry.revokeThread("thread");
    expect(slots[1]!.commit()).toBe(false);
    expect(registry.reserve(a.claim, "create")).toBeNull();
  });

  it("revokes every owned bot thread and all remaining owners", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    registry.begin("bot", "second", "generation");
    const first = mint(registry), second = mint(registry, "second");
    registry.revokeBot("bot");
    expect(registry.isActive(first.claim)).toBe(false);
    expect(registry.isActive(second.claim)).toBe(false);
    registry.begin("bot", "third", "generation");
    const third = mint(registry, "third");
    registry.revokeAll();
    expect(registry.isActive(third.claim)).toBe(false);
  });
});
