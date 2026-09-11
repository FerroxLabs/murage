// The decision log is only as good as its wiring: every row is written at
// the request.opened fold or in answerRequest, and both of those keep
// working (cards keep appearing, approvals keep flowing) even when the
// logging silently rots away. So, in the style of unattended.test.ts,
// these run the real server against the fake ACP CLI and assert the ROWS,
// not the behavior the rows describe:
//
//   1. a rule-matched auto-approval writes a row naming the rule
//   2. a card and the human's answer write two rows (allow and deny)
//   3. an unattended block writes its row — the audit row that says "this
//      would have auto-approved, and only the block stood in the way"
//   4. GET /api/decisions pages newest-last with ?limit=
//   5. a question tool (AskUserQuestion) reaches the owner as a card with a
//      `question-tool` row — never auto-approved, remembered or reviewed
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let base: string;
let desktopHeaders: Record<string, string>;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
// Normal sends, answers and reads remain on the unmarked remote surface.
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);

/** Newest matching decision row, or null when none shows up in time. */
async function waitForDecision(pred: (r: DecisionRow) => boolean, ms = 30_000): Promise<DecisionRow | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { body } = await api("GET", "/api/decisions");
    const rows: DecisionRow[] = body.decisions ?? [];
    const row = rows.filter(pred).at(-1);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A live permission card on a bot's transcript (via /api/bots — the same
 * poll unattended.test.ts uses, since a bot's card lives on its thread). */
async function waitForBotCard(botId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots");
    const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
    const card = bot?.messages?.find(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && !m.card.answered,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A live permission card on a THREAD — webhook turns run in detached
 * tasks, so their cards never appear on the bot's open conversation. */
async function waitForThreadCard(threadId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", `/api/threads/${threadId}/messages`);
    const card = (body.messages ?? []).find(
      (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The detached task a webhook delivery created. */
async function waitForRunThread(runId: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    if (run?.threadId) return run.threadId as string;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A bot whose fake engine asks permission to run `echo hi` (the ACP core
 * folds that to tool "shell", summary "echo hi" — so the always-allow key
 * is "shell:echo"). */
async function makePermissionBot(patch: Record<string, unknown>) {
  const created = await api("POST", "/api/bots", { modelSelection: { instanceId: "grok", model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
    ...patch,
    modelSelection: { instanceId: "grok", model: "fake-model" },
    // Auto on a bot that never chose a computer drives this Mac, so the
    // desktop dialog's acknowledgement rides along (AUTOOP2 finding 1).
    ...(patch.autoApprove === true ? { acknowledgeLocalAuto: true } : {}),
  });
  expect(patched.status).toBe(200);
  return patched.body.bot ?? bot;
}

posixOnly("authorization decisions are logged", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-decisions-e2e-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // an engine that routes its AskUserQuestion tool through the
          // permission request, the way Claude Code reaches the permission host
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "question-tool" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    expect(proof.body.secret).toMatch(/^[a-f0-9]{64}$/);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    expect((await api("GET", "/api/config")).body.surface).toBe("remote");
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "a rule-matched auto-approval writes a row naming the rule",
    async () => {
      const bot = await makePermissionBot({ name: "Granted", alwaysAllow: ["shell:echo"] });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "auto-approved" && r.botId === bot.id);
      expect(row, "the auto-approval never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("always-allow");
      expect(row!.rule).toBe("shell:echo");
      expect(row!.tool).toBe("shell");
      expect(row!.summary).toBe("echo hi");
      expect(row!.botName).toBe("Granted");
      expect(row!.threadId).toBeTruthy();
      expect(row!.requestId).toBeTruthy();
    },
    60_000,
  );

  it(
    "a card and the human's allow write two rows",
    async () => {
      const bot = await makePermissionBot({ name: "Askme" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card, "no approval card ever appeared").not.toBeNull();
      const requestId = card.card.requestId as string;

      const shown = await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId);
      expect(shown, "the card was shown but never logged").not.toBeNull();
      expect(shown!.source).toBe("no-grant");
      expect(shown!.botId).toBe(bot.id);
      expect(shown!.tool).toBe("shell");

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "allow" });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).not.toBe("unavailable");

      const user = await waitForDecision((r) => r.decision === "user-approved" && r.requestId === requestId);
      expect(user, "the human's answer never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
      expect(user!.tool).toBe("shell");
      expect(user!.summary).toBe("echo hi");
      expect(user!.botName).toBe("Askme");
    },
    90_000,
  );

  it(
    "a human deny writes its row too",
    async () => {
      const bot = await makePermissionBot({ name: "Refused" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card).not.toBeNull();
      const requestId = card.card.requestId as string;
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "deny" })).status).toBe(200);

      const user = await waitForDecision((r) => r.decision === "user-denied" && r.requestId === requestId);
      expect(user, "the denial never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
    },
    90_000,
  );

  it(
    "an unattended block writes the row that says a grant was withheld",
    async () => {
      // Auto mode on AND the exact key granted: an attended turn would sail
      // straight through, so the only thing carding this one is the
      // unattended block — which is precisely what the row must say.
      const bot = await makePermissionBot({ name: "Nightshift", autoApprove: true, alwaysAllow: ["shell:echo"] });

      const hook = await desktopApi("POST", "/api/webhooks", {
        name: "Nightly build",
        prompt: "Handle the incoming build event",
        botId: bot.id,
        runOn: "ember",
      });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);
      const { runId } = (await delivered.json()) as { runId: string };

      const threadId = await waitForRunThread(runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();
      const card = await waitForThreadCard(threadId!);
      expect(card, "the webhook turn auto-approved instead of asking").not.toBeNull();

      const row = await waitForDecision((r) => r.threadId === threadId && r.decision === "card-shown");
      expect(row, "the unattended block never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("unattended-block");
      expect(row!.rule).toBe("shell:echo");
      expect(row!.unattended).toBe(true);
      expect(row!.botId).toBe(bot.id);
    },
    90_000,
  );

  it(
    "a question tool is never auto-approved, remembered or reviewed (ASK1)",
    async () => {
      // Auto mode on, the reviewer in enforce, and a grant for the question
      // tool itself: the live configuration of every bot that hit the defect.
      const created = await api("POST", "/api/bots", { modelSelection: { instanceId: "asker", model: "fake-model" } });
      expect(created.status).toBe(201);
      const patched = await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, {
        name: "Curious",
        autoApprove: true,
        acknowledgeLocalAuto: true, // default computer = this Mac (AUTOOP2 finding 1)
        autoReview: "enforce",
        alwaysAllow: ["AskUserQuestion", "local-computer:AskUserQuestion", "shell:echo"],
        modelSelection: { instanceId: "asker", model: "fake-model" },
      });
      expect(patched.status).toBe(200);
      const bot = patched.body.bot;
      // the settings route drops question grants instead of storing them
      expect(bot.alwaysAllow).toEqual(["shell:echo"]);

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "ask me" })).status).toBe(202);
      const card = await waitForBotCard(bot.id);
      expect(card, "the question was answered by a rule instead of reaching the owner").not.toBeNull();
      const requestId = card.card.requestId as string;
      expect(card.card.tool).toBe("AskUserQuestion");
      expect(card.card.allowKey, "a question card must not offer Always allow").toBeUndefined();
      expect(card.card.held).toMatch(/question/i);

      const shown = await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId);
      expect(shown, "the question card was never logged").not.toBeNull();
      expect(shown!.source).toBe("question-tool");
      expect(shown!.botId).toBe(bot.id);

      // a key an older build rendered on the card cannot be granted either
      const grant = await desktopApi("POST", `/api/bots/${bot.id}/always-allow`, { allowKey: "AskUserQuestion" });
      expect(grant.status).toBe(400);
      expect(grant.body.error).toMatch(/questions cannot be always allowed/);

      expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "deny" })).status).toBe(200);
      expect(await waitForDecision((r) => r.decision === "user-denied" && r.requestId === requestId)).not.toBeNull();

      const rows = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
      const machine = rows.filter(
        (r) => r.botId === bot.id && (r.decision === "auto-approved" || r.decision.startsWith("review-")),
      );
      expect(machine, "a rule or the reviewer decided a question").toEqual([]);
    },
    90_000,
  );

  it("GET /api/decisions pages newest-last and validates limit", async () => {
    const all = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const one = (await api("GET", "/api/decisions?limit=1")).body.decisions as DecisionRow[];
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual(all.at(-1));
    expect((await api("GET", "/api/decisions?limit=0")).status).toBe(400);
    expect((await api("GET", "/api/decisions?limit=nope")).status).toBe(400);
  });
});
