// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GROK-812MIN-STOPPED (10-29): a Grok card that went unanswered for 15 minutes was denied with a bare reject_once,
// grok ended the whole prompt as `cancelled`, and the transcript said "Stopped by you". Grok Build is the same shell
// as Fuigo (grok 1.0.70 carries the `FollowupMessage` permission decision and the `followup_message` key), so a deny
// now carries the follow-up note and the turn carries on without the tool. The card no longer has a deadline at all
// (Sean 10-29): it waits for the owner. The fake ACP CLI plays grok's rule (FAKE_ACP_BARE_REJECT_CANCELS): a bare
// reject cancels the prompt; a reject with the note answers and ends end_turn.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { GrokAgentDriver } from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
afterEach(async () => {
  recorder?.stop(); recorder = undefined;
  await instance?.dispose(); instance = undefined;
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

function ownerHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-deny-"));
  homes.push(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "config.toml"), '[models]\ndefault = "grok-4.7"\n');
  writeFileSync(join(home, ".grok", "auth.json"), "{}");
  return home;
}

async function grokTurn(threadId: string, rule: "1" | "always") {
  const home = ownerHome();
  const dump = join(home, "dump.json");
  // Murage remembers a CLI's version per path: each owner home gets its own path to the fixture.
  const ownCli = join(home, "grok-fixture.ts");
  if (!existsSync(ownCli)) symlinkSync(cli, ownCli);
  instance = await GrokAgentDriver.create({ instanceId: "grok-deny", displayName: "Grok", enabled: true,
    config: GrokAgentDriver.decodeConfig({ cli: ownCli, fullAuto: false }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_VERSION: "1.0.70", FAKE_ACP_MCP_READY: "1",
      FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MODE: "permission", FAKE_ACP_DUMP: dump,
      FAKE_ACP_PERMISSION_COMMAND: "printf 'tick' >> notes/log.md", FAKE_ACP_BARE_REJECT_CANCELS: rule } });
  recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn({ threadId, text: "edit the picture" });
  const opened = await recorder.until((e) => e.type === "request.opened", 15_000) as { requestId: string };
  const decision = () => (JSON.parse(readFileSync(dump, "utf8")) as { decision?: { outcome?: unknown; _meta?: { followup_message?: string } } }).decision;
  return { adapter: instance.adapter, turnId, requestId: opened.requestId, decision };
}

const completed = (turnId: string) => recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId, 15_000) as Promise<{ ok: boolean; stopReason?: string | null; deniedBy?: string }>;
const replyText = () => recorder!.events.filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta).join("");

describe("a Grok deny never ends the turn as the owner's Stop", () => {
  it("the owner's Deny carries grok's follow-up note, and the turn finishes end_turn without the tool", async () => {
    const turn = await grokTurn("t-grok-deny", "1");
    expect(await turn.adapter.respondToRequest("t-grok-deny", turn.requestId, { behavior: "deny" })).toBe("rejected");
    const done = await completed(turn.turnId);
    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect(done.deniedBy).toBeUndefined();
    expect(turn.decision()).toMatchObject({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(turn.decision()?._meta?.followup_message).toMatch(/^The user denied this operation\./);
    expect(replyText()).toContain("FOLLOWUP: The user denied this operation.");
    expect(recorder!.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
  }, 30_000);

  it("a card nobody answers waits for the owner: nothing denies it, and a late Allow still runs the tool", async () => {
    // The old fixture deadline (MURAGE_PERMISSION_DENY_MS) is gone: setting it changes nothing.
    process.env.MURAGE_PERMISSION_DENY_MS = "300";
    try {
      const turn = await grokTurn("t-grok-waits", "1");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(recorder!.events.some((e) => e.type === "request.resolved")).toBe(false);
      expect(recorder!.events.some((e) => e.type === "turn.completed")).toBe(false);
      expect(await turn.adapter.respondToRequest("t-grok-waits", turn.requestId, { behavior: "allow" })).not.toBe("unavailable");
      expect(await completed(turn.turnId)).toMatchObject({ ok: true, stopReason: null });
      expect(recorder!.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "allow", source: "user" });
    } finally { delete process.env.MURAGE_PERMISSION_DENY_MS; }
  }, 30_000);

  it("an engine that still ends the prompt after a deny reports whose deny it was, never a Stop", async () => {
    const denied = await grokTurn("t-grok-ignores-deny", "always");
    await denied.adapter.respondToRequest("t-grok-ignores-deny", denied.requestId, { behavior: "deny" });
    expect(await completed(denied.turnId)).toMatchObject({ ok: true, stopReason: "cancelled", deniedBy: "user" });
  }, 45_000);

  it("the owner's Stop while a card is open is a Stop: no deniedBy", async () => {
    const turn = await grokTurn("t-grok-stop", "always");
    await turn.adapter.interruptTurn("t-grok-stop", turn.turnId);
    const done = await completed(turn.turnId);
    expect(done.stopReason).toBe("cancelled");
    expect(done.deniedBy).toBeUndefined();
  }, 30_000);
});
