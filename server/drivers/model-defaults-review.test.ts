import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), "review-model-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

it.each([false, true])("dispatches an uncatalogued saved Codex model (explicit OpenAI=%s)", async explicit => {
  const dir = home();
  mkdirSync(join(dir, ".codex"));
  const config = `${explicit ? 'model_provider = "openai"\n' : ''}model = "gpt-future-codex"\n`;
  writeFileSync(join(dir, ".codex/config.toml"), config);
  const cli = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const dump = join(dir, "dump.json");
  const instance = await CodexDriver.create({ instanceId: "saved-codex", displayName: "Codex", enabled: true,
    environment: { HOME: dir, CODEX_HOME: join(dir, ".codex"), FAKE_CODEX_DUMP: dump }, config: { ...CodexDriver.defaultConfig(), cli } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "saved-codex", text: "hi", cwd: dir });
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    const { calls } = JSON.parse(readFileSync(dump, "utf8"));
    expect(calls.find((call: { method: string }) => call.method === "thread/start").params).toMatchObject({ model: "gpt-future-codex", modelProvider: "openai" });
    expect(instance.models.default).toBe("gpt-future-codex");
    expect(readFileSync(join(dir, ".codex/config.toml"), "utf8")).toBe(config);
  } finally { recorder.stop(); await instance.dispose(); }
});

it.each(["sonnet", "claude-future-model", "unfamiliar-model"])("dispatches the saved Claude model %s without an extra declaration", async model => {
  const dir = home();
  mkdirSync(join(dir, ".claude"));
  const settings = JSON.stringify({ model });
  writeFileSync(join(dir, ".claude/settings.json"), settings);
  const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const dump = join(dir, "dump.json");
  const instance = await ClaudeDriver.create({ instanceId: "saved-claude", displayName: "Claude", enabled: true,
    environment: { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, ".claude"), FAKE_CLAUDE_DUMP: dump }, config: { ...ClaudeDriver.defaultConfig(), cli } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "saved-claude", text: "hi", cwd: dir });
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv[argv.indexOf("--model") + 1]).toBe(model);
    expect(instance.models.default).toBe(model);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(settings);
  } finally { recorder.stop(); await instance.dispose(); }
});

it("requalifies a replaced Codex executable on immediate send without a model refresh", async () => {
  const dir = home();
  const cli = join(dir, "codex-fixture");
  const received = join(dir, "received.json");
  const binary = (version: string) => writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") console.log("codex-cli ${version}");
else {
  createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (msg.method === "model/list") process.exit(1);
    if (msg.method === "thread/start" || msg.method === "turn/start") {
      writeFileSync(${JSON.stringify(received)}, line);
      process.exit(1);
    }
    if (msg.id !== undefined) console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  });
}
`, { mode: 0o755 });
  binary("0.162.1");
  const instance = await CodexDriver.create({ instanceId: "replace-send", displayName: "Codex", enabled: true,
    environment: { HOME: dir, CODEX_HOME: join(dir, ".codex") }, config: { ...CodexDriver.defaultConfig(), cli } });
  const recorder = recordEvents(instance.adapter);
  try {
    expect(instance.models.default).toBe("gpt-6.1-sol");
    // Keep the qualified executable intact so restoring it restores the exact identity.
    const original = join(dir, "codex-original");
    renameSync(cli, original);
    binary("0.144.4-old");
    await instance.adapter.sendTurn({ threadId: "replace-send", text: "hi", cwd: dir });
    const completed = await recorder.until(e => e.type === "turn.completed");
    expect(existsSync(received)).toBe(false);
    expect(completed).toMatchObject({ ok: false, stopReason: "update_required" });
    expect(instance.models.options).toEqual([]);
    renameSync(original, cli);
    const restored = await instance.adapter.sendTurn({ threadId: "restored-send", text: "hi", cwd: dir });
    // This minimal fixture has no hook support, but the restored identity must
    // recover its catalog and reach launch rather than retain the update refusal.
    expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === restored.turnId)).not.toMatchObject({ stopReason: "update_required" });
    expect(instance.models.default).toBe("gpt-6.1-sol");
  } finally { recorder.stop(); await instance.dispose(); }
});

it("uses the catalog default for a new Codex thread and the answered model for a blank resume", async () => {
  const dir = home();
  const cli = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const dump = join(dir, "dump.json");
  const instance = await CodexDriver.create({ instanceId: "blank-resume", displayName: "Codex", enabled: true,
    environment: { HOME: dir, CODEX_HOME: join(dir, ".codex"), FAKE_CODEX_DUMP: dump, FAKE_CODEX_MODE: "resume" },
    config: { ...CodexDriver.defaultConfig(), cli } });
  const recorder = recordEvents(instance.adapter);
  try {
    const first = await instance.adapter.sendTurn({ threadId: "blank-resume", text: "first", cwd: dir });
    expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === first.turnId)).toMatchObject({ ok: true });
    const firstCalls = JSON.parse(readFileSync(dump, "utf8")).calls;
    expect(firstCalls.find((call: { method: string }) => call.method === "thread/start").params.model).toBe(instance.models.default);
    await instance.adapter.interruptTurn("blank-resume");
    const second = await instance.adapter.sendTurn({ threadId: "blank-resume", text: "second", cwd: dir, resumeCursor: "codex-thread-1" });
    expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === second.turnId)).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
    expect(calls.find((call: { method: string }) => call.method === "thread/resume").params).not.toHaveProperty("model");
    expect(calls.some((call: { method: string }) => call.method === "thread/start")).toBe(false);
    expect(recorder.events.find(e => e.type === "session.started" && e.turnId === second.turnId)).toMatchObject({ model: "fake-codex-model" });
  } finally { recorder.stop(); await instance.dispose(); }
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
