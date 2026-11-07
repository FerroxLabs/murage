import { removeTempDir } from "../../testing/cleanup.ts";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { recordEvents } from "../../testing/events.ts";
import { NATIVE_DIR } from "../../config.ts";

it("persists only allowlisted categories from OpenCode stderr in both native sinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-private-"));
  const threadId = "opencode-private";
  const driver = createOpenCodeDriver(async () => ({ default: "fixture/mock", options: [{ id: "fixture/mock", label: "Mock" }] }));
  const instance = await driver.create({ instanceId: "private-process", displayName: undefined, enabled: true, environment: {
    HOME: root, OPENCODE_API_KEY: "local-fixture-only", FAKE_ACP_MODE: "opencode-private-stderr", FAKE_ACP_MODELS: "fixture/mock",
  }, config: { cli: fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId, text: "offline", model: "fixture/mock", cwd: root });
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: false });
    await instance.dispose();
    const native = await readFile(join(NATIVE_DIR, threadId + ".ndjson"), "utf8");
    const rows = native.trim().split("\n").map(line => JSON.parse(line));
    const stderr = rows.filter(row => row.msg?.type === "engine_stderr" || row.msg?.engineStderr);
    expect(stderr.some(row => row.msg?.type === "engine_stderr")).toBe(true);
    expect(stderr.some(row => row.msg?.engineStderr)).toBe(true);
    expect(JSON.stringify(stderr)).toContain("authentication");
    expect(native).not.toContain("fixturePrivate");
    expect(native).not.toContain("CredentialAlpha");
    expect(native).not.toContain("AI_APICallError");
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(root); }
});
