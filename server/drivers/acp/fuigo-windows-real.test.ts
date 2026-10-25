// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-engine proof, Windows only and opt-in (FUIGO_PROOF=1): a real Fuigo turn through Murage's own launch
// path (FuigoAgentDriver: the driver's env step, the launch file, spawnCli and the U24 engine job launcher), then a mid-turn
// Stop that must end the whole tree. The install shape (bundled engine, npm global, npm user prefix) is whatever the outer
// script set up (PATH, APPDATA, FUIGO_PROOF_HOME, FUIGO_PROOF_BUNDLE, FUIGO_PROOF_RESOURCES). The Flux key is read from FUIGO_PROOF_KEY_FILE into
// FLUX_API_KEY in this process only and never printed. A plain prompt only: no tools, no integrations, no MCP servers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { RuntimeEvent } from "../../contracts.ts";
import { resetPathCacheForTests } from "../../env-path.ts";
import { recordEvents } from "../../testing/events.ts";
import { descendantPids, windowsListing } from "../process-tree.ts";
import { FuigoAgentDriver } from "./fuigo.ts";

const REAL = process.platform === "win32" && process.env.FUIGO_PROOF === "1";

describe.skipIf(!REAL)("real Fuigo on Windows through Murage's launch path", () => {
  it("answers a plain prompt, and a mid-turn Stop ends the launcher, fuigo and everything under it", async () => {
    ensureDirs();
    // The install shape's home (its ~/.fuigo), which the test setup's throwaway home would otherwise hide.
    // The test setup scrubs ambient MURAGE_ names, so the shape arrives as FUIGO_PROOF_* and is set here.
    if (process.env.FUIGO_PROOF_HOME) process.env.HOME = process.env.USERPROFILE = process.env.FUIGO_PROOF_HOME;
    if (process.env.FUIGO_PROOF_BUNDLE) process.env.MURAGE_FUIGO_DIR = process.env.FUIGO_PROOF_BUNDLE;
    if (process.env.FUIGO_PROOF_RESOURCES) process.env.MURAGE_RESOURCES_PATH = process.env.FUIGO_PROOF_RESOURCES;
    resetPathCacheForTests();
    let instance: Awaited<ReturnType<typeof FuigoAgentDriver.create>> | undefined;
    let recorder: ReturnType<typeof recordEvents> | undefined;
    // The proof key lives only inside this try: a throw anywhere after it is read (create included) still removes it.
    try {
      process.env.FLUX_API_KEY = readFileSync(process.env.FUIGO_PROOF_KEY_FILE!, "utf8").trim();
      const live = await FuigoAgentDriver.create({ instanceId: "fuigo-real", displayName: "Fuigo", environment: {}, enabled: true, config: { cli: "fuigo", fullAuto: false } });
      instance = live;
      const events = recordEvents(live.adapter);
      recorder = events;
      const snapshot = await live.snapshot();
      console.log(`[proof] snapshot ${JSON.stringify(snapshot)}`);
      const text = (turnId: string) => events.events
        .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta" && (event as { turnId?: string }).turnId === turnId && event.streamKind === "assistant_text")
        .map((event) => event.delta).join("");

      const started = Date.now();
      const first = await live.adapter.sendTurn({ threadId: "t-real", text: "Reply with exactly the single word PONG and nothing else. Do not use any tools." });
      const done = await events.until((event) => event.type === "turn.completed" && event.turnId === first.turnId, 180_000);
      console.log(`[proof] turn1 ${JSON.stringify({ ok: (done as { ok?: boolean }).ok, stopReason: (done as { stopReason?: string }).stopReason, ms: Date.now() - started, text: text(first.turnId).slice(0, 80) })}`);
      expect(done).toMatchObject({ ok: true });
      expect(text(first.turnId).toUpperCase()).toContain("PONG");

      const second = await live.adapter.sendTurn({ threadId: "t-real", text: "Write the numbers from 1 to 3000, one per line, as plain text. Do not use any tools." });
      await events.until((event) => event.type === "content.delta" && (event as { turnId?: string }).turnId === second.turnId, 180_000);
      // mid-turn: the whole tree under this test process (the launcher, fuigo.exe and its console host, any node shim)
      const tree = await descendantPids(process.pid);
      const before = await windowsListing();
      const identities = new Map((before ?? []).filter((row) => tree?.has(row.pid)).map((row) => [row.pid, row.start]));
      console.log(`[proof] mid-turn tree ${JSON.stringify([...identities.keys()])} streamed=${text(second.turnId).length}`);
      expect(identities.size).toBeGreaterThanOrEqual(2);
      const stopAt = Date.now();
      const stop = await live.adapter.interruptTurn("t-real", second.turnId);
      const stopMs = Date.now() - stopAt;
      const settled = await events.until((event) => event.type === "turn.completed" && event.turnId === second.turnId, 30_000);
      const after = await windowsListing();
      const survivors = (after ?? []).filter((row) => identities.get(row.pid) === row.start).map((row) => row.pid);
      console.log(`[proof] stop ${JSON.stringify({ stop, stopMs, stopReason: (settled as { stopReason?: string }).stopReason, survivors, listed: after !== null })}`);
      expect(stop).toEqual({ closeConfirmed: true });
      expect(after).not.toBeNull();
      expect(survivors).toEqual([]);
    } finally {
      delete process.env.FLUX_API_KEY;
      recorder?.stop();
      await instance?.dispose();
    }
  }, 600_000);
});
