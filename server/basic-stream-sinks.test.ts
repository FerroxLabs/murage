import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

/** S1 policy smoke at the supported isolated application boundary. Full
 * transport coverage and runtime-box mutation proof belong to S5. */
it("S1 isolated fixture launches and drives a fake-engine turn", async () => {
  const session = await launchVerificationServer(process.env, undefined, { turnLog: { replies: ["Hello there.\nordinary fixture reply"] } });
  const env = { MURAGE_URL: session.info.url };
  const evidence: Record<string, unknown> = { fixture: session.info, commands: [] };
  const call = async (args: string[]) => {
    (evidence.commands as unknown[]).push(args);
    return await runControlMurage([...args, "--url", session.info.url], { env }) as any;
  };
  try {
    evidence.doctor = await call(["doctor"]);
    const created = await call(["new-bot", "--name", "S1 masking probe"]), id = created.bot.id;
    evidence.send = await call(["send", "--bot", id, "--text", "Run the deterministic fixture reply"]);
    const settled = await call(["wait", "--bot", id, "--timeout", "30"]);
    evidence.wait = settled; expect(settled.status).toBe("settled");
    const messages = await call(["messages", "--bot", id, "--limit", "10"]);
    evidence.messages = messages;
    expect(JSON.stringify(messages)).toContain("ordinary fixture reply");
  } finally {
    await session.close();
    evidence.cleaned = !existsSync(session.info.dataDir);
    if (existsSync(".s1-evidence")) {
      writeFileSync(".s1-evidence/fixture.json", JSON.stringify(evidence, null, 2));
      writeFileSync(".s1-evidence/fixture-server.log", readFileSync(session.info.logPath));
    }
  }
  expect(existsSync(session.info.dataDir)).toBe(false);
}, 120_000);
