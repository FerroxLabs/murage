// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Smoke the isolated server through the documented control surface. Payload
// verdicts are proven separately by the reader suite; no payload is executed.
import assert from "node:assert/strict";
import { copyFileSync, writeFileSync } from "node:fs";
import { launchVerificationServer, runControlMurage } from "./control-murage.ts";

const evidence = new URL("../evidence/cfix-toolid-s4a/", import.meta.url);
const fixture = await launchVerificationServer(process.env);
const commands: unknown[] = [];
try {
  writeFileSync(new URL("fixture.json", evidence), JSON.stringify(fixture.info, null, 2) + "\n");
  const run = async (args: string[]) => {
    const result = await runControlMurage([...args, "--url", fixture.info.url]);
    commands.push({ args, result });
    writeFileSync(new URL("fixture-commands.json", evidence), JSON.stringify(commands, null, 2) + "\n");
    return result;
  };
  assert.equal((await run(["doctor"]) as { ok: boolean }).ok, true);
  const created = await run(["new-bot", "--name", "Reader verification"]);
  const botId = (created as { bot: { id: string } }).bot.id;
  await run(["send", "--bot", botId, "--text", "Say fixture ready."]);
  const waited = await run(["wait", "--bot", botId, "--timeout", "30"]);
  assert.equal((waited as { status: string }).status, "settled");
  const transcript = await run(["messages", "--bot", botId, "--limit", "10"]);
  assert.ok((transcript as { messages: { role: string; text?: string }[] }).messages.some(
    message => message.role === "bot" && message.text === "hello from fake claude"));
} finally {
  await fixture.close();
  copyFileSync(fixture.info.logPath, new URL("fixture-server.log", evidence));
}
