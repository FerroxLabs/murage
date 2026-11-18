import { fixtureBoundTurn } from "../testing/mcp-admission-fixture.ts";
import { bindConsumingTurn } from "../consuming-turn-response.ts";
import { denyLookup } from "./deny-read.ts";
import { assertSendFence } from "./send-fence.ts";
import { releaseProbe } from "../testing/baseline-contract.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDriver } from "../drivers/claude.ts";
import { fencedTurnInput } from "../drivers/engine-input.ts";
import { openTurnLineage, closeTurnLineage } from "./lineage-write.ts";
import { buildPrompt, ownReplayRefs, promptPart, noneRef } from "./prompt-parts.ts";
import * as sendFence from "./send-fence.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { LineageReader, TurnLineage } from "./lineage-types.ts";
import type { ProviderInstance } from "../contracts.ts";

const fixtures: WritetimeFixture[] = [], turns: TurnLineage[] = [], drivers: ProviderInstance[] = [];
afterEach(async () => {
  releaseProbe.atWrite = undefined; releaseProbe.writes = 0;
  for (const driver of drivers.splice(0)) await driver.dispose();
  turns.splice(0).forEach(closeTurnLineage); fixtures.splice(0).forEach(f => f.close());
  vi.unstubAllEnvs();
});
async function driver() {
  const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const instance = await ClaudeDriver.create({ instanceId: "release-probe", displayName: "Claude", environment: {}, enabled: true, config: { cli, permissionMode: "acceptEdits" } });
  drivers.push(instance); return instance;
}
function prepare(f: WritetimeFixture, audience: LineageReader) {
  fixtures.push(f);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "probe" }); turns.push(turn);
  // BASE already has the public fence path. A1 adds reader retention to this
  // same path; its absence must not stop these behavioral witnesses running.
  const api = sendFence as typeof sendFence & { prepareRetainedFence?: (turn: TurnLineage, reader: LineageReader, stop: () => void, db: typeof f.db) => LineageReader };
  const reader = api.prepareRetainedFence?.(turn, audience, vi.fn(), f.db) ?? audience;
  const binding = bindConsumingTurn({ identity: { botId: "B", threadId: "T", dispatchGeneration: turn.turnId, lineageTurnIds: [turn.turnId], adapterLeaseId: turn.turnId }, turn, db: f.db, isCurrent: () => true, onLedgerRefused() {} });
  return { turn, reader, binding };
}
it.each([false, true])("T-A-LATE actual stdin refuses audience revoke; generation moved=%s", async moved => {
  const f = new WritetimeFixture().reply("T", "X", 1);
  const { turn, reader, binding } = prepare(f, MEMBER);
  const prompt = buildPrompt(turn, [promptPart(releaseProbe.marker, ownReplayRefs("T", ["X"]))]);
  const input = fencedTurnInput({ threadId: "T", releaseBinding: binding, prompt, cwd: fixtureBotFolder() }, { reader, db: f.db, ...{ retained: turn } });
  // The unchanged baseline public fence passes before the mutation.
  input.beforeSubmit?.();
  f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)"); f.denyLine("T", 1, 7);
  if (moved) f.meta("deny_generation", turn.denyGeneration + 1);
  await (await driver()).adapter.sendTurn(fixtureBoundTurn(input)).catch(() => undefined);
  expect(releaseProbe.writes, "actual child stdin enqueues after audience revoke").toBe(0);
}, 30_000);
it.each(["replay", "prefix", "cross-thread"] as const)("T-A-DISPLACED actual stdin retains old %s", async kind => {
  const f = new WritetimeFixture().reply("T", "X", 1).reply("S", "origin", 2);
  const { turn, reader, binding } = prepare(f, MEMBER);
  const refs = kind === "replay" ? ownReplayRefs("T", ["X"]) : kind === "prefix"
    ? [{ kind: "prefix" as const, threadId: "T", shown: ["X"], headLsn: turn.turnLsn }]
    : [{ kind: "line" as const, threadId: "S", messageId: "origin" }];
  const first = fencedTurnInput({ threadId: "T", releaseBinding: binding, prompt: buildPrompt(turn, [promptPart(releaseProbe.marker, refs)]), cwd: fixtureBotFolder() }, { reader, db: f.db, ...{ retained: turn } });
  const instance = await driver();
  await instance.adapter.sendTurn(fixtureBoundTurn(first));
  expect(releaseProbe.writes, "positive control reaches real stdin").toBe(1);
  await instance.adapter.interruptTurn("T"); await instance.adapter.resetSession?.("T");
  for (let n = 0; n < 41; n++) f.reply("T", `later-${n}`, n + 3);
  f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)");
  f.denyLine(kind === "cross-thread" ? "S" : "T", kind === "cross-thread" ? 2 : 1, 7);
  try {
  const next = fencedTurnInput({ threadId: "T", releaseBinding: binding, prompt: buildPrompt(turn, [promptPart(releaseProbe.marker, [noneRef("owner-turn")])]), cwd: fixtureBotFolder() }, { reader, db: f.db, ...{ retained: turn } });
  await instance.adapter.sendTurn(fixtureBoundTurn(next)).catch(() => undefined);
  } catch { /* refusal may occur while preparing the displaced prompt */ }
  expect(releaseProbe.writes).toBe(1);
}, 30_000);
it("T-A-CONTROL actual stdin delivers valid direct-owner content after audience-only revoke", async () => {
  const f = new WritetimeFixture().reply("T", "X", 1);
  const { turn, reader, binding } = prepare(f, CONTENT);
  const prompt = buildPrompt(turn, [promptPart(releaseProbe.marker, ownReplayRefs("T", ["X"], "content"))]);
  f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)"); f.denyLine("T", 1, 7);
  await (await driver()).adapter.sendTurn(fixtureBoundTurn(fencedTurnInput({ threadId: "T", releaseBinding: binding, prompt, cwd: fixtureBotFolder() }, { reader, db: f.db, ...{ retained: turn } })));
  expect(releaseProbe.writes).toBe(1);
}, 30_000);

// Preserve the integrated LASTRESORT-MIN baseline controls verbatim.
const AUDIENCE_REVOKE = 7, CONTENT_REVOKE = 8;
const SECRET = "SECRET-REVOKED-LINE-BYTES";
const KEEP = "kept reply words";

type When = "late" | "early";
type Kind = "audience" | "content";
function run(reader: LineageReader, when: When, kind: Kind, tag?: "content") {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_REVOKE);
  f.footprint(1, ["s-room"]);
  f.owner("D", "o1", 1).reply("D", "g1", 2, { memLsn: 5, footprint: 1 }).reply("D", "g2", 3, { memLsn: 5, footprint: 1 }).meta("deny_generation", 3);
  const text: Record<string, string> = { o1: "owner question", g1: SECRET, g2: KEEP };
  const revokeId = kind === "audience" ? AUDIENCE_REVOKE : CONTENT_REVOKE;
  const land = () => { f.denyLine("D", 2, revokeId).meta("deny_generation", 4); };
  if (when === "early") land();
  // prepare: the generated lines are judged by the preparation reader (the same reader the fence later uses)
  const judged = denyLookup(f.db, { threadId: "D", lines: ["g1", "g2"].map(messageId => ({ messageId, author: "generated" as const })) }, reader);
  const shown = ["o1", ...["g1", "g2"].filter(id => judged.get(id)?.state === "shown")];
  const turn = openTurnLineage(f.db, { threadId: "D", turnId: "direct-last-resort" });
  // index.ts last resort: [...ownReplayRefs(threadId, ownShownIds, ownerAudience ? "content" : undefined), noneRef("murage")]
  const built = buildPrompt(turn, [promptPart(shown.map(id => text[id]).join("\n"), [...ownReplayRefs("D", shown, tag), noneRef("murage")])]);
  if (when === "late") land(); // after prepare, before the send fence
  const sent: string[] = []; // bytes handed to a fake engine writer
  let refused: unknown = null;
  try { assertSendFence(built, reader, f.db); sent.push(built.text); } catch (error) { refused = error; }
  closeTurnLineage(turn);
  const prepared = judged.get("g1")?.state;
  return { refused, sent, prepared };
}

describe("direct turn, last-resort replay refs, a revoke between prepare and send", () => {
  it("MAIN: non-owner reader, audience-only revoke after prepare: the fence refuses and nothing is sent", () => {
    const r = run(MEMBER, "late", "audience");
    expect(r.prepared, "prepare showed the line to the audience reader, so the case is not vacuous").toBe("shown");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 1a: direct owner (content reader, replay refs by content), the same audience-only revoke after prepare: shown by design", () => {
    const r = run(CONTENT, "late", "audience");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeNull();
    expect(r.sent.join("")).toContain(SECRET);
  });
  it("CONTROL 1b: owner room (owner reader, replay refs tagged content), the same audience-only revoke after prepare: shown by design", () => {
    const r = run(OWNER, "late", "audience", "content");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeNull();
    expect(r.sent.join("")).toContain(SECRET);
  });
  it("CONTROL 1c: the tag is what spares the owner room: the same owner reader with an untagged replay is refused", () => {
    const r = run(OWNER, "late", "audience");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 2: non-owner reader, a CONTENT revoke after prepare must refuse and send nothing", () => {
    const r = run(MEMBER, "late", "content");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 3: revoke BEFORE prepare (audience-only, non-owner): the line is withheld at prepare and its bytes never reach the payload", () => {
    const r = run(MEMBER, "early", "audience");
    expect(r.prepared).not.toBe("shown");
    expect(r.sent.join("")).not.toContain(SECRET);
    expect(r.refused).toBeNull();
  });
});
