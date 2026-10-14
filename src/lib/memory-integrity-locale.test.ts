// SPDX-License-Identifier: AGPL-3.0-or-later
// lanes/upgui-review r3-8: the words of the strip follow the app's language even when nothing about the upgrade changed.
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ctx: null as unknown, slots: [] as Array<{ deps?: unknown[]; value?: unknown }>, at: 0 }));
vi.mock("react", async importOriginal => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => [h.ctx ?? init, () => undefined],
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const slot = (h.slots[h.at++] ??= {});
    if (!slot.deps || slot.deps.length !== deps.length || slot.deps.some((d, i) => !Object.is(d, deps[i]))) { slot.value = factory(); slot.deps = deps; }
    return slot.value;
  },
}));

import { setLocale } from "@/lib/i18n";
import { useMemoryDetail, useMemoryIntegrity } from "./memory-integrity-feed";
import { stripView } from "./memory-integrity-view";
import { sampleState } from "../../shared/upgrade-contract.mjs";
import { initialContext, reduce } from "../../shared/upgrade-machine.mjs";

const render = <T,>(hook: () => T): T => { h.at = 0; return hook(); };
afterEach(async () => { await setLocale("en"); h.slots = []; h.ctx = null; });

describe("translated views recompute on a language change", () => {
  it("r3-8: the same context renders in the new language", async () => {
    h.ctx = reduce(initialContext("app"), { type: "READING", at: 1, state: sampleState({ launch: "a".repeat(64), seq: 1, stage: "background", phase: "references", overall: 0.4, held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off", step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false } }) });
    const english = render(useMemoryIntegrity);
    expect(english?.text).toContain("set aside");
    expect(render(useMemoryDetail)?.text).toBe(english?.text);
    h.slots = [];
    await setLocale("de");
    const first = render(useMemoryIntegrity);
    expect(first?.text).toBe(stripView(h.ctx as never)?.text);
    expect(first?.text).not.toBe(english?.text);
    // the same hook instance (same slots) across a locale change
    h.slots = [];
    await setLocale("en");
    const before = render(useMemoryIntegrity);
    await setLocale("de");
    const after = render(useMemoryIntegrity);
    expect(before?.text).toBe(english?.text);
    expect(after?.text).toBe(first?.text);
  });
});
