// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Grok Build takes pictures and messages sent mid-turn, as Fuigo (its downstream) does. Proven on a real grok 1.0.67
// turn (grok-4.7, 2026-10-28): an inline ACP image block was read back word for word; `_x.ai/interject` answered
// `{ result: { status: "queued" } }`, echoed `_x.ai/session/interjection`, and the reply followed it. These pin the
// driver to that contract on the fake ACP CLI.
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
  const home = mkdtempSync(join(tmpdir(), "murage-grok-steer-"));
  homes.push(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "config.toml"), '[models]\ndefault = "grok-4.7"\n');
  writeFileSync(join(home, ".grok", "auth.json"), "{}");
  return home;
}

async function create(home: string, environment: Record<string, string>) {
  // Murage remembers a CLI's version per path: each owner home gets its own path to the fixture.
  const ownCli = join(home, "grok-fixture.ts");
  if (!existsSync(ownCli)) symlinkSync(cli, ownCli);
  instance = await GrokAgentDriver.create({ instanceId: "grok-steer", displayName: "Grok", enabled: true,
    config: GrokAgentDriver.decodeConfig({ cli: ownCli, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_VERSION: "1.0.67", FAKE_ACP_MCP_READY: "1",
      FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", ...environment } });
  recorder = recordEvents(instance.adapter);
  return instance;
}

const methods = (dump: string): string[] => { try { return JSON.parse(readFileSync(dump, "utf8")) as string[]; } catch { return []; } };

/** A Grok turn on `threadId`, prompted and held open at its gate file. */
async function heldTurn(home: string, threadId: string, interject?: string) {
  const dump = join(home, "rpc.json");
  const gate = join(home, "turn.gate");
  const created = await create(home, { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate, FAKE_ACP_RPC_DUMP: dump,
    ...(interject ? { FAKE_ACP_INTERJECT: interject } : {}) });
  const { turnId } = await created.adapter.sendTurn({ threadId, text: "Count the invoices" });
  for (let i = 0; i < 500 && !methods(dump).includes("session/prompt"); i++) await new Promise((r) => setTimeout(r, 20));
  expect(methods(dump)).toContain("session/prompt");
  return { adapter: created.adapter, dump, release: () => writeFileSync(gate, ""), turnId };
}

describe("Grok Build pictures and mid-turn messages", () => {
  it("declares pictures, inline pictures, queueing and steer before any turn has run", async () => {
    const created = await create(ownerHome(), { FAKE_ACP_MODE: "happy" });
    expect(created.adapter.capabilities.images).toBe(true);
    expect(created.adapter.capabilities.imagesInline).toBe(true);
    expect(created.adapter.capabilities.queueing).toBe(true);
    expect(typeof created.adapter.steer).toBe("function");
  });

  it("sends the turn's picture to grok as an inline ACP image block", async () => {
    const home = ownerHome();
    const promptDump = join(home, "prompt.json");
    const created = await create(home, { FAKE_ACP_MODE: "happy", FAKE_ACP_PROMPT_DUMP: promptDump });
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";
    const { turnId } = await created.adapter.sendTurn({ threadId: "t-grok-image", text: "what word is this?", images: [{ mimeType: "image/png", data }] });
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId, 15_000);
    const prompt = JSON.parse(readFileSync(promptDump, "utf8")) as Array<Record<string, unknown>>;
    expect(prompt.filter((block) => block.type === "image")).toEqual([{ type: "image", mimeType: "image/png", data }]);
  });

  it("puts a message into the running turn with _x.ai/interject, never _fuigo/interject, and waits for its fallback turn", async () => {
    const home = ownerHome();
    const { adapter, dump, release, turnId } = await heldTurn(home, "t-grok-steer", "fallback");
    expect(await adapter.steer!("t-grok-steer", "also check the totals")).toBe("delivered");
    expect(methods(dump)).toContain("_x.ai/interject");
    expect(methods(dump)).not.toContain("_fuigo/interject");
    release();
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId, 15_000);
    expect(done).toMatchObject({ ok: true });
    // The turn held for the `interject-fallback-` turn grok ran on its own `_x.ai/` rail, so that reply is this turn's.
    const text = recorder!.events.filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toContain("fallback reply #1");
    // Murage records the steered message itself; the echo adds nothing.
    expect(recorder!.events.filter((e) => JSON.stringify(e).includes("also check the totals"))).toEqual([]);
  }, 30_000);

  it("a grok that answers method-not-found is rejected (the caller queues the line) and never asked again", async () => {
    const home = ownerHome();
    const { adapter, dump, release } = await heldTurn(home, "t-grok-old");
    expect(await adapter.steer!("t-grok-old", "first")).toBe("rejected");
    expect(await adapter.steer!("t-grok-old", "second")).toBe("rejected");
    expect(methods(dump).filter((m) => m === "_x.ai/interject")).toHaveLength(1);
    release();
  }, 30_000);
});
