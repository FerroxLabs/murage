import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { admittedFixtureInstance, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 T2: Claude's native WebSearch is denied when search is off, at every level, and a warm engine restarts on the change.
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
// What claudeSearchDeny() answers for search off (pinned in settings/tools-off.test.ts). Not imported here, so this file loads on the pre-lane base and its
// assertions reach the driver's own behaviour (deny flag, warm restart) instead of failing at a missing module.
const SEARCH_OFF_DENY = ["WebSearch"];
const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
let root: string, instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, info: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => { ensureDirs(); root = realpathSync(mkdtempSync(join(tmpdir(), "claude-search-off-"))); chmodSync(cli, 0o755); process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config"); });
afterEach(async () => { info?.mockRestore(); info = undefined; recorder?.stop(); await instance?.dispose(); instance = undefined; delete process.env.FAKE_CLAUDE_DUMP; delete process.env.CLAUDE_CONFIG_DIR; removeTempDirSync(root); });

const denied = (dump: string): string[] => {
  const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  const at = argv.indexOf("--disallowedTools");
  return at < 0 ? [] : argv[at + 1]!.split(",");
};
// The warm tests need an unmounted engine: the admitted fixture is the mounted single-use shape, which closes after every turn.
const sendWarm = async (turn: Record<string, unknown>) => {
  const sent = await instance!.adapter.sendTurn(fixtureMountTurn({ threadId: "t", cwd: fixtureBotFolder(), text: "fixture-only", warmIdentity: { botId: "b1", audience: "owner" }, draftOnly: true, ...turn } as never));
  await recorder!.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
};
const openWarm = async () => {
  instance = await ClaudeDriver.create({ instanceId: "p", displayName: "Fixture", enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  recorder = recordEvents(instance.adapter);
};
const open = async () => {
  instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: "p", displayName: "Fixture", enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } }));
  recorder = recordEvents(instance.adapter);
};
const send = async (turn: Record<string, unknown>) => {
  await instance!.adapter.sendTurn({ threadId: "t", cwd: root, text: "fixture-only", ...turn } as never);
  expect(await recorder!.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
};

for (const noLimits of [false, true]) {
  it(`search off denies native WebSearch, on does not: noLimits=${noLimits}`, async () => {
    const dump = join(root, "argv.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await open();
    const level = { noLimits: noLimits ? true : undefined, permissionNow: () => ({ noLimits: noLimits ? true : undefined, stopLine: true, routeAsks: true }) };
    await send({ ...level, nativeDeny: SEARCH_OFF_DENY });
    expect(denied(dump)).toContain("WebSearch");
    await instance!.dispose();
    await open();
    await send({ ...level, nativeDeny: [] });
    expect(denied(dump)).not.toContain("WebSearch");
  });
}

// The dispatch trace names whether a turn reused the live engine or spawned a new one; the settle probe needs a moment before the next turn.
const dispatches = (): string[] => (info!.mock.calls as unknown[][]).map(call => call[0]).filter((line): line is string => typeof line === "string" && line.startsWith("claude dispatch"));
const settle = () => new Promise(resolve => setTimeout(resolve, 600));

it("control: an unchanged deny list reuses the warm engine", async () => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  await openWarm();
  await sendWarm({ nativeDeny: [] });
  await settle();
  await sendWarm({ nativeDeny: [] });
  expect(dispatches().at(-1)).toContain("process=reused");
});

it("a warm engine restarts when search goes off between two turns of one thread", async () => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  const dump = join(root, "argv.json");
  process.env.FAKE_CLAUDE_DUMP = dump;
  await openWarm();
  await sendWarm({ nativeDeny: [] });
  expect(denied(dump)).not.toContain("WebSearch");
  await settle();
  await sendWarm({ nativeDeny: SEARCH_OFF_DENY });
  expect(dispatches().at(-1)).toContain("process=spawned reason=args");
  expect(denied(dump)).toContain("WebSearch");
});
