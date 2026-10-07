// "Can talk to" through the real HTTP route on a real server with its own data dir.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const PHONE_TOKEN = "ab12cd34".repeat(8);
const phone = { "x-murage-companion-token": PHONE_TOKEN };
let fixture: VerificationServer, desktop: Record<string, string> = {};
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as any };
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: PHONE_TOKEN } });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);
afterAll(async () => { await fixture?.close(); });

const make = async (name: string, section: string) => {
  const bot = (await call("POST", "/api/bots", { name })).body.bot;
  await call("PATCH", `/api/bots/${bot.id}`, { section });
  return bot;
};
const allow = async (id: string) => (await call("GET", "/api/bots")).body.bots.find((b: any) => b.id === id).messageAllow;
const put = (id: string, body: unknown, headers?: Record<string, string>) => call("PATCH", `/api/bots/${id}/message-allow`, body, headers);

it("adding a pick or switching to Everyone never deletes the other bot's own grant (CT-03), and unpicking keeps it (CT-02)", async () => {
  const a = await make("CtA", "Creator"), b = await make("CtB", "Sales");
  await put(b.id, { mode: "list", botIds: [a.id] });
  await put(a.id, { mode: "list", botIds: [b.id] });
  expect(await allow(b.id)).toMatchObject({ mode: "list", botIds: [a.id] });
  await put(a.id, { mode: "all" });
  expect(await allow(b.id)).toMatchObject({ mode: "list", botIds: [a.id] });
  await put(a.id, { mode: "team" });
  expect(await allow(b.id)).toMatchObject({ mode: "list", botIds: [a.id] });
}, 60000);

it("two-way writes the reverse grant on both sides; one-way, unpicking and My team remove only what it wrote", async () => {
  const a = await make("CtC", "Creator"), b = await make("CtD", "Sales"), c = await make("CtE", "Ops");
  await put(a.id, { mode: "list", botIds: [b.id, c.id], directions: { [b.id]: "two-way", [c.id]: "two-way" } });
  expect(await allow(b.id)).toMatchObject({ botIds: [a.id], grantedBy: [a.id] });
  await put(a.id, { mode: "list", botIds: [b.id, c.id], directions: { [b.id]: "one-way" } });
  expect(await allow(b.id)).toBeUndefined();
  expect(await allow(c.id)).toMatchObject({ botIds: [a.id] });
  await put(a.id, { mode: "team" });
  expect(await allow(c.id)).toBeUndefined();
}, 60000);

it("deleting a bot prunes it from every list, and the owner can still edit afterwards (CT-04)", async () => {
  const a = await make("CtF", "Creator"), b = await make("CtG", "Sales"), c = await make("CtH", "Ops");
  await put(a.id, { mode: "list", botIds: [b.id, c.id] });
  expect((await call("DELETE", `/api/bots/${b.id}`)).status).toBeLessThan(300);
  expect(await allow(a.id)).toMatchObject({ botIds: [c.id] });
  expect((await put(a.id, { mode: "list", botIds: [c.id, "gone-bot"] })).status).toBe(200);
  expect(await allow(a.id)).toMatchObject({ botIds: [c.id] });
}, 60000);

it("a phone can narrow to My team but cannot widen or change directions", async () => {
  const a = await make("CtI", "Creator"), b = await make("CtJ", "Sales");
  await put(a.id, { mode: "list", botIds: [b.id] });
  expect((await put(a.id, { mode: "all" }, phone)).status).toBe(403);
  expect((await put(a.id, { mode: "list", botIds: [b.id], directions: { [b.id]: "two-way" } }, phone)).status).toBe(403);
  expect((await put(a.id, { mode: "team" }, phone)).status).toBe(200);
  expect(await allow(a.id)).toBeUndefined();
}, 60000);
