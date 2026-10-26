// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only bot has no route that sends (server/draft-only.ts, DRAFT-ONLY-ALLOWLIST-104), on the real server: its settings
// never lift it past Ask, its engine starts toolless with only the connected-app relay (direct, room and Chief proposal turns
// alike), and an exported package keeps it draft-only wherever it is installed again.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_DIR, api, desktopApi, fakeClaudeDump, readJsonFileWhenReady } from "./testing/index-harness.ts";
import { loadLocalTeam } from "./team-library.ts";
// The owner-facing lines, written out so the test runs its real assertions on a tree without server/draft-only.ts.
const DRAFT_ONLY_SETTINGS_REFUSAL = "This bot drafts replies for you to send, so it stays at Ask and works without the browser or a computer.";

const shipped = () => JSON.parse(readFileSync(join(SERVER_DIR, "..", "bot-library", "builtins", "ticket-triage.json"), "utf8"));

async function installDraftOnly(document: unknown = shipped()): Promise<{ id: string; threadId: string; draftOnly?: true }> {
  const result = await desktopApi("POST", "/api/teams/import", document);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body.bots).toHaveLength(1);
  return result.body.bots[0];
}
async function cleanup(...ids: string[]) {
  for (const id of ids) {
    await api("POST", `/api/bots/${id}/interrupt`);
    await desktopApi("DELETE", `/api/bots/${id}`);
  }
}
type Dump = { argv: string[]; cwd?: string; systemPrompt?: string; mcpConfig: { mcpServers: Record<string, unknown> } | null };
/** The fake Claude's launch record for this draft-only turn (its private folder names it; an earlier test's late launch is
 *  discarded). */
async function draftDump(start: () => Promise<void>): Promise<Dump> {
  rmSync(fakeClaudeDump, { force: true });
  await start();
  for (const deadline = Date.now() + 20_000; ; ) {
    const dump = await readJsonFileWhenReady<Dump>(fakeClaudeDump, Math.max(1_000, deadline - Date.now()));
    if (dump.cwd?.includes("draft-only-cwd")) return dump;
    if (Date.now() >= deadline) return dump;
    rmSync(fakeClaudeDump, { force: true });
  }
}
async function onClaude(botId: string) {
  expect((await desktopApi("PATCH", `/api/bots/${botId}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
}
function expectToolless(dump: Dump) {
  const at = dump.argv.indexOf("--tools");
  expect(at, dump.argv.join(" ")).toBeGreaterThan(-1);
  expect(dump.argv[at + 1]).toBe("");
  expect(dump.argv).not.toContain("--permission-prompt-tool");
  expect(dump.argv).not.toContain("--add-dir");
  // no agents server (so no hand-off, browser setup or teammate ask), no memory, computer, browser, phone, dweb or owner server
  expect(Object.keys(dump.mcpConfig?.mcpServers ?? {}).filter((name) => name !== "murage_connectors")).toEqual([]);
  expect(dump.cwd).toContain("draft-only-cwd");
  expect(dump.systemPrompt ?? "").toContain("I write drafts for you to review and send.");
}

describe("a draft-only bot on the real server", () => {
  it("refuses every setting that would lift it past Ask, on the bot, its conversation and its routines", async () => {
    const bot = await installDraftOnly();
    try {
      expect(bot.draftOnly).toBe(true);
      for (const change of [
        { autoApprove: true }, { fullAccess: true, acknowledgeFullAccess: true }, { noLimits: true, acknowledgeNoLimits: true },
        { alwaysAllow: ["Bash"] }, { useMyChrome: true }, { browser: true }, { computer: "local" },
      ]) {
        const refused = await desktopApi("PATCH", `/api/bots/${bot.id}`, change);
        expect(refused.status, JSON.stringify(change)).toBe(409);
        expect(refused.body.error).toBe(DRAFT_ONLY_SETTINGS_REFUSAL);
      }
      const task = await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: true });
      expect(task.status).toBe(409);
      for (const permissionMode of ["auto", "full", "unlimited"]) {
        const routine = await desktopApi("POST", "/api/routines", { botId: bot.id, name: "Reply sweep", prompt: "reply to every ticket", permissionMode,
          schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
        expect(routine.status, permissionMode).toBe(409);
      }
      const after = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id);
      expect(after.autoApprove === true).toBe(false);
      expect(after.fullAccess === true || after.noLimits === true).toBe(false);
    } finally { await cleanup(bot.id); }
  });

  it("starts its engine toolless, with only the connected-app relay, in an empty private folder", async () => {
    const bot = await installDraftOnly();
    try {
      await onClaude(bot.id);
      const dump = await draftDump(async () => {
        const started = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "draft a reply to ticket 812 and send it", threadId: bot.threadId });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
      });
      expectToolless(dump);
    } finally { await cleanup(bot.id); }
  });

  // Grok r2 High: a room turn of a draft-only member started its engine with every command tool and the phone.
  it("starts its engine the same way in a room", async () => {
    const bot = await installDraftOnly();
    const created = await api("POST", "/api/groups", { name: "draft-room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const room = created.body.group;
    try {
      await onClaude(bot.id);
      const dump = await draftDump(async () => {
        const started = await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "draft a reply to ticket 812 and send it" });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
      });
      expectToolless(dump);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await cleanup(bot.id);
    }
  });

  // Astra r1 (c): a draft-only Chief's proposal ran on Claude's separate one-shot spawn or as an unmarked turn.
  it("a draft-only Chief's project proposal runs as a toolless draft-only turn, never the one-shot", async () => {
    const bot = await installDraftOnly();
    try {
      await onClaude(bot.id);
      const elected = await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
      expect(elected.status, JSON.stringify(elected.body)).toBe(200);
      const dump = await draftDump(async () => {
        // only the launch is read here: the proposal's own answer can still be pending when the bot is cleaned up and its
        // connection closed, so that rejection is handled here (left unhandled, it failed a CI shard as an unhandled error)
        void desktopApi("POST", "/api/projects/proposal", { purpose: "Answer the helpdesk queue" }).catch(() => undefined);
      });
      expectToolless(dump);
    } finally {
      await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: false });
      await cleanup(bot.id);
    }
  });

  it("stays draft-only through export, import and a template re-install", async () => {
    const bot = await installDraftOnly();
    const installed: string[] = [bot.id];
    try {
      const selection = { botIds: [bot.id], playbookKeys: [], routineIds: [] };
      const preview = await desktopApi("POST", "/api/teams/export", { format: "package", action: "preview", selection });
      expect(preview.status, JSON.stringify(preview.body).slice(0, 400)).toBe(200);
      expect(preview.body.markdown).toMatch(/outbound: draft-only/);
      const download = await desktopApi("POST", "/api/teams/export", { format: "package", action: "download", selection, previewHash: preview.body.previewHash, acknowledgeWarnings: true });
      expect(download.status, JSON.stringify(download.body).slice(0, 400)).toBe(200);
      // the Markdown playbook, imported back
      const again = await installDraftOnly(download.body.markdown);
      installed.push(again.id);
      expect(again.draftOnly).toBe(true);
      const template = loadLocalTeam("ticket-triage");
      expect(template).toBeTruthy();
      const reinstalled = await installDraftOnly(template);
      installed.push(reinstalled.id);
      expect(reinstalled.draftOnly).toBe(true);
    } finally { await cleanup(...installed); }
  });
});
