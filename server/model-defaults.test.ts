import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { turnCapabilityFacts } from "./capabilities-primer.ts";
import { nativeTurnModel, defaultModel } from "./default-engine.ts";
import { memberTurnSelection } from "./member-turn.ts";
import { staleModelReplacement } from "./stale-engine-model.ts";
import { STATIC_CLAUDE_MODELS } from "./drivers/claude.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";

beforeEach(() => removeTempDirSync(DATA_DIR));
for (const [kind, models, previous, next] of [
  ["claudeAgent", STATIC_CLAUDE_MODELS, "claude-sonnet-5", "claude-sonnet-5-5"],
  ["codex", STATIC_CODEX_MODELS, "gpt-5.6-sol", "gpt-6.1-sol"],
] as const) {
  describe(`${kind} model defaults`, () => {
    it.each([previous, "unknown-saved-model"])("preserves saved %s across restart and turn selection", saved => {
      const choice = { instanceId: kind, model: saved };
      const store = new Store(() => choice);
      const bot = store.createBot();
      const restarted = new Store(() => ({ instanceId: kind, model: defaultModel({ models }) }));
      expect(restarted.bot(bot.id)?.modelSelection).toEqual(choice);
      expect(memberTurnSelection(restarted.bot(bot.id)!.modelSelection).model).toBe(saved);
      expect(staleModelReplacement(kind, saved, { ...models, source: "live" })).toBeNull();
    });
    it("resolves a persisted blank on restart without rewriting the saved choice", () => {
      const choice = { instanceId: kind, model: "" };
      const store = new Store(() => choice);
      const bot = store.createBot();
      const restarted = new Store(() => ({ instanceId: kind, model: defaultModel({ models }) }));
      const saved = restarted.bot(bot.id)!.modelSelection;
      expect(nativeTurnModel({ driverKind: kind, models }, saved.model)).toBe(next);
      expect(nativeTurnModel({ driverKind: kind, models }, undefined)).toBe(next);
      expect(nativeTurnModel({ driverKind: kind, models }, previous)).toBe(previous);
      expect(nativeTurnModel({ driverKind: kind, models }, "unknown-saved-model")).toBe("unknown-saved-model");
      expect(restarted.bot(bot.id)!.modelSelection).toEqual(choice);
    });
    it("describes the selected model in self-knowledge, and the default only when absent", () => {
      const instance = { driverKind: kind, models, adapter: { capabilities: {} } };
      const facts = (model?: string) => turnCapabilityFacts({ instance, model, integrations: {}, peers: 0, memory: "off", imageProvider: false, canAskOwner: true });
      expect(facts().model).toBe(models.options.find(option => option.id === next)?.label);
      expect(facts(previous).model).toBe(models.options.find(option => option.id === previous)?.label);
      expect(facts("unknown-saved-model").model).toBe("unknown-saved-model");
    });
    it("uses the new catalog default for a new bot with no saved choice", () => {
      const store = new Store(() => ({ instanceId: kind, model: defaultModel({ models }) }));
      expect(store.createBot().modelSelection).toEqual({ instanceId: kind, model: next });
    });
  });
}
