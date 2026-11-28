// q1024-steerquar (ASTRA-TIPAUDIT-1024 High 3): an owner's mounted send to a bot whose earlier relay stop could not confirm is
// never refused. It waits the bounded window, then runs on its own new relay; the held relay stays quarantined, and every other
// audience is still refused (MOUNT_RELAY_STOP_UNCONFIRMED). Entry: the registry's owner decorator over the real ACP driver.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { bindFixtureAdapter } from "../../testing/mcp-admission-fixture.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { recordEvents } from "../../testing/events.ts";
import { HELD_RELAY_PID, holdBotRelay } from "../../testing/held-relay-fixture.ts";
import { decorateOwnerTurnInstance, setOwnerTurnResolver } from "../../harness/power-owner-adapter.ts";
import { assertRelayAvailable } from "../cli-mount-relay.ts";
import { createAcpDriver } from "./core.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";

// The held engine's pid (HELD_RELAY_PID; a literal here: the mock factory may not import a module that imports procs).
const heldPid = vi.hoisted(() => 2_000_000_017);
vi.mock("../../procs.ts", async original => {
  const actual = await original<typeof import("../../procs.ts")>();
  return {
    ...actual,
    killCliTree: (...args: Parameters<typeof actual.killCliTree>) => { if (args[0].pid !== heldPid) actual.killCliTree(...args); },
    awaitCliTreeStopped: (...args: Parameters<typeof actual.awaitCliTreeStopped>) => args[0].pid === heldPid ? Promise.resolve(false) : actual.awaitCliTreeStopped(...args),
    cliTreeStoppedSignal: (...args: Parameters<typeof actual.cliTreeStoppedSignal>) => args[0].pid === heldPid ? new Promise<true>(() => {}) : actual.cliTreeStoppedSignal(...args),
  };
});

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
let instance: ProviderInstance | undefined;
afterEach(async () => { setOwnerTurnResolver(() => false); await instance?.dispose(); instance = undefined; });

it("q1024-steerquar ACP: the owner's mounted send runs past a held bot relay; a guest send and the held relay stay fenced", async () => {
  expect(HELD_RELAY_PID, "fixture: the mocked pid is the held engine").toBe(heldPid);
  const botId = `steerquar-${randomUUID()}`;
  const held = await holdBotRelay(botId);
  const driver = createAcpDriver({ driverKind: "steerquar-fixture", fluxReach: () => "elsewhere", displayName: "Fixture", defaultCli: cli,
    nativeSource: "fixture", models: { default: "fixture", options: [] }, loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue" });
  const live = await driver.create({ instanceId: "steerquar-fixture", displayName: "Fixture", enabled: true, environment: {}, config: { cli, fullAuto: false } });
  instance = live;
  bindFixtureAdapter(live.adapter);
  // The registry's decorator is the one place a turn is marked the owner's (harness/registry.ts).
  setOwnerTurnResolver(threadId => threadId.startsWith("owner-"));
  const adapter = decorateOwnerTurnInstance(live).adapter;
  const records = recordEvents(live.adapter);
  const input = (threadId: string, audience: "owner" | "non-owner"): SendTurnInput => ({ threadId, cwd: fixtureBotFolder(), text: "fixture",
    warmIdentity: { botId, audience }, integrations: { memory: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });

  const guest = await adapter.sendTurn(input(`guest-${randomUUID()}`, "non-owner")).then(() => "sent", (error: unknown) => String(error));
  expect(guest, "a guest send to the held bot is still refused").toContain("MOUNT_RELAY_STOP_UNCONFIRMED");

  const ownerThread = `owner-${randomUUID()}`;
  const owner = await adapter.sendTurn(input(ownerThread, "owner")).then(({ turnId }) => turnId, (error: unknown) => `refused: ${String(error)}`);
  expect(owner, "the owner's send is never refused by the held relay").not.toMatch(/^refused:/);
  const completed = await records.until(e => e.type === "turn.completed" && e.turnId === owner, 20_000);
  expect(completed, "the owner's turn runs to its reply").toMatchObject({ threadId: ownerThread, ok: true });
  expect(() => assertRelayAvailable(held), "the held relay stays quarantined").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
  // After the owner's own relay has settled, the earlier hold still fences every other audience.
  const after = await adapter.sendTurn(input(`guest-${randomUUID()}`, "non-owner")).then(() => "sent", (error: unknown) => String(error));
  expect(after, "a guest send after the owner's turn is still refused").toContain("MOUNT_RELAY_STOP_UNCONFIRMED");
}, 40_000);

// q1024-steerquar H2 (FABLE/ASTRA/OPUS 583d64b809): the owner's relay passes the hold, but it never starts a second copy of an
// integration whose held mount child is not confirmed gone (that child may still run with the same env and secrets). The owner's
// reply still comes, it is told that integration was not used, and an integration the held relay did not have starts as usual.
it("q1024-steerquar H2 ACP: the owner's relay starts no second copy of an integration whose held mount child is unconfirmed", async () => {
  const botId = `steerquar-h2-${randomUUID()}`;
  const marks = mkdtempSync(join(tmpdir(), "steerquar-h2-"));
  onTestFinished(() => rmSync(marks, { recursive: true, force: true }));
  // Each started copy of an integration appends one line to its own file, then idles until its stdin ends.
  const integration = (name: string) => ({ command: process.execPath, args: ["-e", "require('fs').appendFileSync(process.argv[1], 'started\\n'); process.stdin.resume()", join(marks, name)], env: {} });
  const starts = (name: string) => existsSync(join(marks, name)) ? readFileSync(join(marks, name), "utf8").split("\n").filter(Boolean).length : 0;
  const held = await holdBotRelay(botId, { notes: integration("notes-held") });
  const driver = createAcpDriver({ driverKind: "steerquar-fixture", fluxReach: () => "elsewhere", displayName: "Fixture", defaultCli: cli,
    nativeSource: "fixture", models: { default: "fixture", options: [] }, loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue" });
  const live = await driver.create({ instanceId: "steerquar-fixture", displayName: "Fixture", enabled: true, environment: {}, config: { cli, fullAuto: false } });
  instance = live;
  bindFixtureAdapter(live.adapter);
  setOwnerTurnResolver(threadId => threadId.startsWith("owner-"));
  const adapter = decorateOwnerTurnInstance(live).adapter;
  const records = recordEvents(live.adapter);
  const input = (threadId: string, audience: "owner" | "non-owner"): SendTurnInput => ({ threadId, cwd: fixtureBotFolder(), text: "fixture",
    warmIdentity: { botId, audience }, integrations: { custom: { notes: integration("notes"), calendar: integration("calendar") } } });

  const guest = await adapter.sendTurn(input(`guest-${randomUUID()}`, "non-owner")).then(() => "sent", (error: unknown) => String(error));
  expect(guest, "a guest send to the held bot is still refused").toContain("MOUNT_RELAY_STOP_UNCONFIRMED");
  const ownerThread = `owner-${randomUUID()}`;
  const owner = await adapter.sendTurn(input(ownerThread, "owner")).then(({ turnId }) => turnId, (error: unknown) => `refused: ${String(error)}`);
  expect(owner, "the owner's send is never refused by the held relay").not.toMatch(/^refused:/);
  const completed = await records.until(e => e.type === "turn.completed" && e.turnId === owner, 20_000);
  expect(completed, "the owner's turn runs to its reply").toMatchObject({ threadId: ownerThread, ok: true });
  expect(starts("calendar"), "an integration the held relay did not have starts for the owner").toBe(1);
  expect(starts("notes"), "no second copy of the integration whose held child is unconfirmed").toBe(0);
  const told = records.events.find(e => e.type === "item.started" && e.turnId === owner && (e as { toolKind?: string }).toolKind === "notice");
  expect((told as { title?: string } | undefined)?.title, "the owner is told that integration was not used").toMatch(/notes/);
  expect(() => assertRelayAvailable(held), "the held relay stays quarantined").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
}, 40_000);
