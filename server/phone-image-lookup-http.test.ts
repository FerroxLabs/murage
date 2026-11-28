// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A paired phone's GET /api/attachments/<name> through the real server: the visibility check it runs three times per request reads
// the attachment-name index, so the answer takes as long with a long history as with a short one (it used to read every message).
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const HISTORY_ROWS = 20_000;
// about 8 KB a row, as a long reply or a tool result is: 160 MB of history
const FILLER = " ordinary words of a long reply".repeat(260);

it("a phone image GET costs the same with 20k long history rows as with a handful", async () => {
  const session = await launchVerificationServer();
  const env = { MURAGE_URL: session.info.url };
  try {
    const created = await runControlMurage(["new-bot", "--name", "Phone Image Probe"], { env }) as { bot: { id: string; activeTaskId: string } };
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const upload = await fetch(`${session.info.url}/api/attachments?threadId=${created.bot.activeTaskId}`, { method: "POST", headers: { ...desktop, "content-type": "image/png" }, body: PNG });
    expect(upload.status).toBe(201);
    const saved = await upload.json() as { path: string };
    const name = saved.path.split(/[\\/]/).at(-1)!;
    await runControlMurage(["send", "--bot", created.bot.id, "--text", `<attached-image path="${saved.path}" />`], { env });
    await runControlMurage(["wait", "--bot", created.bot.id, "--timeout", "20"], { env });

    // an unmarked caller is a remote surface (the phone's door): shown only because a visible conversation names the picture
    const phoneGet = async (): Promise<number> => {
      const started = performance.now();
      const answer = await fetch(`${session.info.url}/api/attachments/${name}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("private, no-cache");
      await answer.arrayBuffer();
      return performance.now() - started;
    };
    // a name no build stores (a bot's markdown image such as /api/attachments/chart.png): the phone asks for it on every view of that chat
    const phoneMissGet = async (): Promise<number> => {
      const started = performance.now();
      const answer = await fetch(`${session.info.url}/api/attachments/chart.png`);
      expect(answer.status).toBe(404);
      await answer.arrayBuffer();
      return performance.now() - started;
    };
    const median = async (get: () => Promise<number>): Promise<number> => {
      // a restarted server finishes its startup work first; three answers warm it, nine are timed
      await new Promise(resolve => setTimeout(resolve, 2000));
      for (let i = 0; i < 3; i++) await get();
      const times: number[] = [];
      for (let i = 0; i < 9; i++) times.push(await get());
      return times.sort((a, b) => a - b)[4]!;
    };
    // both answers are measured on a freshly restarted server; the history is written while it is stopped, as a long-used install is
    await session.stop();
    await session.restart();
    const short = await median(phoneGet);
    const shortMiss = await median(phoneMissGet);
    await session.stop();
    const side = new DatabaseSync(join(session.info.dataDir, "messages.db"));
    try {
      const put = side.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', NULL, ?)");
      side.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < HISTORY_ROWS; i++) {
        put.run(`t-history-${i % 50}`, `h-${i}`, i, JSON.stringify({ id: `h-${i}`, role: "user", kind: "text", text: `an older line ${i}${FILLER}`, at: i }));
      }
      side.exec("COMMIT");
    } finally { side.close(); }
    await session.restart();
    const long = await median(phoneGet);
    const longMiss = await median(phoneMissGet);
    expect(long, `median phone GET ${short.toFixed(1)} ms with a short history, ${long.toFixed(1)} ms with ${HISTORY_ROWS} rows`).toBeLessThan(short + 40);
    expect(longMiss, `median phone GET of an unknown name ${shortMiss.toFixed(1)} ms with a short history, ${longMiss.toFixed(1)} ms with ${HISTORY_ROWS} rows`).toBeLessThan(shortMiss + 20);
  } finally { await session.close(); }
}, 240000);
