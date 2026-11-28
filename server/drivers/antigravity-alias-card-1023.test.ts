// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 r2 (1.0.23), W15: the approval card of an Antigravity plain-name app call names the account and the
// recipient. Real path: the real AntigravityDriver runs the fake agy, whose PreToolUse hook relays each
// call_mcp_tool step to Murage (server/drivers/antigravity.ts request.opened); the driver's events go through the
// real EventBus intake (server/harness/bus.ts aliasAsk), and the card text is what the server shows
// (server/approval-text.ts cardDetail, shared/approval-plain.ts plainApproval). Table rows: SITES.md.
import { driverOwnerDecisionFixture } from "../testing/driver-decision-fixture.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { EventBus } from "../harness/bus.ts";
import { ALIAS_ENGINES } from "../../shared/connected-app-aliases.ts";
import { cardDetail } from "../approval-text.ts";
import { plainApproval } from "../../shared/approval-plain.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordMountedFixtureEvents as recordEvents, type EventRecorder } from "../testing/admitted-events.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const FAKE_ENV = ["FAKE_AGY_DUMP", "FAKE_AGY_TOOL_CALLS", "FAKE_AGY_RUN_HOOKS"];
const ACCOUNT = "acct_fixture_a";
const TO = "pat.recipient@example.com";
const ARGS = { recipient_email: TO, subject: "Hello", body: "Hi there" };
const mcp = (tool: string, args: Record<string, unknown>) => ({ name: "call_mcp_tool", args: { ServerName: "murage_connectors", ToolName: tool, Arguments: args } });
type Opened = Extract<RuntimeEvent, { type: "request.opened" }> & Record<string, any>;

describe("W15 Antigravity: the alias approval card names the account and the recipient (real driver, real bus)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let releaseDecision = () => {};
  let scratch = "";
  let work = "";
  let home = "";

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_AGY, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-agy-alias-"));
    work = join(scratch, "work");
    home = join(scratch, "home");
    for (const dir of [work, home]) mkdirSync(dir, { recursive: true });
    process.env.FAKE_AGY_DUMP = join(scratch, "dump.json");
    process.env.FAKE_AGY_RUN_HOOKS = "1";
  });
  afterEach(async () => {
    recorder?.stop();
    releaseDecision();
    await instance?.dispose();
    instance = undefined;
    for (const name of FAKE_ENV) delete process.env[name];
    await removeTempDir(scratch);
  });

  /** One Auto turn of the real driver; every ask is refused (nothing is sent). Returns what a bus subscriber got. */
  const run = async (calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<Opened[]> => {
    process.env.FAKE_AGY_TOOL_CALLS = JSON.stringify(calls);
    instance = await AntigravityDriver.create({ instanceId: "agy-alias", displayName: "Antigravity", environment: { HOME: home }, enabled: true, config: { cli: FAKE_AGY, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    releaseDecision = driverOwnerDecisionFixture(instance.adapter, work);
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: Opened[] = [];
    bus.subscribe((e) => { if (e.type === "request.opened") seen.push(e as Opened); });
    instance.adapter.onEvent((e) => {
      if (e.type === "request.opened") void instance!.adapter.respondToRequest(e.threadId, e.requestId ?? "", { behavior: "deny", message: "fixture" });
    });
    const { turnId } = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "t-agy-alias", text: "send it", cwd: work, routeAsks: true,
      integrations: { composio: { command: process.execPath, args: [], env: {} } } } as never));
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(seen).toHaveLength(calls.length);
    return seen;
  };
  const card = (e: Opened) => ({ detail: cardDetail(e as never), plain: plainApproval(e.tool, cardDetail(e as never)) });

  // SITES.md row antigravity.ts:885 (driver ask) x aliasAsk (bus intake): the alias call, and the equal raw execute call
  // Antigravity is out of ALIAS_ENGINES until proven on its real CLI (its raw-ask negative row is in connected-app-aliases.intake.test.ts);
  // this alias row runs again the moment it is added back. The raw execute row below always runs.
  it.skipIf(!ALIAS_ENGINES.has("antigravity"))("the alias call's card shows the account and the recipient, and equals the raw execute call's card", async () => {
    const [aliased, raw] = await run([
      mcp("gmail_send_email", { account: ACCOUNT, arguments: ARGS }),
      mcp("APPS_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: ACCOUNT, arguments: ARGS }], sync_response_to_workbench: false }),
    ]);
    // the bus filed the alias as the execute call (the intake ran on the driver's own event)
    expect(aliased!.toolCall!.name).toBe("mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL");
    const shown = card(aliased!);
    expect(shown.detail).toContain(ACCOUNT);
    expect(shown.detail).toContain(TO);
    expect(shown.plain?.lines).toEqual(expect.arrayContaining([`Account: ${ACCOUNT}`, `To: ${TO}`]));
    // what the owner is asked for the alias is what they are asked for the raw call
    expect(shown).toEqual(card(raw!));
  });

  it("the raw execute call's card shows the account and the recipient (the driver files the MCP arguments)", async () => {
    const [raw] = await run([mcp("APPS_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: ACCOUNT, arguments: ARGS }], sync_response_to_workbench: false })]);
    const shown = card(raw!);
    expect(shown.detail).toContain(ACCOUNT);
    expect(shown.detail).toContain(TO);
    expect(shown.plain?.lines).toEqual(expect.arrayContaining([`Account: ${ACCOUNT}`, `To: ${TO}`]));
  });
});
