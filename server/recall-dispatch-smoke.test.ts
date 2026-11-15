// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

// Owners: recall-scope owns view admission; recall-smoke owns dispatch recovery
// and this real launcher/control/fake-engine consumer of that contract.
const source = (name: string) => JSON.stringify(pathToFileURL(resolve("server", name)).href);

const cases = ["fresh", "off", "paused", "index-missing", "index-upgrade"].map(state => ({ state, venue: "bot" }));
cases.push(...["index-missing", "index-upgrade"].map(state => ({ state, venue: "channel" })));
for (const { state, venue } of cases) {
  it(`delivers the ${venue} engine reply with recall ${state} in a fresh isolated home`, async () => {
    const instrumentationSource = state === "fresh" ? undefined : `
      const { database } = await import(${source("database.ts")});
      const { setMemoryMode } = await import(${source("memory/repository.ts")});
      setMemoryMode(${JSON.stringify(state === "off" || state === "paused" ? state : "active")});
      ${state.startsWith("index-") ? `
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/server/index.ts')) return result;
        const needle = 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {';
        const effect = ${JSON.stringify(state === "index-missing"
          ? "database().prepare('DELETE FROM memory_recall_contexts').run();"
          : "database().prepare(\"UPDATE memory_recall_views SET state='building' WHERE state='ready'\").run();")};
        const text = String(result.source);
        if (!text.includes(needle)) throw new Error('fixture recall injection missing');
        return { ...result, source: text.replace(needle, needle + effect + ${JSON.stringify(`console.warn('fixture recall state=${state}');`)}) };
      }});
      ` : ""}
    `;
    const reply = "Fixture integration reply.";
    const fixture = await launchVerificationServer(process.env, undefined, {
      separateHome: true, turnLog: { replies: [reply] }, instrumentationSource,
    });
    const env = { MURAGE_DATA_DIR: fixture.info.dataDir };
    const run = (args: string[]) => runControlMurage([...args, "--url", fixture.info.url], { env }) as Promise<any>;
    try {
      expect((await run(["doctor"])).ok).toBe(true);
      const created = await run(["new-bot", "--name", "Integration fixture"]);
      const id = venue === "bot" ? created.bot.id
        : (await run(["new-channel", "--name", "Integration room", "--members", created.bot.id])).channel.id;
      const destination = [`--${venue}`, id];
      if (state === "off" || state === "paused") {
        // Set the owner preference after boot's fresh-install migration.
        const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
        const response = await fetch(fixture.info.url + "/api/memory/action", {
          method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
          body: JSON.stringify({ action: "configure", mode: state }),
        });
        expect(response.status).toBe(200);
        const status = await (await fetch(fixture.info.url + "/api/memory/status", {
          headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
        })).json() as { mode: string };
        expect(status.mode).toBe(state);
      }
      await run([venue === "bot" ? "send" : "send-channel", ...destination, "--text", "Fixture integration turn."]);
      expect((await run(["wait", ...destination, "--timeout", "30"])).status).toBe("settled");
      const transcript = await run(["messages", ...destination, "--limit", "10"]);
      expect(transcript.messages.some((message: { text?: string }) => message.text === reply),
        JSON.stringify(transcript) + "\n" + readFileSync(fixture.info.logPath, "utf8").slice(-6000)).toBe(true);
      // Settled or an activity/error row alone never proves that an engine ran.
      const turns = readFileSync(fixture.fixtureTurnLogPath, "utf8").trim().split("\n");
      expect(turns).toHaveLength(1);
      if (state.startsWith("index-")) {
        const log = readFileSync(fixture.info.logPath, "utf8");
        expect(log).toContain(`fixture recall state=${state}`);
        expect(log).toContain("MEMORY_RECALL_UNAVAILABLE");
        expect(log).toContain("without recalled memory");
        expect(log).toContain("starting turn without recalled memory");
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);
}
