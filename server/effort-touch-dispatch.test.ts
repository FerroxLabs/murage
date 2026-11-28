// ACP-EFFORT-PER-MODEL-1023 X6b (L4): every turn that resumes a durable task cursor goes through startTurn, which attaches the touch record.
// Real server, real Store, real fake ACP process; Murage restarts between two turns, so only the durable record can tell the engine
// that the retained session was never changed. No provider is contacted. A delegated handoff opens its own task per request, so it never
// reuses a cursor; the owner's send to the same task is the real startTurn caller with a retained session (shared-work rooms use the same call).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, desktop: Record<string, string>;
const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const signIn = async () => {
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const until = async <T>(read: () => T | undefined, what: string): Promise<T> => {
  for (const started = Date.now(); Date.now() - started < 40000; await new Promise(resolveWait => setTimeout(resolveWait, 100))) { const value = read(); if (value !== undefined) return value; }
  throw new Error(`timed out waiting for ${what}`);
};
const receipts = () => {
  try { return readFileSync(join(fixture.info.dataDir, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>); }
  catch { return []; }
};
const thinkingSets = () => receipts().filter(row => row.method === "session/set_config_option" && row.configId === "thinking");
const promptsFor = (tag: string) => receipts().filter(row => row.method === "session/prompt" && String(row.promptText).includes(tag));

describe.skipIf(process.platform === "win32")("X6b restart then Engine decides on a retained session", () => {
  beforeAll(async () => {
    const cli = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), "testing/fake-custom-acp-models.ts"))}`;
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const { customAcpSupport: localFixtureHost } = await import(${JSON.stringify(new URL("./drivers/acp/custom.ts", import.meta.url).href)}); localFixtureHost.fluxReach = () => "elsewhere";
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      const fs = await import('node:fs'); const path = await import('node:path');
      const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.thinking = { driver: 'customAcp', displayName: 'Thinking fixture',
        config: { cli: ${JSON.stringify(cli)}, fullAuto: false },
        environment: { FAKE_CUSTOM_ACP_DIRECTORY: process.env.MURAGE_DATA_DIR } };
      fs.writeFileSync(file, JSON.stringify(cfg));
    ` });
    await signIn();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("the second send resumes the same engine session with no thinking frame and no new session", async () => {
    expect((await fetch(`${fixture.info.url}/api/instances?fresh=1`, { headers: desktop })).status).toBe(200);
    const peer = (await post("/api/bots", { name: "Peer", modelSelection: { instanceId: "thinking", model: "glm-5.3" } })).body.bot as { id: string; threadId: string };
    expect((await post(`/api/bots/${peer.id}`, { computer: "off", browser: false, composio: false }, desktop, "PATCH")).status).toBe(200);
    const send = async (tag: string) => {
      const sent = await post(`/api/bots/${peer.id}/messages`, { text: `Do the work. ${tag}` });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      return until(() => promptsFor(tag)[0], `the peer prompt ${tag}`);
    };
    const first = await send("ACPT_ONE");
    await fixture.restart();
    await signIn();
    const second = await send("ACPT_TWO");
    // the retained session was never changed, so the durable record says clean: the same session, no thinking frame, no replacement session
    // (discovery probes open sessions of their own, so the count is of sessions that carried a prompt)
    expect(second.sessionId, JSON.stringify(receipts().map(row => [row.method, String(row.sessionId).slice(0, 4), row.configId, row.value]))).toBe(first.sessionId);
    expect([...new Set(receipts().filter(row => row.method === "session/prompt").map(row => row.sessionId))]).toEqual([first.sessionId]);
    expect(thinkingSets()).toHaveLength(0);
  }, 150_000);
});
