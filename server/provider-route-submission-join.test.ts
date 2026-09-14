import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { ProviderConnectionsService } from "./provider-connections.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";

it("actual direct and room submission callbacks reject changed provider revision before memory acceptance", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const bodies = [...source.matchAll(/beforeSubmit: \(\) => submissionBoundary\.beforeSubmit\(\(\) => \{([\s\S]*?)\n\s*\}\),/g)].map(match => match[1]);
  expect(bodies).toHaveLength(2);
  const cacheDir = mkdtempSync(join(tmpdir(), "grok-submit-revision-"));
  let revision = "r1";
  const service = new ProviderConnectionsService({ cacheDir, readBank: () => JSON.stringify([{ id: "fixture", preset: "openai", label: "Fixture", enabled: true, key: "sk-proj-FAKE_ONLY", revision }]) });
  try {
    for (const body of bodies) {
      const callback = new Function("providerRouteIsCurrent", "providerRoute", "memoryReceipt", body);
      const current = (route?: { connectionId: string; revision: string }) => !route || service.isCurrent(route.connectionId, route.revision);
      const accepted = vi.fn(); const boundary = new TurnSubmissionBoundary(); boundary.started(); revision = "r2";
      expect(() => boundary.beforeSubmit(() => callback(current, { connectionId: "fixture", revision: "r1" }, { accepted }))).toThrow("changed before submission");
      expect(accepted).not.toHaveBeenCalled(); expect(() => boundary.assertNotRefused()).toThrow();
      const valid = new TurnSubmissionBoundary(); valid.started(); valid.beforeSubmit(() => callback(current, { connectionId: "fixture", revision: "r2" }, { accepted })); expect(accepted).toHaveBeenCalledTimes(1);
      // The new provider guard must not break memory acceptance on native/no-route turns.
      const native = new TurnSubmissionBoundary(); native.started(); native.beforeSubmit(() => callback(current, undefined, { accepted })); expect(accepted).toHaveBeenCalledTimes(2);
    }
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

it("owner key rotation during real Grok ACP setup prevents the old route from submitting", async () => {
  const fakeSource = readFileSync(new URL("./testing/fake-grok-provider-cli.ts", import.meta.url), "utf8");
  const needle = "selected = m.params.modelId; out(m.id, {}); continue;";
  expect(fakeSource.split(needle)).toHaveLength(2);
  const gated = fakeSource.replace(needle, `selected = m.params.modelId;
    writeFileSync(process.env.FAKE_GROK_GATE_READY!, 'ready');
    const deadline = Date.now() + 15000;
    while (!existsSync(process.env.FAKE_GROK_GATE_RELEASE!)) {
      if (Date.now() >= deadline) throw new Error('Fixture setup gate expired');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    out(m.id, {}); continue;`);
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root=process.env.MURAGE_DATA_DIR, cli=join(root,'fake-grok-gated.ts');
    writeFileSync(cli,${JSON.stringify(gated)},{mode:0o700});
    const file=join(root,'config.json'),cfg=JSON.parse(readFileSync(file,'utf8'));
    cfg.engineDiscovery='explicit';
    cfg.instances.grokVerification={driver:'grokAgent',environment:{FAKE_GROK_DUMP:join(root,'grok-dump.json'),FAKE_GROK_GATE_READY:join(root,'grok-ready'),FAKE_GROK_GATE_RELEASE:join(root,'grok-release')},config:{cli,fullAuto:false}};
    writeFileSync(file,JSON.stringify(cfg));
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=String(input);
      if(url==='https://api.openai.com/v1/models')return Promise.resolve(new Response(JSON.stringify({data:[{id:'gpt-5-fixture'}]})));
      if(url.startsWith('https://')){writeFileSync(join(root,'unexpected-provider-network'),'blocked');throw new Error('External network disabled in Grok join fixture');}
      return originalFetch(input,init);
    };
  ` });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown, owner = true) => {
    const res = await fetch(fixture.info.url + path, { method, headers: { ...(owner ? headers : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const proof = await api("GET", "/api/desktop-secret", undefined, false); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    const created = await api("POST", "/api/provider-connections/mutate", { action: "create", preset: "openai", label: "Grok gated fixture", key: "sk-proj-FAKE_GROK_OLD_KEY_ONLY" });
    expect(created.status).toBe(200); const connection = created.body.connections.find((row: any) => row.label === "Grok gated fixture");
    const catalog = await api("POST", `/api/provider-connections/${connection.id}/refresh`, {}); expect(catalog.status).toBe(200); expect(catalog.body.models[0].chatEligible).toBe(true);
    const made = await api("POST", "/api/bots", { name: "Grok submission fixture", modelSelection: { instanceId: "grokVerification", model: "gpt-5-fixture", connectionId: connection.id } });
    expect(made.status, JSON.stringify(made.body)).toBe(201); const bot = made.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", autoApprove: false, composio: false })).status).toBe(200);
    const submitted = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold before provider submission" });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "grok-ready")), { timeout: 10000 }).toBe(true);
    const mutation = { action: "update", id: connection.id, revision: connection.revision, key: "sk-proj-FAKE_GROK_NEW_KEY_ONLY" };
    expect((await api("POST", "/api/provider-connections/mutate", mutation, false)).status).toBe(404);
    const changed = await api("POST", "/api/provider-connections/mutate", mutation); expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.connections.find((row: any) => row.id === connection.id).revision).not.toBe(connection.revision);
    writeFileSync(join(fixture.info.dataDir, "grok-release"), "release");
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === bot.id)?.busy, { timeout: 10000 }).toBe(false);
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "grok-dump.json"), "utf8"));
    expect(dump.calls.some((call: any) => call.method === "session/set_model")).toBe(true);
    expect(dump.calls.some((call: any) => call.method === "session/prompt")).toBe(false);
    expect(dump.calls.some((call: any) => call.method === "authenticate")).toBe(false);
    expect(dump.nativeFallback).toBeNull();
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    expect(existsSync(join(fixture.info.dataDir, "unexpected-provider-network"))).toBe(false);
    expect(JSON.stringify(changed.body)).not.toContain("FAKE_GROK_");
  } finally { await fixture.close(); }
}, 30000);
