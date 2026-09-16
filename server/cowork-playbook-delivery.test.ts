import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { B08_CASES } from "../src/e2e/b08-template-behavior-fixture.ts";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { parseBotPackage } from "./bot-package.ts";
import { installedPlaybookInstructions, selectInstalledPlaybooks } from "./installed-playbooks.ts";

const coworkPlan = () => parseBotPackage(JSON.parse(readFileSync(new URL("../bot-library/builtins/cowork.json", import.meta.url), "utf8"))).package.playbooks![0]!;
const turns = B08_CASES.filter(row => row.template === "cowork").flatMap(row => row.turns.map((text, turnIndex) => ({
  caseId: row.id, turnIndex, text, selected: row.scenario !== "unrelated-request",
})));

it("selects Cowork guidance for all frozen brief and recovery turns, not the unrelated request", () => {
  const book = coworkPlan();
  expect(turns).toHaveLength(7);
  expect(turns.filter(row => row.selected)).toHaveLength(6);
  for (const row of turns) {
    expect(selectInstalledPlaybooks(row.text, [book]).map(item => item.key), `${row.caseId}:${row.turnIndex}`)
      .toEqual(row.selected ? ["cowork"] : []);
    if (!row.selected) expect(installedPlaybookInstructions(row.text, [book])).toBe("");
  }
});

it("delivers imported and pinned Cowork guidance through server dispatch, including same-thread restart continuations", async () => {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
  let headers: Record<string, string> = {}, complete = false;
  const observations: Record<string, unknown>[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const authenticate = async () => {
    headers = {};
    const secret = (await api("GET", "/api/desktop-secret")).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  };
  const dump = () => {
    try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { prompt: unknown; systemPrompt: string | null }; }
    catch { return null; }
  };
  const strings = (value: unknown): string => typeof value === "string" ? value
    : Array.isArray(value) ? value.map(strings).join("\n")
    : value && typeof value === "object" ? Object.values(value).map(strings).join("\n") : "";
  try {
    await authenticate();
    const instance = (await api("GET", "/api/instances")).instances.find((row: any) => row.instanceId === "verification");
    const model = instance.models.options[0].id;
    const entry = (await api("GET", "/api/team-library/catalog")).teams.find((row: any) => row.slug === "cowork");
    expect(entry.adaptable).toBe(true);
    const bot = (await api("POST", "/api/bots", { name: "Cowork delivery", modelSelection: { instanceId: "verification", model } })).bot;
    await api("POST", `/api/bots/${bot.id}/assistant-profile`, { slug: "cowork", rename: false, profileReviewHash: entry.profileReviewHash });
    const book = coworkPlan(), threads = new Map<string, string>();
    for (const row of turns) {
      const group = row.caseId === "cowork/second-turn" ? "cowork/supplied-data" : row.caseId;
      let threadId = threads.get(group);
      const reusedThread = Boolean(threadId);
      if (!threadId) {
        threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Cowork delivery" })).task.threadId;
        threads.set(group, threadId!);
      }
      const restarted = row.caseId === "cowork/second-turn" || (row.caseId === "cowork/interruption-restart" && row.turnIndex === 1);
      if (restarted) { await fixture.restart(); await authenticate(); }
      await api("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=0`);
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: row.text });
      await expect.poll(() => strings(dump()?.prompt).includes(row.text), { timeout: 10_000 }).toBe(true);
      const system = dump()!.systemPrompt ?? "", mounted = system.includes(book.instructions);
      observations.push({
        caseId: row.caseId, turnIndex: row.turnIndex, threadId, reusedThread, restarted,
        query: row.text, expectedMounted: row.selected, actualMounted: mounted,
        profileReviewHash: entry.profileReviewHash,
        playbookSha256: createHash("sha256").update(book.instructions).digest("hex"),
        systemPromptSha256: createHash("sha256").update(system).digest("hex"), systemPrompt: system,
      });
      expect(mounted, row.text).toBe(row.selected);
      if (row.selected) expect(system).toContain("<installed_package_playbooks>");
      else expect(system).not.toContain(`<playbook name=${JSON.stringify(book.name)}>`);
      await expect.poll(async () => Boolean((await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy), { timeout: 10_000 }).toBe(false);
    }
    const continuations = observations.filter(row => row.restarted);
    expect(continuations).toHaveLength(2);
    expect(continuations.every(row => row.reusedThread)).toBe(true);
    expect(observations).toHaveLength(7);
    complete = true;
  } finally {
    await fixture.close();
    if (process.env.MURAGE_B08_COWORK_EVIDENCE_FILE) writeFileSync(process.env.MURAGE_B08_COWORK_EVIDENCE_FILE, JSON.stringify({
      status: complete ? "PASS" : "FAILED",
      evidenceKind: "production Cowork adapt-existing import/pin/server dispatch to existing fake Claude CLI; second and recovery turns reuse their thread after server restart; initial fake turns completed normally, no native interruption or model behavior claim",
      observations, fixtureClosed: true, paidCalls: 0,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
}, 60_000);
