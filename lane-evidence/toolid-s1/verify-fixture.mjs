import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { launchVerificationServer, runControlMurage } from "../../scripts/control-murage.ts";
const evidence = new URL("./fixture.json", import.meta.url);
const fixture = await launchVerificationServer(process.env);
const result = { fixture: fixture.info, commands: [] };
try {
  const call = async (args) => {
    const command = [...args, "--url", fixture.info.url];
    const output = await runControlMurage(command);
    result.commands.push({ command, output });
    writeFileSync(evidence, JSON.stringify(result, null, 2));
    return output;
  };
  const doctor = await call(["doctor"]);
  if (!doctor.ok) throw new Error("fixture doctor failed");
  const created = await call(["new-bot", "--name", "S1 verification"]);
  await call(["send", "--bot", created.bot.id, "--text", "hello from isolated S1 fixture"]);
  const wait = await call(["wait", "--bot", created.bot.id, "--timeout", "30"]);
  if (wait.status !== "settled") throw new Error("fixture did not settle");
  const messages = await call(["messages", "--bot", created.bot.id, "--limit", "10"]);
  if (!messages.messages.some(m => m.role === "bot")) throw new Error("no fixture bot response");
  result.passed = true;
} finally {
  await fixture.close();
  copyFileSync(fixture.info.logPath, new URL("./fixture-server.log", import.meta.url));
  result.cleaned = !existsSync(fixture.info.dataDir);
  writeFileSync(evidence, JSON.stringify(result, null, 2));
}
