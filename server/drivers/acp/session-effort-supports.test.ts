// ACP-EFFORT-PER-MODEL-1023 X2 (L3): the unconfirmed-effort fallback over EVERY support whose modelVariants is true, collected at test time.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { commandCodeSupport } from "./command-code.ts";
import { copilotSupport } from "./copilot.ts";
import { customAcpSupport } from "./custom.ts";
import { deepseekSupport } from "./deepseek.ts";
import { devinSupport } from "./devin.ts";
import { kiroSupport } from "./kiro.ts";
import { ompSupport } from "./omp.ts";
import { openCodeAcpSupport } from "./opencode-go.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";

const ALL_SUPPORTS: readonly AcpSupport[] = [commandCodeSupport, copilotSupport, customAcpSupport, deepseekSupport, devinSupport, kiroSupport, ompSupport, openCodeAcpSupport(async () => ({ default: "glm-5.3", options: [] }) as never)];
// the support table at test time: every support in the table that opts into model variants
const variantSupports = (): AcpSupport[] => ALL_SUPPORTS.filter(support => support.modelVariants === true);

it("L3 the collected list is every engine source that sets modelVariants: true (never a hard-coded three)", () => {
  const dir = resolve("server/drivers/acp");
  const declared = readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter(name => /^\s*modelVariants: true,/m.test(readFileSync(join(dir, name), "utf8")) || /,\s*modelVariants: true,/.test(readFileSync(join(dir, name), "utf8")))
    .filter(name => name !== "core.ts").sort();
  expect(variantSupports().map(support => support.driverKind).sort()).toHaveLength(declared.length);
  expect(declared).toEqual(["command-code.ts", "copilot.ts", "custom.ts", "deepseek.ts", "devin.ts", "kiro.ts", "omp.ts", "opencode-go.ts"]);
  expect(variantSupports().map(support => support.driverKind).sort()).toEqual(["commandCodeAgent", "copilotAgent", "customAcp", "deepseekAgent", "devinAgent", "kiroAgent", "ompAgent", "opencodeGo"]);
});

it.each(variantSupports().map(support => [support.driverKind, support] as const))(
  "X2 %s: an answer that lacks the level runs the turn on a fresh session at the default, one line, no refusal",
  async (_kind, support) => {
    const home = mkdtempSync(join(tmpdir(), "murage-effort-support-"));
    // the support's own model-variant opt-in drives the core; only its launch wiring is replaced by the scripted engine
    const driver = createAcpDriver({ ...support, defaultCli: "", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
      resumeMethod: undefined, selectModel: { configId: "model" }, configureSession: undefined, effectiveDestination: undefined, resolveTurnModel: undefined, resolveModels: undefined, resolveModelsOnCreate: false,
      fluxReach: () => "elsewhere" as const, models: { default: "glm-5.3", options: [{ id: "glm-5.3", label: "Fixture" }] } });
    const instance = await driver.create({ instanceId: "support-fixture", displayName: "Fixture", enabled: true,
      environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_NO_CONFIRM: "1" },
      config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    const rows = (): Array<Record<string, any>> => readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const map = new Map<string, "clean" | "pending" | "set">();
    const effortTouch = { get: (id: string) => map.get(id), set: (id: string, state: "clean" | "pending" | "set") => { map.set(id, state); return true; } };
    try {
      const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "support", text: "ACP_PICKER_ONE", model: "glm-5.3", effortTouch });
      expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === first.turnId)).toMatchObject({ ok: true });
      const S = rows().find(r => r.method === "session/prompt")!.sessionId;
      const before = rows().length;
      const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "support", text: "ACP_PICKER_TWO", model: "glm-5.3", variant: "max", resumeCursor: S, effortTouch });
      expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === second.turnId), JSON.stringify(recorder.events.filter(e => e.type === "runtime.error"))).toMatchObject({ ok: true });
      const mine = rows().slice(before);
      expect(mine.filter(r => r.method === "session/new")).toHaveLength(1);
      expect(mine.filter(r => r.method === "session/prompt").at(-1)!.sessionId).not.toBe(S);
      expect(JSON.stringify(recorder.events.filter(e => "turnId" in e && e.turnId === second.turnId))).toContain("could not confirm effort max");
      expect(instance.adapter.capabilities.effortMode).toBe("model");
    } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
  });
