import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { redactSecrets } from "./redact.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const completeReplies = [
  [
    "Scout should verify the draft.\n<murage-goal>{\"status\":\"continue\",",
    "\"next\":\"Scout\",\"instruction\":\"Verify the draft and report evidence\",\"detail\":\"Draft prepared\"}</murage-goal>",
  ],
  "The draft is accurate and the cited evidence checks out.",
  "The verified draft is ready to ship.\n<murage-goal>{\"status\":\"completed\",\"detail\":\"Draft produced and independently verified.\"}</murage-goal>",
];

const loopReplies = Array.from({ length: 13 }, (_, index) =>
  index % 2 === 0
    ? `More work is needed.\n<murage-goal>{"status":"continue","next":"Looper","instruction":"Try approach ${index / 2 + 1}","detail":"Still working"}</murage-goal>`
    : `Approach ${Math.ceil(index / 2)} did not finish the task.`,
);

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

/** Writing a routine definition is desktop-only (server/index.ts:7139): an
 * interval schedule is a spawn schedule. The scheduled-goal cases below are
 * exercising goals, not the gate, so they speak as the renderer.
 * server/routine-write-gate.e2e.test.ts is where the gate itself is proven. */
const desktopApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-murage-surface": "desktop",
      "x-murage-surface-secret": DESKTOP_SECRET,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "murage-goal-run-"));
  const data = join(home, ".murage");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Goal run test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      complete: {
        driver: "claudeAgent",
        displayName: "Completing fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(completeReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "complete-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      loop: {
        driver: "claudeAgent",
        displayName: "Looping fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(loopReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "loop-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      crash: {
        driver: "claudeAgent",
        displayName: "Failing fixture",
        environment: { FAKE_CLAUDE_MODE: "exit-early" },
        config: { cli: FAKE_CLAUDE },
      },
      slow: {
        driver: "claudeAgent",
        displayName: "Queue fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify(["first response", "second response"]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "slow-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyGoal: {
        driver: "claudeAgent",
        displayName: "Busy goal fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLY_GATE: join(home, "release-busy-goal"),
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The unrelated direct task is complete.",
            "The queued team goal is complete.\n<murage-goal>{\"status\":\"completed\",\"detail\":\"Waited for the lead, then completed normally.\"}</murage-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-goal-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyWorkerLead: {
        driver: "claudeAgent",
        displayName: "Busy worker lead fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "I am delegating the research.\n<murage-goal>{\"status\":\"continue\",\"next\":\"Busy specialist\",\"instruction\":\"Research the answer and report evidence\",\"detail\":\"Waiting for specialist research.\"}</murage-goal>",
            "The specialist's evidence resolves the goal.\n<murage-goal>{\"status\":\"completed\",\"detail\":\"Specialist research incorporated after their direct task finished.\"}</murage-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-worker-lead-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      busyWorker: {
        driver: "claudeAgent",
        displayName: "Busy worker fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The unrelated direct research is complete.",
            "Evidence gathered for the coordinator.",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "busy-worker-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      stopScopedLead: {
        driver: "claudeAgent",
        displayName: "Stop-scoped lead fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "I am delegating this scheduled goal.\n<murage-goal>{\"status\":\"continue\",\"next\":\"Delayed worker\",\"instruction\":\"Finish the scheduled analysis\",\"detail\":\"Waiting for the delayed worker.\"}</murage-goal>",
            "This is unrelated direct work and should be stopped.",
            "The scheduled analysis is now complete.\n<murage-goal>{\"status\":\"completed\",\"detail\":\"Scheduled goal survived the coordinator's direct Stop.\"}</murage-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "stop-scoped-lead-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      stopScopedWorker: {
        driver: "claudeAgent",
        displayName: "Stop-scoped worker fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The worker's unrelated direct task completed naturally.",
            "Scheduled analysis returned to the coordinator.",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "stop-scoped-worker-replies.txt"),
          FAKE_CLAUDE_TRANSIENTS: "1",
          FAKE_CLAUDE_STATE: join(home, "stop-scoped-worker-launches.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      directHang: {
        driver: "claudeAgent",
        displayName: "Direct hang fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
      routineGoal: {
        driver: "claudeAgent",
        displayName: "Routine goal fixture",
        environment: {
          FAKE_CLAUDE_MODE: "slow",
          FAKE_CLAUDE_REPLIES: JSON.stringify([
            "The scheduled review is complete.\n<murage-goal>{\"status\":\"completed\",\"detail\":\"Scheduled team review completed.\"}</murage-goal>",
          ]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "routine-goal-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_STATIC_DIR: staticDir,
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("goal-driven channel runs", () => {
  it("returns to the lead until the goal is completed and appends a clean receipt", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Lead",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const scout = (await api("POST", "/api/bots", {
      name: "Scout",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch team",
      memberIds: [lead.id, scout.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    const sent = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Produce and verify the launch draft",
      mode: "goal",
      sendId: "goal_send_1234567890",
    });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ channelMode: "goal" });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 10_000 }).toMatchObject({
      status: "completed",
      coordinatorBotId: lead.id,
      turnCount: 3,
      detail: "Draft produced and independently verified.",
    }).catch(async (error: unknown) => {
      // Keep the exact turn budget. If a claimed turn retried before producing
      // a scripted reply, retain the isolated fixture evidence before cleanup.
      const snapshot = (await api("GET", "/api/bots?messages=60")).body;
      const current = snapshot.groups.find((candidate: { id: string }) => candidate.id === room.id);
      let replyCounter: string | null = null;
      try { replyCounter = readFileSync(join(home, "complete-replies.txt"), "utf8").slice(0, 32); } catch {}
      const diagnostics = {
        replyCounter,
        messages: (current?.messages ?? []).slice(-40).map((message: any) => ({
          kind: message.kind,
          from: message.from?.name,
          goalRun: message.goalRun,
          activity: message.kind === "activity" ? message.tool?.name : undefined,
        })),
        stderr: stderr.slice(-4000),
      };
      if (error instanceof Error) error.message += `\nIsolated goal fixture diagnostics: ${JSON.stringify(diagnostics).slice(0, 12000)}`;
      throw error;
    });

    const state = (await api("GET", "/api/bots?messages=30")).body;
    const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
    expect(current.messages.find((message: { kind: string }) => message.kind === "goal.run")?.text)
      .toBe("Goal completed: Draft produced and independently verified.");
    expect(current.working).toBe(false);
    expect(current.messages.filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
      .map((message: { from?: { name?: string } }) => message.from?.name)).toEqual(["Lead", "Scout", "Lead"]);
    expect(JSON.stringify(current.messages)).not.toContain("<murage-goal>");
  });

  it("waits for a busy coordinator without spending a goal turn, then completes on the same card", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Patient lead",
      modelSelection: { instanceId: "busyGoal", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Patient goal team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Finish this direct task first" })).status)
        .toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }).toBe(true);

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Complete this goal after your current work",
        mode: "goal",
      })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          count: cards.length,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
          busyBotId: current?.busyBotId,
        };
      }).toMatchObject({
        count: 1,
        status: "working",
        detail: expect.stringMatching(/finishing another conversation/i),
        turnCount: 0,
        busyBotId: null,
      });

      const waitingState = (await api("GET", "/api/bots?messages=30")).body;
      const waitingRoom = waitingState.groups.find((group: { id: string }) => group.id === room.id);
      const cardId = waitingRoom.messages.find((message: { kind: string }) => message.kind === "goal.run").id;

      // Keep the direct turn active until its queued goal is observed. A
      // fixed 800 ms reply can finish before slow Windows CI reads the card.
      writeFileSync(join(home, "release-busy-goal"), "release");

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          working: current?.working,
          count: cards.length,
          id: cards[0]?.id,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
        };
      }, { timeout: 10_000 }).toEqual({
        working: false,
        count: 1,
        id: cardId,
        status: "completed",
        detail: "Waited for the lead, then completed normally.",
        turnCount: 1,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("waits for a busy delegated worker, preserves its direct turn, then resumes the goal", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Worker coordinator",
      modelSelection: { instanceId: "busyWorkerLead", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const worker = (await api("POST", "/api/bots", {
      name: "Busy specialist",
      modelSelection: { instanceId: "busyWorker", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Busy specialist team",
      memberIds: [lead.id, worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${worker.id}/messages`, {
        text: "Complete this unrelated direct research first",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
      }).toBe(true);

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Research and resolve the team question",
        mode: "goal",
      })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
          roomBusyBotId: current?.busyBotId,
          workerDirectBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
        };
      }).toMatchObject({
        status: "working",
        detail: expect.stringMatching(/Busy specialist is finishing another conversation/i),
        turnCount: 1,
        roomBusyBotId: null,
        workerDirectBusy: true,
      });

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const currentWorker = state.bots.find((bot: { id: string }) => bot.id === worker.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          roomWorking: current?.working,
          cards: cards.length,
          status: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
          speakers: current?.messages
            .filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
            .map((message: { from?: { name?: string } }) => message.from?.name)
            .filter((name: string | undefined, index: number, names: Array<string | undefined>) =>
              name !== names[index - 1]
            ),
          workerDirectBusy: currentWorker?.busy,
          directFinishedNaturally: currentWorker?.messages.some((message: { text?: string }) =>
            message.text?.includes("reply to:")
          ),
        };
      }, { timeout: 10_000 }).toEqual({
        roomWorking: false,
        cards: 1,
        status: "completed",
        detail: "Specialist research incorporated after their direct task finished.",
        turnCount: 3,
        speakers: ["Worker coordinator", "Busy specialist", "Worker coordinator"],
        workerDirectBusy: false,
        directFinishedNaturally: true,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${worker.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
    }
  });

  it("stops a waiting goal without interrupting unrelated direct work, while chat still skips busy bots", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Occupied lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Scoped stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Keep this direct task running" })).status)
        .toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }).toBe(true);

      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ordinary room chat" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: current?.working,
          skipped: current?.messages.some((message: { tool?: { name?: string } }) =>
            /busy in another conversation.+skipped this round/i.test(message.tool?.name ?? "")
          ),
        };
      }).toEqual({ working: false, skipped: true });

      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Wait and run this as a goal",
        mode: "goal",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          roomWorking: current?.working,
          roomBusyBotId: current?.busyBotId,
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
        };
      }).toMatchObject({
        roomWorking: true,
        roomBusyBotId: null,
        status: "working",
        detail: expect.stringMatching(/finishing another conversation/i),
        turnCount: 0,
      });

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          roomWorking: current?.working,
          cards: cards.length,
          status: cards[0]?.goalRun?.status,
          turnCount: cards[0]?.goalRun?.turnCount,
          directBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }).toEqual({
        roomWorking: false,
        cards: 1,
        status: "stopped",
        turnCount: 0,
        directBusy: true,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops a detached scheduled goal from the active room and cancels its routine run", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Detached scheduled lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Detached stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await desktopApi("POST", "/api/routines", {
        name: "Hanging scheduled goal",
        prompt: "Keep this scheduled team goal running",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "ember",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        backgroundThreadId = running?.threadId ?? "";
        return {
          runStatus: running?.status,
          detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
          activeThreadId: current?.threadId,
          hasBackgroundTask: current?.tasks.some(
            (task: { threadId: string }) => task.threadId === running?.threadId,
          ),
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "running",
        detached: true,
        activeThreadId: originalThreadId,
        hasBackgroundTask: true,
        roomWorking: true,
        leadBusy: true,
      });

      // No task switch and no explicit thread: the ordinary room Stop must
      // discover the detached operation rather than targeting the visible task.
      expect((await api("POST", `/api/groups/${room.id}/interrupt`)).status).toBe(200);

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          runStatus: stopped?.status,
          runThreadId: stopped?.threadId,
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "cancelled",
        runThreadId: backgroundThreadId,
        activeThreadId: originalThreadId,
        roomWorking: false,
        leadBusy: false,
      });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops a detached scheduled goal from the coordinator's ordinary Stop", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Detached bot-stop lead",
      modelSelection: { instanceId: "directHang", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Detached bot-stop team",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await desktopApi("POST", "/api/routines", {
        name: "Coordinator-stopped scheduled goal",
        prompt: "Keep this detached goal running until the coordinator is stopped",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "ember",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        backgroundThreadId = running?.threadId ?? "";
        return {
          runStatus: running?.status,
          detached: Boolean(running?.threadId && running.threadId !== originalThreadId),
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "running",
        detached: true,
        activeThreadId: originalThreadId,
        roomWorking: true,
        leadBusy: true,
      });

      // The visible room still points at originalThreadId. Bot Stop must use
      // the detached operation's exact speaker thread, not that visible task.
      expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const stopped = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          runStatus: stopped?.status,
          runThreadId: stopped?.threadId,
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
        };
      }, { timeout: 10_000 }).toEqual({
        runStatus: "cancelled",
        runThreadId: backgroundThreadId,
        activeThreadId: originalThreadId,
        roomWorking: false,
        leadBusy: false,
      });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      expect(opened.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({ runId, status: "stopped", detail: "Stopped by you." }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("stops the coordinator's direct turn without cancelling a routine goal waiting on its worker", async () => {
    const diagnosticStartedAt = Date.now();
    const lead = (await api("POST", "/api/bots", {
      name: "Stop-scoped coordinator",
      modelSelection: { instanceId: "stopScopedLead", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const worker = (await api("POST", "/api/bots", {
      name: "Delayed worker",
      modelSelection: { instanceId: "stopScopedWorker", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Coordinator stop scope team",
      memberIds: [lead.id, worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    try {
      expect((await api("POST", `/api/bots/${worker.id}/messages`, {
        text: "Finish this unrelated worker task first",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy;
      }).toBe(true);

      const created = await desktopApi("POST", "/api/routines", {
        name: "Worker-gated scheduled goal",
        prompt: "Complete the scheduled analysis as a team",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "ember",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      let backgroundThreadId = "";
      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        backgroundThreadId = running?.threadId ?? "";
        return { status: running?.status, threadId: running?.threadId };
      }, { timeout: 10_000 }).toMatchObject({ status: "running", threadId: expect.any(String) });

      const opened = await api("POST", `/api/groups/${room.id}/tasks/${backgroundThreadId}`);
      expect(opened.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const card = current?.messages.find((message: { kind: string }) => message.kind === "goal.run");
        return {
          activeThreadId: current?.threadId,
          roomWorking: current?.working,
          status: card?.goalRun?.status,
          detail: card?.goalRun?.detail,
          turnCount: card?.goalRun?.turnCount,
          leadBusy: state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy,
          workerBusy: state.bots.find((bot: { id: string }) => bot.id === worker.id)?.busy,
        };
      }, { timeout: 10_000 }).toMatchObject({
        activeThreadId: backgroundThreadId,
        roomWorking: true,
        status: "working",
        detail: expect.stringMatching(/Delayed worker is finishing another conversation/i),
        turnCount: 1,
        leadBusy: false,
        workerBusy: true,
      }).catch(async (error: unknown) => {
        // Observe the failure before finally interrupts/deletes either bot.
        // Keep the exact waiting-state assertion and its original deadline.
        const diagnostics: Record<string, unknown> = { stderr: stderr.slice(-4000) };
        try {
          const state = (await api("GET", "/api/bots?messages=60")).body;
          const current = state.groups.find((group: { id: string }) => group.id === room.id);
          const messageMetadata = (message: any) => ({
            at: message.at, kind: message.kind, from: message.from?.name,
            goalRun: message.goalRun,
            activity: message.kind === "activity" ? message.tool?.name : undefined,
          });
          diagnostics.room = { threadId: current?.threadId, working: current?.working,
            messages: (current?.messages ?? []).slice(-30).map(messageMetadata) };
          diagnostics.bots = state.bots.filter((bot: { id: string }) => [lead.id, worker.id].includes(bot.id))
            .map((bot: any) => ({ id: bot.id, name: bot.name, threadId: bot.threadId, busy: bot.busy,
              messages: (bot.messages ?? []).slice(-20).map(messageMetadata) }));
        } catch { diagnostics.snapshotUnavailable = true; }
        diagnostics.counters = Object.fromEntries([
          "stop-scoped-lead-replies.txt", "stop-scoped-worker-replies.txt", "stop-scoped-worker-launches.txt",
        ].map((name) => { try { return [name, readFileSync(join(home, name), "utf8").slice(0, 32)]; }
          catch { return [name, null]; } }));
        try {
          const nativeDir = join(home, ".murage", "native");
          const files = readdirSync(nativeDir).filter((name) => name.endsWith(".ndjson"))
            .map((name) => ({ name, stat: statSync(join(nativeDir, name)) }))
            .filter(({ stat }) => stat.isFile() && stat.mtimeMs >= diagnosticStartedAt)
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 12);
          diagnostics.native = files.map(({ name, stat }) => {
            const fd = openSync(join(nativeDir, name), "r");
            const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024));
            let count: number;
            try { count = readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length)); }
            finally { closeSync(fd); }
            const records = tail.subarray(0, count).toString("utf8").split("\n").flatMap((line) => {
              try {
                const entry = JSON.parse(line);
                if (entry.source !== "claude.session" && !["system", "result", "error"].includes(entry.msg?.type)) return [];
                return [{ at: entry.at, source: entry.source, close: entry.msg?.close,
                  type: entry.msg?.type, subtype: entry.msg?.subtype, isError: entry.msg?.is_error,
                  stopReason: entry.msg?.stop_reason }];
              } catch { return []; }
            }).slice(-20);
            return { file: name, records };
          });
        } catch { diagnostics.nativeUnavailable = true; }
        if (error instanceof Error) error.message += `\nStop-scope fixture diagnostics: ${JSON.stringify(redactSecrets(diagnostics)).slice(0, 20000)}`;
        throw error;
      });

      expect((await api("POST", `/api/bots/${lead.id}/messages`, {
        text: "Start unrelated coordinator work",
      })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const currentLead = state.bots.find((bot: { id: string }) => bot.id === lead.id);
        return {
          busy: currentLead?.busy,
          directReplyStarted: currentLead?.messages.some((message: { text?: string }) =>
            message.text?.includes("This is unrelated direct work and should be stopped.")
          ),
        };
      }).toEqual({ busy: true, directReplyStarted: true });

      // The ordinary bot Stop belongs to the direct claim made above. The
      // coordinator is no longer an active participant in the waiting room
      // operation, so this must not cancel the scheduled team goal.
      expect((await api("POST", `/api/bots/${lead.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=30")).body;
        return state.bots.find((bot: { id: string }) => bot.id === lead.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      // The worker may settle and advance the room while Stop is in flight.
      // Either in-progress or already-completed is valid; cancellation/stopped
      // is the regression this snapshot must exclude.
      const afterStopCalendar = (await api("GET", "/api/routines")).body;
      const afterStopRun = afterStopCalendar.runs.find((run: { id: string }) => run.id === runId);
      const afterStopState = (await api("GET", "/api/bots?messages=30")).body;
      const afterStopRoom = afterStopState.groups.find((group: { id: string }) => group.id === room.id);
      const afterStopCard = afterStopRoom.messages.find((message: { kind: string }) => message.kind === "goal.run");
      expect(["running", "completed"]).toContain(afterStopRun.status);
      expect(["working", "completed"]).toContain(afterStopCard.goalRun.status);
      expect(afterStopCard.goalRun.status).not.toBe("stopped");

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const completed = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=30")).body;
        const current = state.groups.find((group: { id: string }) => group.id === room.id);
        const cards = current?.messages.filter((message: { kind: string }) => message.kind === "goal.run") ?? [];
        return {
          runStatus: completed?.status,
          output: completed?.output,
          roomWorking: current?.working,
          cards: cards.length,
          goalStatus: cards[0]?.goalRun?.status,
          detail: cards[0]?.goalRun?.detail,
          turnCount: cards[0]?.goalRun?.turnCount,
        };
      }, { timeout: 15_000 }).toEqual({
        runStatus: "completed",
        output: "Scheduled goal survived the coordinator's direct Stop.",
        roomWorking: false,
        cards: 1,
        goalStatus: "completed",
        detail: "Scheduled goal survived the coordinator's direct Stop.",
        turnCount: 3,
      });
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${worker.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${worker.id}`).catch(() => undefined);
    }
  });

  it("runs a routine as a goal in a new background room task", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Scheduled lead",
      modelSelection: { instanceId: "routineGoal", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Scheduled review team",
      memberIds: [lead.id],
      setup: { bulletin: "Review carefully.", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const originalThreadId = room.threadId;

    try {
      const created = await desktopApi("POST", "/api/routines", {
        name: "Daily team review",
        prompt: "Review the release as a team",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        runOn: "ember",
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
      });
      expect(created.status).toBe(201);
      expect(created.body.routine).toMatchObject({
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
      });

      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        const running = calendar.runs.find((run: { id: string }) => run.id === runId);
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          status: running?.status,
          threadId: running?.threadId,
          activeThreadId: backgroundRoom?.threadId,
          hasTask: backgroundRoom?.tasks.some(
            (task: { threadId: string }) => task.threadId === running?.threadId,
          ),
          working: backgroundRoom?.working,
        };
      }).toMatchObject({
        status: "running",
        threadId: expect.any(String),
        activeThreadId: originalThreadId,
        hasTask: true,
        working: true,
      });

      const runningCalendar = (await api("GET", "/api/routines")).body;
      const running = runningCalendar.runs.find((run: { id: string }) => run.id === runId);
      const openedWhileWorking = await api("POST", `/api/groups/${room.id}/tasks/${running.threadId}`);
      expect(openedWhileWorking.status).toBe(200);
      expect(openedWhileWorking.body.group).toMatchObject({
        threadId: running.threadId,
        working: true,
      });

      await expect.poll(async () => {
        const calendar = (await api("GET", "/api/routines")).body;
        return calendar.runs.find((run: { id: string }) => run.id === runId);
      }, { timeout: 10_000 }).toMatchObject({
        id: runId,
        status: "completed",
        target: "room-goal",
        groupId: room.id,
        botId: lead.id,
        output: "Scheduled team review completed.",
        threadId: expect.any(String),
      });

      const calendar = (await api("GET", "/api/routines")).body;
      const completedRun = calendar.runs.find((run: { id: string }) => run.id === runId);
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const backgroundRoom = state.groups.find((group: { id: string }) => group.id === room.id);
      expect(backgroundRoom.threadId).toBe(completedRun.threadId);
      expect(backgroundRoom.tasks).toContainEqual(expect.objectContaining({
        threadId: completedRun.threadId,
        title: "Daily team review",
      }));

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${completedRun.threadId}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.messages.filter((message: { kind: string }) => message.kind === "goal.run"))
        .toEqual([
          expect.objectContaining({
            goalRun: expect.objectContaining({
              runId,
              status: "completed",
              coordinatorBotId: lead.id,
              detail: "Scheduled team review completed.",
            }),
          }),
        ]);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("POST", `/api/bots/${lead.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${lead.id}`).catch(() => undefined);
    }
  });

  it("pauses a non-converging team at the hard turn limit", async () => {
    const looper = (await api("POST", "/api/bots", {
      name: "Looper",
      modelSelection: { instanceId: "loop", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Bounded team",
      memberIds: [looper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: looper.id } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Keep trying forever",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=40")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 15_000 }).toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
  });

  it("never treats a failed provider turn as a completed goal", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Failing lead",
      modelSelection: { instanceId: "crash", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Failure checks",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Do not claim this succeeded",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=20")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    // the failed attempt is retried once, and a retry is a model call that
    // costs a turn like any other — so the honest count is two, still failed
    }, { timeout: 10_000 }).toMatchObject({ status: "failed", turnCount: 2 });
  });

  it("validates mode and binds it to the send id", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Mode checks",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello", mode: "forever" })).status).toBe(400);
    const body = { text: "quiet note", mode: "chat", sendId: "mode_send_1234567890" };
    expect((await api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(202);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, mode: "goal" })).status).toBe(409);

    const dm = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: { dm?: boolean }) => group.dm);
    if (dm) expect((await api("POST", `/api/groups/${dm.id}/messages`, { text: "goal", mode: "goal" })).status).toBe(400);
  });

  it("automatically dispatches channel messages queued during a running turn", async () => {
    const bot = (await api("POST", "/api/bots", {
      name: "Queue worker",
      modelSelection: { instanceId: "slow", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queue checks",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const firstSendId = "channel_queue_first_1234";
    const secondSendId = "channel_queue_second_123";

    const first = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "first request",
      sendId: firstSendId,
    });
    expect(first.status).toBe(202);
    expect(first.body.message).toMatchObject({ role: "user", text: "first request", sendId: firstSendId });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body;
      return state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.working;
    }).toBe(true);

    const queuedBody = { text: "second request", sendId: secondSendId };
    const queued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ queued: true, threadId: room.threadId });
    expect(queued.body.queueId).toEqual(expect.any(String));
    expect(queued.body.message).toBeUndefined();

    const retryWhileQueued = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(retryWhileQueued.body).toMatchObject({ queued: true, queueId: queued.body.queueId });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      const userLines = current?.messages.filter((message: { role?: string }) => message.role === "user") ?? [];
      return {
        working: current?.working,
        sends: userLines.map((message: { sendId?: string }) => message.sendId),
      };
    }, { timeout: 10_000 }).toEqual({ working: false, sends: [firstSendId, secondSendId] });

    const state = (await api("GET", "/api/bots?messages=30")).body;
    const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
    const firstUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === firstSendId);
    const secondUserAt = current.messages.findIndex((message: { sendId?: string }) => message.sendId === secondSendId);
    const firstReplyAt = current.messages.findIndex(
      (message: { role?: string }, index: number) => index > firstUserAt && message.role === "bot",
    );
    const secondReplyAt = current.messages.findIndex(
      (message: { role?: string }, index: number) => index > secondUserAt && message.role === "bot",
    );
    expect(firstUserAt).toBeGreaterThanOrEqual(0);
    expect(firstReplyAt).toBeGreaterThan(firstUserAt);
    expect(secondUserAt).toBeGreaterThan(firstReplyAt);
    expect(secondReplyAt).toBeGreaterThan(secondUserAt);
    expect(current.messages[secondUserAt]).toMatchObject({ queueId: queued.body.queueId });

    const retryAfterDrain = await api("POST", `/api/groups/${room.id}/messages`, queuedBody);
    expect(retryAfterDrain.body.message).toMatchObject({
      sendId: secondSendId,
      queueId: queued.body.queueId,
    });
  });
});
