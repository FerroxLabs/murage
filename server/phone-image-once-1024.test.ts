// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A paired phone's GET /api/attachments/<name> reads the attachment-name index once per request (MAIN-RULING 2026-11-25T15:34:47Z (4)): the
// route used to ask it before the read, after it and again before the first byte, so a picture many messages name cost three times its
// references. The count is taken inside the real server by wrapping the one statement that reads the index; what the caller may see, a Remove
// marker and a pending deletion are still asked live each time (attachment-serve.test.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const COUNT_FILE = ".attachment-index-reads";

it("a phone image GET reads the attachment-name index once, answers 200, and a hidden name still answers 404", async () => {
  const session = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path'); const sqlite = await import('node:sqlite');
    const file = path.join(process.env.MURAGE_DATA_DIR, ${JSON.stringify(COUNT_FILE)});
    const prepare = sqlite.DatabaseSync.prototype.prepare;
    sqlite.DatabaseSync.prototype.prepare = function (sql, ...rest) {
      const statement = prepare.call(this, sql, ...rest);
      if (!String(sql).includes('FROM attachment_name WHERE name >=')) return statement;
      const all = statement.all.bind(statement);
      statement.all = (...args) => { fs.appendFileSync(file, 'read\\n'); return all(...args); };
      return statement;
    };
  ` });
  const env = { MURAGE_URL: session.info.url };
  try {
    const created = await runControlMurage(["new-bot", "--name", "Phone Image Once"], { env }) as { bot: { id: string; activeTaskId: string } };
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const upload = await fetch(`${session.info.url}/api/attachments?threadId=${created.bot.activeTaskId}`, { method: "POST", headers: { ...desktop, "content-type": "image/png" }, body: PNG });
    expect(upload.status).toBe(201);
    const saved = await upload.json() as { path: string };
    const name = saved.path.split(/[\\/]/).at(-1)!;
    await runControlMurage(["send", "--bot", created.bot.id, "--text", `<attached-image path="${saved.path}" />`], { env });
    await runControlMurage(["wait", "--bot", created.bot.id, "--timeout", "20"], { env });

    const countFile = join(session.info.dataDir, COUNT_FILE);
    const reads = (): number => existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter(Boolean).length : 0;
    // an unmarked caller is a remote surface: shown only because a visible conversation names the picture
    const before = reads();
    const answer = await fetch(`${session.info.url}/api/attachments/${name}`);
    expect(answer.status).toBe(200);
    await answer.arrayBuffer();
    expect(reads() - before, "index reads made by one remote GET").toBe(1);

    // the phone still cannot see a picture only a hidden conversation names
    const stray = "0f1e2d3c-4b5a-4968-8776-655443322110.png";
    const hidden = await fetch(`${session.info.url}/api/attachments/${stray}`);
    expect(hidden.status).toBe(404);
  } finally { await session.close(); }
}, 240000);
