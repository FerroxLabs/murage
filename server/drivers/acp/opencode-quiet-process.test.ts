import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { recordEvents } from "../../testing/events.ts";

it("diagnoses the owned process before its unchanged silence deadline terminates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quiet-process-"));
  const dump = join(root, "dump.json");
  vi.stubEnv("MURAGE_ACP_PROMPT_IDLE_MS", "65000");
  const driver = createOpenCodeDriver(async () => ({ default: "fixture/mock", options: [{ id: "fixture/mock", label: "Mock" }] }));
  const instance = await driver.create({ instanceId: "quiet-process", displayName: undefined, enabled: true, environment: {
    HOME: root, OPENCODE_API_KEY: "local-fixture-only", FAKE_ACP_MODE: "opencode-quiet", FAKE_ACP_MODELS: "fixture/mock", FAKE_ACP_PID_FILE: dump,
  }, config: { cli: fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "quiet-thread", text: "offline", model: "fixture/mock", cwd: root });
    const started = Date.now();
    expect(await recorder.until(e => e.type === "turn.diagnostic" || e.type === "runtime.error", 70000)).toMatchObject({ category: "rate_limit" });
    expect(await recorder.until(e => e.type === "turn.completed", 15000)).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(75000);
    expect(recorder.events.filter(e => e.type === "turn.diagnostic")).toHaveLength(1);
    const pid = Number(await readFile(dump, "utf8"));
    await instance.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { recorder.stop(); await instance.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 85000);
