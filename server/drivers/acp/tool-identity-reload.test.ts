import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { type AcpConfig } from "./core.ts";
import { createFixtureAcpDriver as createAcpDriver } from "../../testing/acp-support-fixture.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const Driver = createAcpDriver({ driverKind: "identityFixture", displayName: "Identity fixture", models: { default: "m-one", options: [{id:"m-one",label:"One"}] }, defaultCli: cli, nativeSource: "identity.fixture", loginNote: "unused", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true }) as unknown as ProviderDriver<AcpConfig>;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let home: string;
let log: string;
beforeEach(() => { ensureDirs(); home = mkdtempSync(join(tmpdir(), "murage-identity-reload-")); log = join(home, "wire.jsonl"); writeFileSync(log, ""); });
afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; await removeTempDir(home); });
async function open() {
  const frame = { toolCallId: "fixture-ask", kind: "execute", title: "terminal", rawInput: { command: "printf fixture" } };
  const script = [
    { at: 1, update: {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"fixture"}} },
    { at: 5, request: { id: 901, method: "session/request_permission", params: { toolCall: frame, options: [{optionId:"yes",kind:"allow_once"},{optionId:"no",kind:"reject_once"}] } } },
    { at: 10, after: 901, result: {stopReason:"end_turn"} },
  ];
  instance = await Driver.create({ instanceId:"fixture",displayName:"Fixture",enabled:true,config:Driver.decodeConfig({cli,fullAuto:false}),environment:{ HOME:home,USERPROFILE:home,FAKE_ACP_MODE:"fuigo-script",FAKE_ACP_SCRIPT:JSON.stringify(script),FAKE_ACP_SCRIPT_LOG:log,FAKE_ACP_MCP_READY:"1" } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({threadId:"identity-reload",text:"fixture",cwd:home});
  return await recorder.until(e => e.type === "request.opened") as Extract<RuntimeEvent,{type:"request.opened"}>;
}
describe("driver-held approval reload (isolated fake engine)", () => {
  for (const change of ["same", "input", "wire", "missing", "missing-wire"] as const) it(change, async () => {
    const ask = await open();
    expect(ask.identityFrame).toBeDefined();
    const frame = JSON.parse(JSON.stringify(ask.identityFrame));
    if (change === "input") frame.rawInput.command = "printf changed";
    const result = await instance!.adapter.respondToRequest("identity-reload", ask.requestId!, {behavior:"allow",identityFrame: change === "missing" ? null : frame, toolIdentity: change === "missing-wire" ? undefined : change === "wire" ? {...ask.toolIdentity,name:"forged"} : ask.toolIdentity});
    expect(result).toBe(change === "same" ? "allowed-once" : "rejected");
    await recorder!.until(e => e.type === "turn.completed");
    const answer = readFileSync(log,"utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.id === 901);
    expect(answer.result.outcome.optionId).toBe(change === "same" ? "yes" : "no");
    if (change !== "same") expect(recorder!.events.some(e => e.type === "runtime.error")).toBe(true);
  });
  it("after the driver loses its turn, an old answer sends nothing", async () => {
    const ask = await open();
    await instance!.adapter.respondToRequest("identity-reload",ask.requestId!,{behavior:"deny"});
    await recorder!.until(e => e.type === "turn.completed");
    const before = readFileSync(log,"utf8");
    expect(await instance!.adapter.respondToRequest("identity-reload",ask.requestId!,{behavior:"allow",identityFrame:ask.identityFrame})).toBe("unavailable");
    expect(readFileSync(log,"utf8")).toBe(before);
  });
});
