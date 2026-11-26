// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U15 #3102 through the real server: a Codex chat whose turn is refused with "try again at <date> <time>" records the reset
// the owner's clock names. The server runs in America/New_York; the hold lands in the server's own limit state file.
// - An hour the fall-back change repeats (1:50 AM on the first Sunday of November is 05:50Z EDT and 06:50Z EST) holds to the
//   later instant, so the hold never ends an hour before Codex lets the chat back in.
// - A time the spring-forward change skips (2:30 AM on the second Sunday of March) is 3:30 AM EDT.
// The dates are next year's: the server drops a recorded reset more than a day in the past, so a fixed year would expire.
// A time-only reset reads the server's own "now", which this fixture cannot place at a DST change; limit-refusal-3102.test.ts
// covers it at the parser.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
const LINEAGE_ALLOWANCE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "memory", "lineage-allowance.ts")).href;
const said = (time: string) => `You've hit your usage limit. Upgrade to Pro or try again at ${time}.`;
const YEAR = new Date().getUTCFullYear() + 1;
/** The nth Sunday of a month (UTC calendar day). */
const sunday = (month: number, nth: number) => 1 + (7 - new Date(Date.UTC(YEAR, month, 1)).getUTCDay()) % 7 + (nth - 1) * 7;
const FALL = sunday(10, 1), SPRING = sunday(2, 2);
const day = (n: number) => String(n).padStart(2, "0");
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const CASES = [
  { instanceId: "dstFold", time: `Nov ${nth(FALL)}, ${YEAR} 1:50 AM`, resetsAt: `${YEAR}-11-${day(FALL)}T06:50:00.000Z` },
  { instanceId: "dstGap", time: `Mar ${nth(SPRING)}, ${YEAR} 2:30 AM`, resetsAt: `${YEAR}-03-${day(SPRING)}T07:30:00.000Z` },
  { instanceId: "dstPlain", time: `Nov ${nth(FALL)}, ${YEAR} 2:30 AM`, resetsAt: `${YEAR}-11-${day(FALL)}T07:30:00.000Z` },
];
let fixture: VerificationServer, headers: Record<string, string>;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const recordedReset = (instanceId: string) => {
  const file = join(fixture.info.dataDir, "limit-state.json");
  const at = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[`engine:${instanceId}`]?.resetsAt : undefined;
  return typeof at === "number" ? new Date(at).toISOString() : at;
};

beforeAll(async () => {
  chmodSync(FAKE_CODEX, 0o755);
  fixture = await launchVerificationServer({ ...process.env, TZ: "America/New_York" }, undefined, { instrumentationSource: `
    (await import(${JSON.stringify(LINEAGE_ALLOWANCE)})).setLineageTimeBudgetForTest(null);
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const c of ${JSON.stringify(CASES.map(c => ({ instanceId: c.instanceId, text: said(c.time) })))})
      cfg.instances[c.instanceId]={driver:'codex',displayName:'Codex '+c.instanceId,environment:{FAKE_CODEX_MODE:'limit-text',FAKE_CODEX_LIMIT_TEXT:c.text},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const secret = await fetch(`${fixture.info.url}/api/desktop-secret`).then(r => r.json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
}, 120000);
afterAll(async () => { await fixture?.close(); });

it.each(CASES)("a Codex refusal saying try again at $time holds until $resetsAt", async ({ instanceId, time, resetsAt }) => {
  const created = await api("POST", "/api/bots", { name: "DST fixture", modelSelection: { instanceId, model: "gpt-fake-default" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `dst-${instanceId}` })).status).toBe(202);
  await expect.poll(() => recordedReset(instanceId) !== undefined, { timeout: 30000 }).toBe(true);
  expect(recordedReset(instanceId), `the hold for "${time}"`).toBe(resetsAt);
}, 60000);
