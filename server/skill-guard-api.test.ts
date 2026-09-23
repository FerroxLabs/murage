// Skill Guard on the REAL harness routes: a library skill that needs a look
// lands installed but off, the switch refuses it until the owner has seen
// its findings, and then takes it with the acknowledgement of that content.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;

const verdicts = JSON.parse(readFileSync(fileURLToPath(new URL("../skills-library/scan-verdicts.json", import.meta.url)), "utf8")).skills as Record<string, { verdict: string }>;
const pick = (verdict: string) => Object.entries(verdicts).find(([, s]) => s.verdict === verdict)![0];

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30_000);

afterAll(async () => {
  await fixture?.close();
});

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(fixture.info.url + path, { method, headers: desktop, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

it("the shipped library has no Blocked skill", () => {
  expect(Object.values(verdicts).filter((s) => s.verdict === "blocked")).toEqual([]);
});

it("a library skill that needs a look lands off, and switches on only after its findings are acknowledged", async () => {
  const { body } = await api("POST", "/api/bots", { name: "Guarded", modelSelection: { instanceId: "verification", model: "fake" } });
  const bot = body.bot;
  const look = pick("review");
  const clean = pick("clean");

  const added = await api("POST", `/api/bots/${bot.id}/skills/library`, { ids: [clean, look] });
  expect(added.status).toBe(201);
  expect(added.body.needsLook).toEqual([look]);
  expect(added.body.blocked).toEqual([]);
  const listed = (await api("GET", `/api/bots/${bot.id}/skills`)).body.skills as Array<{ name: string; enabled: boolean; scan?: { verdict: string } }>;
  expect(listed.find((s) => s.name === clean)).toMatchObject({ enabled: true, scan: { verdict: "clean" } });
  expect(listed.find((s) => s.name === look)).toMatchObject({ enabled: false, scan: { verdict: "review" } });

  const refused = await api("PATCH", `/api/bots/${bot.id}/skills/${look}`, { enabled: true });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("needs-review");
  expect(refused.body.scan.findings.length).toBeGreaterThan(0);
  expect(refused.body.scan.contentHash).toMatch(/^[a-f0-9]{64}$/);

  expect((await api("PATCH", `/api/bots/${bot.id}/skills/${look}`, { enabled: true, acknowledged: "not-a-hash" })).status).toBe(400);
  expect((await api("PATCH", `/api/bots/${bot.id}/skills/${look}`, { enabled: true, acknowledged: "0".repeat(64) })).status).toBe(409);

  const accepted = await api("PATCH", `/api/bots/${bot.id}/skills/${look}`, { enabled: true, acknowledged: refused.body.scan.contentHash });
  expect(accepted.status).toBe(200);
  expect(accepted.body.skill.enabled).toBe(true);

  expect((await api("PATCH", `/api/bots/${bot.id}/skills/${look}`, { enabled: false })).status).toBe(200);
}, 60_000);
