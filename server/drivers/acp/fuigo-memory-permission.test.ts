import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpDriver } from "./core.ts";
import { fuigoMemoryAllowOnce, newFuigoMemoryAlias } from "./fuigo-memory-permission.ts";
import { recordEvents } from "../../testing/events.ts";
import { NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";

const roots: string[] = [], instances: ProviderInstance[] = [];
afterEach(async () => { for (const instance of instances.splice(0)) await instance.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const names = ["memory_search", "memory_get", "memory_save", "memory_propose_correction"];
it("requires exact canonical identity and a unique one-time option", () => {
  const alias = newFuigoMemoryAlias(), call = { _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: `${alias}__memory_search` } } };
  expect(`${alias}__memory_propose_correction`).toHaveLength(61);
  expect(fuigoMemoryAllowOnce(call, [{ optionId: "once", kind: "allow_once" }], alias)).toBe("once");
  for (const options of [[], [{ optionId: "", kind: "allow_once" }], [{ optionId: "same", kind: "allow_once" }, { optionId: "same", kind: "allow_always" }], [{ optionId: "one", kind: "allow_once" }, { optionId: "two", kind: "allow_once" }]]) expect(fuigoMemoryAllowOnce(call, options, alias)).toBeNull();
  expect(fuigoMemoryAllowOnce({ title: `${alias}__memory_search`, rawInput: call }, [{ optionId: "once", kind: "allow_once" }], alias)).toBeNull();
  for (const identity of [{ version: "1", namespace: "mcp", name: `${alias}__memory_search` }, { version: 1, namespace: "mcp", name: `${alias}__memory_search_extra` }, { version: 1, namespace: "mcp", name: "use_tool" }]) {
    expect(fuigoMemoryAllowOnce({ _meta: { "fuigo/tool": identity } }, [{ optionId: "once", kind: "allow_once" }], alias)).toBeNull();
  }
});

async function fixture(scenario: string, tool = "memory_search") {
  const root = mkdtempSync(join(tmpdir(), "murage-memory-acp-")); roots.push(root);
  const home = join(root, "native-home"); mkdirSync(home); writeFileSync(join(home, "config.toml"), "# unchanged native settings\n");
  const dump = join(root, "wire.json"), cli = fileURLToPath(new URL("../../testing/fake-fuigo-memory-acp.mjs", import.meta.url));
  const driver = createAcpDriver({ driverKind: scenario === "other-engine" ? "other-fixture" : "fuigoAgent", displayName: "Memory wire fixture", defaultCli: process.execPath,
    nativeSource: "fuigo.acp", models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }, loginNote: "unused", isAuthenticated: () => true, pickAuthMethod: () => null, authFailure: "continue",
    spawnArgs: () => [cli, scenario, dump, tool], transformEnv: env => { env.HOME = home; env.USERPROFILE = home; env.FUIGO_HOME = home; } });
  const instance = await driver.create({ instanceId: "memory-wire", displayName: "Memory wire", environment: {}, enabled: true, config: { cli: process.execPath, fullAuto: false } }); instances.push(instance);
  const recorder = recordEvents(instance.adapter), threadId = `memory-${root.split("/").at(-1)}`;
  const memory = { command: process.execPath, args: ["unused-fixture-proxy"], env: { MURAGE_MEMORY_TOKEN: "synthetic-memory-capability" } };
  const turn: SendTurnInput = { threadId, text: "Use scoped memory", cwd: root, ...(scenario === "no-integration" ? {} : { integrations: { memory } }),
    ...scenario.startsWith("load") ? { resumeCursor: "old-session" } : {},
    ...scenario === "routed" ? { providerRoute: { connectionId: "fixture", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "synthetic-unused-key", model: "fixture", revision: "1" } as const } : {} };
  return { root, home, dump, instance, recorder, threadId, turn, memory };
}

it.each(names)("native Fuigo allows only this injected memory call once, without an approval card: %s", async tool => {
  const f = await fixture("valid", tool), sent = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.alias).toMatch(/^murage-memory-[a-f0-9]{20}$/);
  expect(observed.definitions[0].servers[0]).toEqual({ name: observed.alias, command: f.memory.command, args: f.memory.args, env: [{ name: "MURAGE_MEMORY_TOKEN", value: "synthetic-memory-capability" }] });
  expect(observed.decisions).toEqual([{ outcome: { outcome: "selected", optionId: "once" } }]);
  expect(f.recorder.events.some(event => event.type === "request.opened")).toBe(false);
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe("# unchanged native settings\n");
});

it.each(["old-alias", "wrong-alias", "missing-meta", "wrong-version", "wrong-namespace", "missing-session", "wrong-session", "question", "no-once", "ambiguous-option", "before-prompt", "other-engine", "no-integration", "routed", "unregistered-tool"])("retains ordinary owner permission handling for %s", async scenario => {
  const f = await fixture(scenario, scenario === "unregistered-tool" ? "memory_delete" : "memory_search"), sent = await f.instance.adapter.sendTurn(f.turn);
  const opened = await f.recorder.until(event => event.type === "request.opened");
  if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
  await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.decisions[0].outcome).toEqual({ outcome: "selected", optionId: "deny" });
  if (scenario === "routed" || scenario === "other-engine") expect(observed.alias).toBe("murage-memory");
});

it("a resumed turn gets a fresh alias and cannot reuse the preceding turn's automatic permission", async () => {
  const f = await fixture("two-turns"), first = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
  const second = await f.instance.adapter.sendTurn({ ...f.turn, resumeCursor: "memory-fixture-session" });
  const opened = await f.recorder.until(event => event.type === "request.opened" && event.turnId === second.turnId);
  if (opened.type !== "request.opened" || typeof opened.requestId !== "string") throw Error("missing request");
  await f.instance.adapter.respondToRequest(f.threadId, opened.requestId, { behavior: "deny" });
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId);
  const turns = JSON.parse(readFileSync(f.dump, "utf8"));
  expect(turns).toHaveLength(2);expect(turns[0].alias).not.toBe(turns[1].alias);
  expect(turns[0].decisions[0].outcome.optionId).toBe("once");expect(turns[1].decisions[0].outcome.optionId).toBe("deny");
});

it("uses the same fresh alias through session/load then session/new fallback", async () => {
  const f = await fixture("load-fallback"), sent = await f.instance.adapter.sendTurn(f.turn);
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const observed = JSON.parse(readFileSync(f.dump, "utf8"))[0];
  expect(observed.definitions.map((item: { method: string }) => item.method)).toEqual(["session/load", "session/new"]);
  expect(observed.definitions[0].servers).toEqual(observed.definitions[1].servers);
  expect(observed.decisions[0].outcome.optionId).toBe("once");
});

it.each(["after-result", "after-cancel"])("never automatically grants a request %s", async scenario => {
  const f = await fixture(scenario), sent = await f.instance.adapter.sendTurn(f.turn);
  if (scenario === "after-cancel") { await f.recorder.until(event => event.type === "content.delta"); await f.instance.adapter.interruptTurn(f.threadId, sent.turnId); }
  await f.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  await f.instance.dispose();
  const wire = readFileSync(join(NATIVE_DIR, `${f.threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(wire.some(item => item.dir === "in" && item.msg?.id === "memory-permission")).toBe(true);
  expect(wire.some(item => item.dir === "out" && item.msg?.id === "memory-permission" && item.msg?.result?.outcome?.optionId === "once")).toBe(false);
});
