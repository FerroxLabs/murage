// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

// Producer: server admission (p1-owner-stall). Recall readiness: recall-s1s2c/recall-s4.
it.each(["claude", "codex"])("fresh desktop owner send reaches the %s engine and completes", async engine => {
  const fixture = await launchVerificationServer(process.env, undefined, {
    separateHome: true, turnLog: { replies: ["Owner fixture reply."] },
    instrumentationSource: `
      ${engine === "codex" ? `
      const fs = await import('node:fs'), path = await import('node:path');
      const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.verification = { driver: 'codex', config: { cli: ${JSON.stringify(resolve("server/testing/fake-codex-app-server.ts"))}, fullAuto: true },
        environment: { FAKE_CODEX_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'codex-dump.json') } };
      fs.writeFileSync(file, JSON.stringify(cfg));
      ` : ""}
    `,
  });
  const run = (args: string[]) => runControlMurage([...args, "--url", fixture.info.url], {
    env: { MURAGE_DATA_DIR: fixture.info.dataDir },
  }) as Promise<any>;
  try {
    const { bot } = await run(["new-bot", "--name", "Owner fixture"]);
    const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    expect((await fetch(fixture.info.url + `/api/bots/${bot.id}/messages`, { method: "POST", headers,
      body: JSON.stringify({ threadId: bot.threadId, text: "Reply to this owner turn." }) })).status).toBe(202);
    const waited = await run(["wait", "--bot", bot.id, "--timeout", "10"]);
    const transcript = await run(["messages", "--bot", bot.id, "--limit", "20"]);
    expect(transcript.messages.some((message: { text?: string }) => message.text === (engine === "claude" ? "Owner fixture reply." : "done from fake codex")), readFileSync(fixture.info.logPath, "utf8").slice(-6000)).toBe(true);
    expect(waited.status).toBe("settled");
  } finally {
    await fixture.close();
  }
}, 120_000);
