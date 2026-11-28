import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { mkdtemp, readFile } from "node:fs/promises";
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
  } finally { recorder.stop(); await instance.dispose(); vi.unstubAllEnvs(); await removeTempDir(root); }
}, 85000);

// W2(b) new pin: a reply chunk before 60 s cancels the pending line; the unchanged silence deadline still ends the turn.
it("a reply chunk before 60 s cancels the pending diagnostic for the earlier record", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quiet-progress-"));
  vi.stubEnv("MURAGE_ACP_PROMPT_IDLE_MS", "65000");
  const driver = createOpenCodeDriver(async () => ({ default: "fixture/mock", options: [{ id: "fixture/mock", label: "Mock" }] }));
  const instance = await driver.create({ instanceId: "quiet-progress", displayName: undefined, enabled: true, environment: {
    HOME: root, OPENCODE_API_KEY: "local-fixture-only", FAKE_ACP_MODE: "opencode-quiet-progress", FAKE_ACP_MODELS: "fixture/mock",
  }, config: { cli: fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "quiet-progress-thread", text: "offline", model: "fixture/mock", cwd: root });
    expect(await recorder.until(e => e.type === "turn.completed", 80000)).toMatchObject({ ok: false });
    expect(recorder.events.some(e => e.type === "content.delta")).toBe(true);
    expect(recorder.events.filter(e => e.type === "turn.diagnostic")).toEqual([]);
  } finally { recorder.stop(); await instance.dispose(); vi.unstubAllEnvs(); await removeTempDir(root); }
}, 90000);

// W9(b): an OpenCode exit before the prompt result names the captured category in plain words on the error card.
it("an exit before the result shows the category label, never the internal opencode_failure line", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quiet-exit-"));
  const driver = createOpenCodeDriver(async () => ({ default: "fixture/mock", options: [{ id: "fixture/mock", label: "Mock" }] }));
  const instance = await driver.create({ instanceId: "quiet-exit", displayName: undefined, enabled: true, environment: {
    HOME: root, OPENCODE_API_KEY: "local-fixture-only", FAKE_ACP_MODE: "opencode-private-stderr", FAKE_ACP_MODELS: "fixture/mock",
  }, config: { cli: fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "quiet-exit-thread", text: "offline", model: "fixture/mock", cwd: root });
    expect(await recorder.until(e => e.type === "turn.completed", 30000)).toMatchObject({ ok: false });
    const cards = recorder.events.filter(e => e.type === "runtime.error").map(e => String((e as { message?: unknown }).message));
    expect(cards.join("\n")).not.toContain("opencode_failure");
    expect(cards).toContain("OpenCode closed before replying. It reported an authentication failure.");
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
}, 40000);

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
