import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse } from "./testing/sse.ts";

// Fake, repeated fixtures built at runtime so the repository holds no keys.
const values = [
  "SG" + "." + "A".repeat(22) + "." + "B".repeat(22) + "-" + "AS" + "IA" + "C".repeat(16),
  "py" + "pi-AgE" + "B".repeat(82) + "-" + "nt" + "n_" + "C".repeat(46),
  "AS" + "IA" + "FAKE".repeat(4),
  "sec" + "ret_" + "Ab3Cd5Ef7".repeat(4) + "Gh9Jk2L",
  "nt" + "n_" + "12345678901" + "Ab3Cd5E".repeat(5),
  "pp" + "lx-" + "a1b2c3d4".repeat(6),
  "AWS_SESSION_TOKEN=" + "IQ" + "oJb3JpZ2luX2Vj" + "Ab3Cd5Ef7+/".repeat(28) + "==",
];
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: values.map(value => `Fixture result: ${value}`) },
    instrumentationSource: `
      const fs=await import('node:fs'), path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.verification.environment={...cfg.instances.verification.environment,FAKE_CLAUDE_TEXT_ONLY:'1'};
      fs.writeFileSync(file,JSON.stringify(cfg));
      const {ClaudeDriver}=await import(${JSON.stringify(new URL("./drivers/claude.ts", import.meta.url).href)});
      const create=ClaudeDriver.create;
      ClaudeDriver.create=async function(...args){const instance=await create.apply(this,args);
        instance.adapter.onEvent(event=>{if(event.type==='item.completed'&&event.itemType==='assistant_text')fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'execution.txt'),event.text+'\\n');});return instance;};
    `,
  });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it.each(values.map((value, index) => [index, value] as const))("vendor fixture %i stays masked in SSE, transcript and event logs", async (index, value) => {
  const engines = (await api("GET", "/api/instances")).body.instances;
  const model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const made = await api("POST", "/api/bots", { name: "Vendor masking fixture", modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
  const stream = await openSse(fixture.info.url + "/api/events", headers);
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Show the fixture result." })).status).toBe(202);
    await stream.until(frame => frame.kind === "runtime" && frame.event.type === "turn.completed" && frame.event.threadId === bot.threadId, 30_000);
    const waitArgs = ["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url];
    const messageArgs = ["messages", "--bot", bot.id, "--limit", "10", "--url", fixture.info.url];
    const wait = await runControlMurage(waitArgs) as { status: string };
    expect(wait.status).toBe("settled");
    const transcript = await runControlMurage(messageArgs);
    expect(JSON.stringify(transcript)).not.toContain(value.slice(-8));
    // stdout is captured by the test runner outside the checkout; retain the
    // mapped control commands and resulting JSON required by verification.
    console.info("vendor-verification", JSON.stringify({ index, commands: [waitArgs, messageArgs], wait, transcript, logPath: fixture.info.logPath }));
    const page = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body;
    expect(readFileSync(join(fixture.info.dataDir, "execution.txt"), "utf8")).toContain(value);
    const outward = JSON.stringify({ frames: stream.frames, page });
    expect(outward).toContain("redacted");
    expect(outward).not.toContain(value.slice(-8));
    if (index < 2) {
      expect(outward).not.toContain("A".repeat(22));
      expect(outward).not.toContain("B".repeat(22));
    }
    expect(readFileSync(join(fixture.info.dataDir, "events", `${bot.threadId}.ndjson`), "utf8")).not.toContain(value.slice(-8));
  } finally { stream.close(); }
}, 60_000);
