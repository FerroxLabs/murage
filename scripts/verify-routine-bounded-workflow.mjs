// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlMurage } from "./control-murage.ts";
const out = join(process.cwd(), "s4-B-workflow"); mkdirSync(out, { recursive: true });
const commands = [], fixture = await launchVerificationServer(process.env, undefined, { turnLog: { replies: ["Bounded journal fixture reply."] } });
writeFileSync(join(out, "launch.json"), JSON.stringify(fixture.info, null, 2));
const env = { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir };
async function command(args, file) {
  const explicit = [...args, "--url", fixture.info.url];
  commands.push({ args: ["node", "--experimental-strip-types", "scripts/control-murage.ts", ...explicit], dataDir: fixture.info.dataDir });
  writeFileSync(join(out, "commands.json"), JSON.stringify(commands, null, 2));
  const result = await runControlMurage(explicit, { env });
  writeFileSync(join(out, file), JSON.stringify(result, null, 2)); return result;
}
try {
  const doctor = await command(["doctor"], "doctor.json");
  if (!doctor.ok) throw new Error("Fixture doctor unavailable");
  const created = await command(["new-bot", "--name", "Bounded journal verification"], "bot.json"), id = created.bot.id;
  await command(["send", "--bot", id, "--text", "Reply with the fake fixture response."], "send.json");
  const wait = await command(["wait", "--bot", id, "--timeout", "30"], "wait.json");
  if (wait.status !== "settled") throw new Error(`Fixture outcome ${wait.status}`);
  const messages = await command(["messages", "--bot", id, "--limit", "10"], "messages.json");
  if (!JSON.stringify(messages).includes("Bounded journal fixture reply.")) throw new Error("Missing fake reply");
  console.log(JSON.stringify({ ok: true, ...fixture.info, evidence: out, limitation: "The control surface has no mapped scheduler, approval-timeout, cancel/retry or zone-hold commands; those paths require the manager/journal suites." }));
} finally {
  await fixture.close();
  copyFileSync(fixture.info.logPath, join(out, "server.log"));
}
