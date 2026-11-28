// Settings v10 A9-bots + G1: the Bots page "Move all" against the real server. The calls are the page's own
// (src/lib/bots-bulk.ts fetchMoveAllPlan / commitMoveAll, wired at src/components/BotsRosterLive.tsx); only the transport
// wrapper is local, and it throws the same { status, body } the renderer's api() throws (src/state/store.tsx).
// Owners: client half = roster (A9-bots), server half = core (G1, server/no-limits-review.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { commitMoveAll, fetchMoveAllPlan } from "@/lib/bots-bulk";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (path: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(fixture.info.url + path, { ...init, headers: { "content-type": "application/json", ...headers } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body;
};
const savedBots = (): Array<{ name: string; permissionExplicit?: boolean }> => {
  const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
  return Array.isArray(saved) ? saved : saved.bots;
};
const lowerNames = async (): Promise<string[]> => ((await api("/api/permissions/no-limits")).lower as Array<{ name: string; kind: string }>).filter((row) => row.kind === "bot").map((row) => row.name).sort();
const rows = (plan: { bots: Array<{ name: string; archived: boolean; levelCleared: unknown }> }) => plan.bots.map((bot) => [bot.name, bot.archived, bot.levelCleared]).sort();

beforeAll(async () => {
  // The owner default is No limits (the lead), with one Full access bot and one archived Auto bot the owner set themselves.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const store=new Store();
    const lead=store.createBot({name:'Fixture lead'},{seedMessages:false});store.setChiefOfStaff(lead.id,undefined,'workspace');
    store.patchBot(lead.id,{autoApprove:true,fullAccess:true,noLimits:true});
    const full=store.createBot({name:'Ada Full'},{seedMessages:false});store.patchBot(full.id,{autoApprove:true,fullAccess:true,noLimits:false,permissionExplicit:true});
    const auto=store.createBot({name:'Ben Auto'},{seedMessages:false});store.patchBot(auto.id,{autoApprove:true,fullAccess:false,noLimits:false,permissionExplicit:true,hidden:true});
  ` });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it("Move all opens the review: the plan names every lower bot, archived too, with a digest", async () => {
  const plan = await fetchMoveAllPlan(api).catch((error) => ({ failed: error.status ?? String(error) }) as never);
  expect(plan).toHaveProperty("bots");
  expect(rows(plan)).toEqual([["Ada Full", false, "full"], ["Ben Auto", true, "auto"]]);
  expect(String(plan.digest)).toMatch(/^[0-9a-f]{64}$/);
});

it("a review that no longer matches moves nothing and comes back with the list as it is now", async () => {
  const plan = await fetchMoveAllPlan(api).catch(() => ({ digest: "", bots: [], routines: [], chats: [] }));
  const outcome = await commitMoveAll(api, { ...plan, digest: "0".repeat(64) });
  expect(outcome.kind).toBe("changed");
  expect(savedBots().filter((bot) => bot.name !== "Fixture lead").map((bot) => [bot.name, bot.permissionExplicit]).sort()).toEqual([["Ada Full", true], ["Ben Auto", true]]);
  expect(outcome.kind === "changed" && outcome.plan.digest).toBe(plan.digest);
});

it("confirming the reviewed set moves exactly those bots, and the roster on disk and the status agree", async () => {
  // A missing plan route confirms with no reviewed set, so the confirm answer below is what goes red, not the plan GET.
  const plan = await fetchMoveAllPlan(api).catch(() => ({ digest: "", bots: [], routines: [], chats: [] }));
  const outcome = await commitMoveAll(api, plan);
  expect(outcome.kind).toBe("moved");
  expect(rows(plan)).toEqual([["Ada Full", false, "full"], ["Ben Auto", true, "auto"]]);
  expect(await lowerNames()).toEqual([]);
  expect(savedBots().filter((bot) => bot.name !== "Fixture lead").map((bot) => [bot.name, bot.permissionExplicit]).sort()).toEqual([["Ada Full", false], ["Ben Auto", false]]);
  expect(outcome.kind === "moved" && rows(outcome.plan)).toEqual([]);
  expect(rows(await fetchMoveAllPlan(api))).toEqual([]);
});
