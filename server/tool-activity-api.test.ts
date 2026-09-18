// End to end, through the real harness: a bot whose engine routes every tool
// call through a wrapper must still produce a transcript that says which tool
// ran, and a failed tool must arrive with the engine's reason attached.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_ACP = join(fileURLToPath(new URL(".", import.meta.url)), "testing", "fake-acp-cli.ts");
let fixture: VerificationServer, headers: Record<string, string>;

const api = async (method: string, path: string, body?: unknown, owner = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(owner ? headers : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.wrapped={driver:'customAcp',displayName:'Wrapper tool fixture',config:{cli:${JSON.stringify(FAKE_ACP)}},environment:{FAKE_ACP_MODE:'wrapped-tool'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `,
  });
  const proof = await api("GET", "/api/desktop-secret", undefined, false);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30000);

afterAll(async () => { await fixture?.close(); });

it("shows which tool a wrapper engine ran, and why it failed", async () => {
  const created = await api("POST", "/api/bots", { name: "Tool visibility fixture", modelSelection: { instanceId: "wrapped", model: "agent-default" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "look something up" })).status).toBe(202);

  const failedChip = async () => {
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[];
    return messages.find(message => message.kind === "activity" && message.tool?.ok === false)?.tool;
  };
  await expect.poll(failedChip, { timeout: 20000 }).toBeTruthy();
  const chip = (await failedChip())!;

  // the engine called it `use_tool`; the transcript names the tool itself
  expect(chip.name).toBe("memory_search");
  expect(chip.summary).toBe("quarterly plan");
  expect(chip.errorDetails).toContain("Memory is not available for this turn.");
  expect(chip.errorDetails).toContain("search timed out after 5s");
}, 40000);
