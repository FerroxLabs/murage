// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const evidenceDir = process.env.MURAGE_PERMISSION_EVIDENCE_DIR;
function saveEvidence(name: string, content: string | Buffer): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, name), content);
}
let fixture: VerificationServer;
let desktop: Record<string, string>;
let model: string;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...desktop, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import { join } from 'node:path';
    process.env.FAKE_CLAUDE_PERM_TOOL = 'Write';
    process.env.FAKE_CLAUDE_PERM_INPUT_FILE = join(process.env.MURAGE_DATA_DIR, 'write-input.json');
    process.env.FAKE_CLAUDE_PERM_WRITE = '1';
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000';
  ` });
  const proof = await call("GET", "/api/desktop-secret");
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await call("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
  console.log("permission overwrite fixture", JSON.stringify(fixture.info));
}, 120_000);
afterAll(async () => {
  if (!fixture) return;
  await fixture.close();
  saveEvidence("fixture-server.log", readFileSync(fixture.info.logPath));
});

for (const kb of [40, 400]) {
  it(`lands an owner's card-approved ${kb} KB Write overwrite and preserves a denied overwrite`, async () => {
    const bot = (await call("POST", "/api/bots", { name: "Overwrite fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
    // Outside the bot workspace, inside the isolated data folder: always cards.
    const file = join(fixture.info.dataDir, `build-${kb}.py`);
    const before = "# existing file\n";
    const content = "# approved\n" + "x".repeat(kb * 1024) + "\né✓\n";
    writeFileSync(file, before);
    writeFileSync(join(fixture.info.dataDir, "write-input.json"), JSON.stringify({ file_path: file, content }));
    const messages = async () => (await call("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as any[];
    const send = async () => expect((await call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_permission_tool__" })).status).toBe(202);
    const card = async () => (await messages()).find((m) => m.kind === "options" && m.card?.requestId && m.card.answered === undefined);
    try {
      await send();
      await expect.poll(card, { timeout: 30_000 }).toBeTruthy();
      const opened = await card();
      expect(readFileSync(file, "utf8")).toBe(before);
      expect((await call("POST", `/api/threads/${bot.threadId}/respond`, { requestId: opened.card.requestId, behavior: "allow" })).status).toBe(200);
      await expect.poll(() => readFileSync(file, "utf8") === content, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => JSON.stringify(await messages()), { timeout: 30_000 }).toContain("permission: allowed");
      writeFileSync(join(fixture.info.dataDir, "write-input.json"), JSON.stringify({ file_path: file, content: "must not land" }));
      await send();
      await expect.poll(card, { timeout: 30_000 }).toBeTruthy();
      const denied = await card();
      expect((await call("POST", `/api/threads/${bot.threadId}/respond`, { requestId: denied.card.requestId, behavior: "deny" })).status).toBe(200);
      await expect.poll(async () => JSON.stringify(await messages()), { timeout: 30_000 }).toContain("permission: denied");
      expect(readFileSync(file, "utf8")).toBe(content);
      expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).env.MAX_MCP_OUTPUT_TOKENS).toBe(String(Number.MAX_SAFE_INTEGER));
    } finally {
      const transcript = await messages();
      saveEvidence(`overwrite-${kb}.json`, JSON.stringify({
        fixture: fixture.info, expectedBytes: Buffer.byteLength(content), actualBytes: readFileSync(file).length,
        landed: readFileSync(file, "utf8") === content, messages: transcript,
      }, null, 2));
    }
  }, 120_000);
}
