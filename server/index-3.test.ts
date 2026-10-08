// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins a local fake engine and inert shadow
// entries so the suite is deterministic with or without agent CLIs installed
// and exercises the shadow-instance behavior end to end.
// Part 3 of 4.
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// These cases need connected apps, which run through Flux Router only: the
// harness points its build at a fake broker when this is set.
vi.hoisted(() => { process.env.MURAGE_TEST_FAKE_FLUX_BROKER = "1"; });

// These cases need connected apps, which run through Flux Router only: the
// harness points its build at a fake broker when this is set.
vi.hoisted(() => { process.env.MURAGE_TEST_FAKE_FLUX_BROKER = "1"; });
import { z } from "zod";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";
import { BASE, FAKE_CLAUDE_CLI, FIXTURE_ENGINE_OVERRIDES, ROOT, SERVER_DIR, WEBHOOK_BASE, api, boxStubPort, browserFixturePrelude, browserMount, browserNativeEvents, browserRegisterDelayMs, browserRpc, browserSession, desktopApi, expectStoppedTestServerCleanly, fakeClaudeDump, home, privateDesktopHeaders, readJsonFileWhenReady, setBrowserRegisterDelayMs, startInternalFixtureTurn, storedMessageCount, waitForIsolatedServer } from "./testing/index-harness.ts";
import { browserEngineRefusesHost } from "./testing/index-harness.ts";


describe("harness HTTP API", () => {
  it("opens one calendar room and posts the scheduled seed to everyone", async () => {
    const modelSelection = { instanceId: "ghost", model: "ghost-1" };
    const first = (await desktopApi("POST", "/api/bots", { name: "Calendar researcher", modelSelection })).body.bot;
    const second = (await desktopApi("POST", "/api/bots", { name: "Calendar writer", modelSelection })).body.bot;
    let callId = "";
    let roomId = "";
    try {
      const created = await desktopApi("POST", "/api/calendar-calls", {
        name: "Launch room",
        description: "Review the launch plan.",
        botIds: [first.id, second.id],
        schedule: { type: "once", at: Date.now() - 100 },
        durationMinutes: 30,
        attachments: [{
          id: "launch-brief",
          name: "Launch brief.txt",
          path: "/tmp/a\"&<>.txt",
          size: 12,
          kind: "file",
        }],
      });
      expect(created.status).toBe(201);
      callId = created.body.call.id;

      await expect.poll(async () => {
        const snapshot = await api("GET", "/api/bots?messages=50");
        const room = snapshot.body.groups.find((candidate: { memberIds: string[] }) =>
          candidate.memberIds.length === 2 &&
          candidate.memberIds.includes(first.id) &&
          candidate.memberIds.includes(second.id)
        );
        return room?.messages.find((message: { sendId?: string }) =>
          message.sendId?.startsWith(`calendar_${callId}_`)
        )?.text;
      }, { timeout: 5_000 }).toBe(
        '@everyone Review the launch plan.\n\n<attached-file path="/tmp/a&quot;&amp;&lt;&gt;.txt" />',
      );

      const snapshot = await api("GET", "/api/bots?messages=50");
      const room = snapshot.body.groups.find((candidate: { memberIds: string[] }) =>
        candidate.memberIds.length === 2 &&
        candidate.memberIds.includes(first.id) &&
        candidate.memberIds.includes(second.id)
      );
      expect(room).toMatchObject({ defaultResponder: { kind: "everyone" } });
      roomId = room.id;

      await expect.poll(async () => {
        const refreshed = await api("GET", "/api/bots?messages=50");
        const current = refreshed.body.groups.find((candidate: { id: string }) => candidate.id === roomId);
        return current?.messages
          .filter((message: { from?: { botId?: string } }) => message.from?.botId)
          .map((message: { from: { botId: string } }) => message.from.botId)
          .sort();
      }, { timeout: 5_000 }).toEqual([first.id, second.id].sort());

      const joined = await desktopApi("POST", `/api/calendar-calls/${callId}/room`, {});
      expect(joined.status).toBe(200);
      expect(joined.body.group.id).toBe(roomId);
      expect(room.messages.filter((message: { sendId?: string }) =>
        message.sendId?.startsWith(`calendar_${callId}_`)
      )).toHaveLength(1);
    } finally {
      if (callId) await desktopApi("DELETE", `/api/calendar-calls/${callId}`).catch(() => undefined);
      if (roomId) {
        await api("POST", `/api/groups/${roomId}/interrupt`, {}).catch(() => undefined);
        await desktopApi("DELETE", `/api/groups/${roomId}`).catch(() => undefined);
      }
      await desktopApi("DELETE", `/api/bots/${first.id}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${second.id}`).catch(() => undefined);
    }
  });

  it("refuses to delete a bot while one of its routines is active", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const routine = (await desktopApi("POST", "/api/routines", {
      name: "Deletion safety routine",
      prompt: "Keep running until interrupted.",
      botId: bot.id,
      runOn: "ember",
      enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    })).body.routine;
    let runId = "";
    try {
      rmSync(fakeClaudeDump, { force: true });
      const queued = await desktopApi("POST", `/api/routines/${routine.id}/run`);
      expect(queued.status).toBe(201);
      runId = queued.body.run.id;
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("running");

      const deletion = await desktopApi("DELETE", `/api/bots/${bot.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/active routine/i);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.some(
        (candidate: { id: string }) => candidate.id === bot.id,
      )).toBe(true);
    } finally {
      if (runId) await desktopApi("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
      await desktopApi("DELETE", `/api/routines/${routine.id}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  // The emergency endpoint stops work on this machine's own screen, and only
  // macOS and Linux lend a bot the local computer (local-routing.ts); on
  // Windows "local" never mounts, so there is nothing for it to stop there.
  // 0.1.61 live defect: a routine that runs again in its own conversation
  // pins again. When the skills changed in between, the native links in its
  // desk still pointed at the first run's pin, and every later run failed
  // with "Pinned procedures are unavailable or changed".
  it("a routine's later runs relink native skills to the new pin after the skills changed", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    let routineId = "";
    const runOnce = async () => {
      const queued = await desktopApi("POST", `/api/routines/${routineId}/run`);
      expect(queued.status).toBe(201);
      const runId = queued.body.run.id as string;
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 15_000 }).toMatch(/^(completed|failed|cancelled)$/);
      const run = (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === runId);
      expect(run, JSON.stringify(run)).toMatchObject({ status: "completed" });
      const threadId = run.threadId as string;
      const task = (await api("GET", "/api/bots?messages=0")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.tasks.find((item: { threadId: string }) => item.threadId === threadId);
      const bundleId = task?.procedurePin?.bundleId as string;
      expect(bundleId).toMatch(/^[a-f0-9]{64}$/);
      return { desk: join(home, ".murage", "workspaces", bot.id, "threads", threadId), bundleId };
    };
    try {
      expect((await desktopApi("POST", `/api/bots/${bot.id}/skills/library`, { ids: ["abstract-writing"] })).status).toBe(201);
      const routine = await desktopApi("POST", "/api/routines", {
        name: "Pinned skills rerun",
        prompt: "__fixture_finish_turn__ routine rerun",
        botId: bot.id,
        runOn: "ember",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      expect(routine.status).toBe(201);
      routineId = routine.body.routine.id;
      const first = await runOnce();
      const link = (desk: string, name: string) => join(desk, ".agents", "skills", name);
      expect(realpathSync(link(first.desk, "abstract-writing"))).toBe(realpathSync(join(first.desk, ".murage-procedures", first.bundleId, "skills", "abstract-writing")));

      expect((await desktopApi("POST", `/api/bots/${bot.id}/skills/library`, { ids: ["academic-writer"] })).status).toBe(201);
      const second = await runOnce();
      expect(second.desk).toBe(first.desk);
      expect(second.bundleId).not.toBe(first.bundleId);
      for (const name of ["abstract-writing", "academic-writer"]) {
        expect(realpathSync(link(second.desk, name))).toBe(realpathSync(join(second.desk, ".murage-procedures", second.bundleId, "skills", name)));
      }

      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/skills/academic-writer`, { enabled: false })).status).toBe(200);
      const third = await runOnce();
      expect(existsSync(link(third.desk, "academic-writer"))).toBe(false);
      expect(realpathSync(link(third.desk, "abstract-writing"))).toBe(realpathSync(join(third.desk, ".murage-procedures", third.bundleId, "skills", "abstract-writing")));
    } finally {
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("stops a local bot's exact channel and routine work through the emergency endpoint", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    // This is an emergency-routing test, not another platform CUA contract
    // test. Dispatch with computer access off so every CI host can run the
    // same hanging provider, then mark the bot local immediately before the
    // emergency action whose exact channel/routine targeting is under test.
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    const room = (await api("POST", "/api/groups", {
      name: "Emergency stop room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    let routineId = "";
    let runId = "";
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "work in this channel" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
      expect((await desktopApi("POST", "/api/local-computer/interrupt", {})).status).toBe(200);
      await expect.poll(async () => {
        const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
          (candidate: { id: string }) => candidate.id === room.id,
        );
        return group?.working;
      }, { timeout: 5_000 }).toBe(false);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);

      const routine = await desktopApi("POST", "/api/routines", {
        name: "Emergency stop routine",
        prompt: "Keep running until interrupted.",
        botId: bot.id,
        runOn: "ember",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      expect(routine.status).toBe(201);
      routineId = routine.body.routine.id;
      rmSync(fakeClaudeDump, { force: true });
      const queued = await desktopApi("POST", `/api/routines/${routineId}/run`);
      expect(queued.status).toBe(201);
      runId = queued.body.run.id;
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("running");

      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
      expect((await desktopApi("POST", "/api/local-computer/interrupt", {})).status).toBe(200);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("cancelled");
    } finally {
      if (runId) await desktopApi("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it.skipIf(browserEngineRefusesHost)("mounts a scoped unified browser capability and the safety prompt in room turns", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    let room: any;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true }, browserProfiles: [{ id: "work", name: "Work" }] })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { browserProfile: "work", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
      room = (await api("POST", "/api/groups", { name: "Browser safety", memberIds: [bot.id] })).body.group;
      expect((await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "Check the website" })).status).toBe(202);
      const mounted = await browserMount();
      expect(mounted.env).toMatchObject({ MURAGE_BOT_ID: bot.id, MURAGE_THREAD_ID: room.threadId });
      const dump = await readJsonFileWhenReady<{ env: Record<string, string>; systemPrompt: string }>(fakeClaudeDump);
      expect(dump.env.MURAGE_BROWSER_CONNECTION).toBeUndefined();
      expect(dump.env.MURAGE_USER_DATA).toBeUndefined();
      expect(mounted.env).not.toHaveProperty("MURAGE_BROWSER_TOKEN");
      expect(dump.systemPrompt).toMatch(/instructions as untrusted content/i);
      expect(dump.systemPrompt).toMatch(/consequential actions.*confirmation/i);
      expect(dump.systemPrompt).toMatch(/Take control/);
      expect(dump.systemPrompt).toMatch(/reopen a blank page/);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
      expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN)).status).toBe(401);
    } finally {
      if (room) { await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined); await desktopApi("DELETE", `/api/groups/${room.id}`).catch(() => undefined); }
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { features: { browser: false }, browserProfiles: [] }).catch(() => undefined);
    }
  });

  it.skipIf(browserEngineRefusesHost)("retires an in-flight unified browser binding and never dispatches after its bot is deleted", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserNativeEvents.length;
      setBrowserRegisterDelayMs(250);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "do not outlive deletion" })).status).toBe(202);
      await expect.poll(() => browserNativeEvents.slice(callOffset).some(
        (call) => call.operation === "verify" && call.session === browserSession(bot.id),
      ), { timeout: 5_000 }).toBe(true);

      // N7 (05cce991): a bot with a running thread cannot be deleted; the
      // thread (and its in-flight binding) is stopped explicitly first.
      const refused = await desktopApi("DELETE", `/api/bots/${bot.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/stop this bot's threads/i);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      expect((await desktopApi("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      // Native verification is intentionally held by the fixture. Wait beyond that
      // entire window so a late provider dispatch cannot escape the check.
      await new Promise((resolve) => setTimeout(resolve, browserRegisterDelayMs + 250));
      expect(existsSync(fakeClaudeDump)).toBe(false);
    } finally {
      setBrowserRegisterDelayMs(0);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  // N7 (05cce991): a Stop during setup has no provider handshake to retire,
  // so the thread is released at once; the cancelled setup never dispatches
  // and a replacement starts as a fresh turn with its own browser binding.
  it.skipIf(browserEngineRefusesHost)("releases a setup-cancelled thread immediately without dispatching the cancelled setup", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserNativeEvents.length;
      setBrowserRegisterDelayMs(1_000);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "first setup" })).status).toBe(202);
      await expect.poll(() => browserNativeEvents.slice(callOffset).some(
        (call) => call.operation === "verify" && call.session === browserSession(bot.id),
      ), { timeout: 5_000 }).toBe(true);

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      const afterStop = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(afterStop.busy).toBe(false);
      expect(afterStop.tasks.find((task: { threadId: string }) => task.threadId === bot.threadId)).toMatchObject({ busy: false, activity: "idle" });
      // Native verification is still held; wait out that whole window so a
      // late dispatch from the cancelled setup cannot escape the check.
      await new Promise((resolve) => setTimeout(resolve, browserRegisterDelayMs + 250));
      expect(existsSync(fakeClaudeDump)).toBe(false);

      const replacement = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "replacement" });
      expect(replacement.status).toBe(202);
      expect(replacement.body.queued).not.toBe(true);
      expect(replacement.body.steered).not.toBe(true);
      // The only provider process is the replacement's own turn.
      const dump = await readJsonFileWhenReady<{ pid: number; prompt: unknown }>(fakeClaudeDump);
      expect(JSON.stringify(dump.prompt)).toContain("replacement");
      expect(dump.pid).toBeGreaterThan(0);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      ).busy).toBe(true);
    } finally {
      setBrowserRegisterDelayMs(0);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it.skipIf(browserEngineRefusesHost)("does not dispatch a room turn stopped through its bot during unified browser binding", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    let room: any;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      room = (await api("POST", "/api/groups", { name: "Browser stop race", memberIds: [bot.id] })).body.group;
      expect((await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserNativeEvents.length;
      setBrowserRegisterDelayMs(250);
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "stop before launch" })).status).toBe(202);
      await expect.poll(() => browserNativeEvents.slice(callOffset).some(
        (call) => call.operation === "verify" && call.session === browserSession(bot.id),
      ), { timeout: 5_000 }).toBe(true);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy,
          roomBusyBotId: state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      expect(existsSync(fakeClaudeDump)).toBe(false);
    } finally {
      setBrowserRegisterDelayMs(0);
      if (room) {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await desktopApi("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      }
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it.skipIf(browserEngineRefusesHost)("revokes active browser access when the global feature is disabled", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      const callOffset = browserNativeEvents.length;
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "browse until disabled" })).status).toBe(202);
      const mounted = await browserMount();

      const perBot = await desktopApi("PATCH", `/api/bots/${bot.id}`, { browser: false });
      expect(perBot.status).toBe(409);
      expect(perBot.body.error).toMatch(/stop.*turn/i);

      expect((await desktopApi("PATCH", "/api/config", { features: { browser: false } })).status).toBe(200);
      expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN)).status).toBe(401);
      expect(browserNativeEvents.slice(callOffset)).toContainEqual({ operation: "close", session: browserSession(bot.id) });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it.skipIf(browserEngineRefusesHost)("applies browser disable effects before reporting a removed-profile cleanup failure", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "murage-browser-cleanup-api-"));
    const isolatedData = join(isolatedHome, ".murage");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Cleanup test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        ...FIXTURE_ENGINE_OVERRIDES,
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
      browserProfiles: [{ id: "unused", name: "Unused" }],
    }));
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));

    // Model Electron's private utility-process port, but answer lifecycle
    // cleanup requests with an immediate negative ACK. This keeps the test
    // fast while exercising the real config route's post-commit ordering.
    const noAckDesktopPrelude = `data:text/javascript,${encodeURIComponent(`
      let listener;
      Object.defineProperty(process, "parentPort", {
        value: {
          on(event, callback) { if (event === "message") listener = callback; },
          postMessage(message) {
            if (message?.type === "murage:desktop-secret") process.send?.(message);
            if (message?.requestId && /browser-(?:bot|profile)-deleted/.test(message.type ?? "")) {
              queueMicrotask(() => listener?.({ data: {
                type: "murage:browser-lifecycle-result",
                requestId: message.requestId,
                ok: false,
              } }));
            }
          },
        },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedEnv: NodeJS.ProcessEnv = {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      MURAGE_PORT: String(isolatedPort),
      MURAGE_WEBHOOK_PORT: String(isolatedPort + 1),
      MURAGE_STATIC_DIR: isolatedStatic,
      MURAGE_BROWSER_CONNECTION: descriptorFile,
      MURAGE_AGENT_BROWSER_PATH: process.execPath,
      MURAGE_BROWSER_FIXTURE_URL: `http://127.0.0.1:${boxStubPort}/fixture-browser-event`,
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
    };
    if (process.env.PATH) isolatedEnv.PATH = process.env.PATH;
    if (process.env.SystemRoot) isolatedEnv.SystemRoot = process.env.SystemRoot;
    const isolatedChild = spawn(process.execPath, ["--import", browserFixturePrelude, "--import", noAckDesktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: isolatedEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const isolatedDesktopHeaders = privateDesktopHeaders(isolatedChild);
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    type IsolatedApiBody =
      | { modelSelection: { instanceId: string; model: string }; requireAvailableModel: boolean }
      | { text: string }
      | { features: { browser: boolean }; browserProfiles: Array<{ id: string; name: string }>; expectedBrowserProfiles: Array<{ id: string; name: string }> };
    const isolatedApi = async (method: string, path: string, body?: IsolatedApiBody, headers: Record<string, string> = {}): Promise<{
      status: number;
      body: any;
    }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);

      const bot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      }, isolatedDesktopHeaders)).body.bot;
      const callOffset = browserNativeEvents.length;
      expect((await isolatedApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep browser access live" })).status)
        .toBe(202);
      const mounted = await browserMount(join(isolatedHome, "fake-claude-dump.json"), `http://127.0.0.1:${isolatedPort}`).catch((e) => { let d = ""; try { const j = JSON.parse(readFileSync(join(isolatedHome, "fake-claude-dump.json"), "utf8")); d = JSON.stringify({ servers: Object.keys(j.mcpConfig?.mcpServers ?? {}), prompt: JSON.stringify(j.prompt).slice(0, 300), argv: j.argv }); } catch (x) { d = String(x); } throw new Error(`${e.message}\nDIAGDUMP ${d}\nDIAGERR ${isolatedStderr.slice(-4000)}`); });

      // Wait for the mounted provider turn before the post-commit cleanup failure.
      const dispatch = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: Record<string, unknown> };
      }>(join(isolatedHome, "fake-claude-dump.json"));
      expect(dispatch.mcpConfig.mcpServers.browser).toBeTruthy();

      const patched = await isolatedApi("PATCH", "/api/config", {
        features: { browser: false },
        browserProfiles: [],
        expectedBrowserProfiles: [{ id: "unused", name: "Unused" }],
      }, isolatedDesktopHeaders);
      expect(patched.status).toBe(503);
      expect(patched.body.error).toMatch(/could not confirm.*browser data was erased/i);
      // The negative cleanup ACK must not short-circuit the already-committed
      // feature disable. The unified controller closes and retires the live claim.
      expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN, `http://127.0.0.1:${isolatedPort}`)).status).toBe(401);
      expect(browserNativeEvents.slice(callOffset).some(call => call.operation === "close")).toBe(true);
      const config = await isolatedApi("GET", "/api/config");
      expect(config.body.features.browser).toBe(false);
      expect(config.body.browserProfiles).toEqual([]);
      expect(JSON.parse(readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8")))
        .toEqual([expect.objectContaining({ kind: "profile", id: "unused", phase: "committed" })]);
    } finally {
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("reconciles a committed crash-stale bot reference before ACK and profile-id reuse", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "murage-browser-cleanup-restart-"));
    const isolatedData = join(isolatedHome, ".murage");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Cleanup restart test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        ...FIXTURE_ENGINE_OVERRIDES,
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      browserProfiles: [],
    }));
    writeFileSync(join(isolatedData, "bots.json"), JSON.stringify([{
      id: "crash-bot",
      threadId: "crash-thread",
      name: "Crash bot",
      title: "",
      description: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      resumeCursors: {},
      createdAt: 1,
      browserProfile: "client",
    }]));
    writeFileSync(join(isolatedData, "browser-cleanups.json"), JSON.stringify([{
      requestId: "00000000-0000-4000-8000-000000000001",
      kind: "profile",
      id: "client",
      partitionId: "Client",
      phase: "committed",
    }]));

    const ackDesktopPrelude = `data:text/javascript,${encodeURIComponent(`
      let listener;
      Object.defineProperty(process, "parentPort", {
        value: {
          on(event, callback) { if (event === "message") listener = callback; },
          postMessage(message) {
            if (message?.type === "murage:desktop-secret") process.send?.(message);
            if (message?.requestId && /browser-(?:bot|profile)-deleted/.test(message.type ?? "")) {
              queueMicrotask(() => listener?.({ data: {
                type: "murage:browser-lifecycle-result",
                requestId: message.requestId,
                ok: true,
              } }));
            }
          },
        },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(
      process.execPath,
      ["--import", ackDesktopPrelude, join(SERVER_DIR, "index.ts")],
      {
        cwd: ROOT,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          MURAGE_PORT: String(isolatedPort),
          MURAGE_WEBHOOK_PORT: String(isolatedPort + 1),
          MURAGE_STATIC_DIR: isolatedStatic,
          FAKE_CLAUDE_MODE: "hang",
          FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const isolatedDesktopHeaders = privateDesktopHeaders(isolatedChild);
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      await expect.poll(() => JSON.parse(
        readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8"),
      ), { timeout: 5_000 }).toEqual([]);

      const beforeReuse = await isolatedApi("GET", "/api/bots?messages=0");
      expect(beforeReuse.body.bots.find((bot: { id: string }) => bot.id === "crash-bot"))
        .not.toHaveProperty("browserProfile");
      expect((await isolatedApi("PATCH", "/api/config", {
        browserProfiles: [{ id: "client", name: "A different account" }],
        expectedBrowserProfiles: [],
      }, isolatedDesktopHeaders)).status).toBe(200);
      const afterReuse = await isolatedApi("GET", "/api/bots?messages=0");
      expect(afterReuse.body.bots.find((bot: { id: string }) => bot.id === "crash-bot"))
        .not.toHaveProperty("browserProfile");
    } finally {
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it.skipIf(browserEngineRefusesHost)("revokes live browser access even when clearing a removed profile reference cannot persist", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "murage-browser-reference-write-"));
    const isolatedData = join(isolatedHome, ".murage");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    const botsFile = join(isolatedData, "bots.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Reference failure test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        ...FIXTURE_ENGINE_OVERRIDES,
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
      browserProfiles: [{ id: "unused", name: "Unused" }],
    }));
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const desktopPrelude = `data:text/javascript,${encodeURIComponent(`
      Object.defineProperty(process, "parentPort", {
        value: { on() {}, postMessage(message) { if (message?.type === "murage:desktop-secret") process.send?.(message); } },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(process.execPath, ["--import", browserFixturePrelude, "--import", desktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        MURAGE_PORT: String(isolatedPort),
        MURAGE_WEBHOOK_PORT: String(isolatedPort + 1),
        MURAGE_STATIC_DIR: isolatedStatic,
        MURAGE_BROWSER_CONNECTION: descriptorFile,
      MURAGE_AGENT_BROWSER_PATH: process.execPath,
      MURAGE_BROWSER_FIXTURE_URL: `http://127.0.0.1:${boxStubPort}/fixture-browser-event`,
        FAKE_CLAUDE_MODE: "hang",
        FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const isolatedDesktopHeaders = privateDesktopHeaders(isolatedChild);
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      const idleBot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      }, isolatedDesktopHeaders)).body.bot;
      const activeBot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      }, isolatedDesktopHeaders)).body.bot;
      expect((await isolatedApi("PATCH", `/api/bots/${idleBot.id}`, { browserProfile: "unused" }, isolatedDesktopHeaders)).status).toBe(200);

      const callOffset = browserNativeEvents.length;
      expect((await isolatedApi("POST", `/api/bots/${activeBot.id}/messages`, { text: "keep browser access live" })).status)
        .toBe(202);
      const mounted = await browserMount(join(isolatedHome, "fake-claude-dump.json"), `http://127.0.0.1:${isolatedPort}`).catch((e) => { let d = ""; try { const j = JSON.parse(readFileSync(join(isolatedHome, "fake-claude-dump.json"), "utf8")); d = JSON.stringify({ servers: Object.keys(j.mcpConfig?.mcpServers ?? {}), prompt: JSON.stringify(j.prompt).slice(0, 300), argv: j.argv }); } catch (x) { d = String(x); } throw new Error(`${e.message}\nDIAGDUMP ${d}\nDIAGERR ${isolatedStderr.slice(-4000)}`); });
      // Registration happens before the provider's init frame is persisted.
      // Wait for that final startup write before sabotaging the store;
      // otherwise slower Windows runners can reset the next HTTP request when
      // the resume-cursor save races the deliberately-invalid bots path.
      await expect.poll(() => {
        try {
          const bots = z.array(z.object({
            id: z.string().optional(),
            resumeCursors: z.record(z.string(), z.string()).optional(),
          }).passthrough()).parse(JSON.parse(readFileSync(botsFile, "utf8")));
          const cursor = bots.find((bot) => bot.id === activeBot.id)?.resumeCursors?.claude;
          return Boolean(cursor);
        } catch {
          return false;
        }
      }, { timeout: 5_000 }).toBe(true);

      // The hanging provider may bank one final activity write concurrently.
      // Win the replacement atomically by retrying until the path is a
      // directory; subsequent Store saves then fail deterministically.
      for (let attempt = 0; attempt < 50 && !statSync(botsFile, { throwIfNoEntry: false })?.isDirectory(); attempt += 1) {
        rmSync(botsFile, { recursive: true, force: true });
        try {
          mkdirSync(botsFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      expect(statSync(botsFile).isDirectory()).toBe(true);
      const patched = await isolatedApi("PATCH", "/api/config", {
        features: { browser: false },
        browserProfiles: [],
        expectedBrowserProfiles: [{ id: "unused", name: "Unused" }],
      }, isolatedDesktopHeaders);
      expect(patched.status).toBe(500);
      expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN, `http://127.0.0.1:${isolatedPort}`)).status).toBe(401);
      expect(browserNativeEvents.slice(callOffset).some(call => call.operation === "close")).toBe(true);
      const config = await isolatedApi("GET", "/api/config");
      expect(config.body.features.browser).toBe(false);
      expect(config.body.browserProfiles).toEqual([]);
      expect(JSON.parse(readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8")))
        .toEqual([expect.objectContaining({ kind: "profile", id: "unused", phase: "prepared" })]);
    } finally {
      rmSync(botsFile, { recursive: true, force: true });
      writeFileSync(botsFile, "[]");
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it.skipIf(browserEngineRefusesHost)("rejects bot deletion with no teardown when the cleanup journal is unreadable", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "murage-browser-bot-delete-journal-"));
    const isolatedData = join(isolatedHome, ".murage");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Malformed journal test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        ...FIXTURE_ENGINE_OVERRIDES,
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
    }));
    writeFileSync(join(isolatedData, "browser-cleanups.json"), "{ malformed");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const desktopPrelude = `data:text/javascript,${encodeURIComponent(`
      Object.defineProperty(process, "parentPort", {
        value: { on() {}, postMessage(message) { if (message?.type === "murage:desktop-secret") process.send?.(message); } },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(process.execPath, ["--import", browserFixturePrelude, "--import", desktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        MURAGE_PORT: String(isolatedPort),
        MURAGE_WEBHOOK_PORT: String(isolatedPort + 1),
        MURAGE_STATIC_DIR: isolatedStatic,
        MURAGE_BROWSER_CONNECTION: descriptorFile,
      MURAGE_AGENT_BROWSER_PATH: process.execPath,
      MURAGE_BROWSER_FIXTURE_URL: `http://127.0.0.1:${boxStubPort}/fixture-browser-event`,
        FAKE_CLAUDE_MODE: "hang",
        FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let createdBotId = "";
    const isolatedDesktopHeaders = privateDesktopHeaders(isolatedChild);
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      const bot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      }, isolatedDesktopHeaders)).body.bot;
      createdBotId = bot.id;
      const callOffset = browserNativeEvents.length;
      expect((await isolatedApi("POST", `/api/bots/${bot.id}/messages`, { text: "do not tear this down" })).status)
        .toBe(202);
      const mounted = await browserMount(join(isolatedHome, "fake-claude-dump.json"), `http://127.0.0.1:${isolatedPort}`).catch((e) => { let d = ""; try { const j = JSON.parse(readFileSync(join(isolatedHome, "fake-claude-dump.json"), "utf8")); d = JSON.stringify({ servers: Object.keys(j.mcpConfig?.mcpServers ?? {}), prompt: JSON.stringify(j.prompt).slice(0, 300), argv: j.argv }); } catch (x) { d = String(x); } throw new Error(`${e.message}\nDIAGDUMP ${d}\nDIAGERR ${isolatedStderr.slice(-4000)}`); });

      // N7 (05cce991): live work refuses deletion outright, with no teardown.
      const refused = await isolatedApi("DELETE", `/api/bots/${bot.id}`, undefined, isolatedDesktopHeaders);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/stop this bot's threads/i);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(browserNativeEvents.slice(callOffset).some(call => call.operation === "close")).toBe(false);
      expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN, `http://127.0.0.1:${isolatedPort}`)).status).toBe(200);
      const state = await isolatedApi("GET", "/api/bots?messages=0");
      expect(state.body.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toMatchObject({ busy: true });

      // Once idle, the unreadable journal still rejects the delete before any
      // teardown: the bot, its routines and its files stay untouched.
      expect((await isolatedApi("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      await expect.poll(async () => (await isolatedApi("GET", "/api/bots?messages=0")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)?.busy, { timeout: 5_000 }).toBe(false);
      const deletion = await isolatedApi("DELETE", `/api/bots/${bot.id}`, undefined, isolatedDesktopHeaders);
      expect(deletion.status).toBe(503);
      expect(deletion.body.error).toMatch(/cleanup journal could not be read/i);
      expect((await isolatedApi("GET", "/api/bots?messages=0")).body.bots.some((candidate: { id: string }) => candidate.id === bot.id)).toBe(true);
    } finally {
      if (createdBotId) {
        await isolatedApi("POST", `/api/bots/${createdBotId}/interrupt`, {}).catch(() => undefined);
      }
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("clears bot references when a named browser profile is removed", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", {
        browserProfiles: [{ id: "client", name: "Client" }],
      })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { browserProfile: "client" })).body.bot.browserProfile).toBe("client");
      expect((await desktopApi("PATCH", "/api/config", { browserProfiles: [] })).status).toBe(200);
      const state = (await api("GET", "/api/bots")).body;
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)).not.toHaveProperty("browserProfile");
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("does not remove a browser profile from a bot whose turn is active", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", {
        browserProfiles: [{ id: "active", name: "Active" }],
      })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        browserProfile: "active",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep working" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(true);

      const blocked = await desktopApi("PATCH", "/api/config", { browserProfiles: [] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop .* turn/i);
      const switched = await desktopApi("PATCH", `/api/bots/${bot.id}`, { browserProfile: null });
      expect(switched.status).toBe(409);
      expect(switched.body.error).toMatch(/stop this bot's turn before changing its browser profile/i);
      const state = (await api("GET", "/api/bots")).body;
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.browserProfile).toBe("active");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("blocks new profile claims while provider validation commits a profile removal", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", {
        browserProfiles: [{ id: "late-claim", name: "Late claim" }],
      })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        browserProfile: "late-claim",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      // Provider validation holds admission, so an idle profile cannot become
      // active during the awaited configuration transaction.
      const removing = desktopApi("PATCH", "/api/config", { box: { token: "box_slow" }, browserProfiles: [] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const blocked = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "start during validation" });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/Engine setup is finishing/i);
      expect((await removing).status).toBe(200);
      const state = (await api("GET", "/api/bots")).body;
      const idleBot = state.bots.find((candidate: { id: string }) => candidate.id === bot.id);
      expect(idleBot).toBeDefined();
      expect(idleBot.busy).toBeFalsy();
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)).not.toHaveProperty("browserProfile");
      expect((await api("GET", "/api/config")).body.browserProfiles).toEqual([]);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await desktopApi("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("keeps shared Local VM mode by default and resolves isolated targets per bot when enabled", async () => {
    const first = (await desktopApi("POST", "/api/bots")).body.bot;
    const second = (await desktopApi("POST", "/api/bots")).body.bot;
    const before = await api("GET", "/api/config");
    expect(before.body.localVm).toEqual({ mode: "shared", maxInstances: 2 });

    const shared = await desktopApi("GET", `/api/bots/${first.id}/local-computer`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ mode: "shared", target_key: "shared" });

    const saved = await desktopApi("PATCH", "/api/config", {
      localVm: { mode: "per-bot", maxInstances: 3 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });

    const [firstStatus, secondStatus] = await Promise.all([
      desktopApi("GET", `/api/bots/${first.id}/local-computer`),
      desktopApi("GET", `/api/bots/${second.id}/local-computer`),
    ]);
    expect(firstStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(secondStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(firstStatus.body.target_key).not.toBe(secondStatus.body.target_key);
    expect(firstStatus.body.container_name).not.toBe(secondStatus.body.container_name);
    expect(firstStatus.body.workspace_path).not.toBe(secondStatus.body.workspace_path);

    const invalid = await desktopApi("PATCH", "/api/config", { localVm: { maxInstances: 5 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("localVm.maxInstances");

    const disk = JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8"));
    expect(disk.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });
    await desktopApi("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
  });

  it("keeps an active turn alive when only the room silence limit changes", async () => {
    const created = await desktopApi("POST", "/api/bots", {});
    const botId = created.body.bot.id;
    const room = (await api("POST", "/api/groups", {
      name: "Room timeout capture",
      memberIds: [botId],
    })).body.group;
    const ready = await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    expect(ready.status).toBe(200);
    try {
      const selected = await desktopApi("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const sent = await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "stay active" });
      expect(sent.status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const before = (await api("GET", "/api/bots")).body;
      expect(before.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      expect(before.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId).toBe(botId);

      const saved = await desktopApi("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 45 } });
      expect(saved.status).toBe(200);

      const after = (await api("GET", "/api/bots")).body;
      expect(after.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      const activeRoom = after.groups.find((group: { id: string }) => group.id === room.id);
      expect(activeRoom?.busyBotId).toBe(botId);
      expect(activeRoom.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((bot: { id: string }) => bot.id === botId)?.busy,
          roomBusyBotId: state.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
    }
  });

  it("tracks and interrupts the whole queued channel turn", async () => {
    const first = (await desktopApi("POST", "/api/bots", {})).body.bot;
    const second = (await desktopApi("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queued channel turn",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      const sent = await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "both bots should answer",
        threadId: room.threadId,
      });
      expect(sent.status).toBe(202);

      // The operation is registered before any awaited provider setup. Polling
      // and structural guards therefore cannot see a false idle window.
      const immediate = (await api("GET", "/api/bots?messages=0")).body;
      expect(immediate.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: "Too soon" })).status).toBe(409);
      expect((await desktopApi("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id] })).status).toBe(409);

      const interrupted = await api("POST", `/api/groups/${room.id}/interrupt`, {
        threadId: room.threadId,
      });
      expect(interrupted.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const currentRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: currentRoom?.working,
          busyBotId: currentRoom?.busyBotId,
          busyBots: state.bots
            .filter((bot: { id: string; busy: boolean }) =>
              (bot.id === first.id || bot.id === second.id) && bot.busy,
            )
            .map((bot: { id: string }) => bot.id),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, busyBots: [] });

      // Cancellation must be durable for the queued remainder, not merely
      // interrupt whichever responder happened to own the process.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = (await api("GET", "/api/bots?messages=0")).body;
      expect(settled.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(false);
      expect(settled.bots.filter((bot: { id: string; busy: boolean }) =>
        (bot.id === first.id || bot.id === second.id) && bot.busy,
      )).toHaveLength(0);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${first.id}`);
      await desktopApi("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("tracks and cancels a queued channel credential continuation before provider dispatch", async () => {
    const first = (await desktopApi("POST", "/api/bots", {})).body.bot;
    const second = (await desktopApi("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Credential continuation",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: second.id } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      // The card belongs to the second bot's real source turn; a lead's
      // bearer is no longer permitted to impersonate another room member.
      const secondTurn = await startInternalFixtureTurn(second.id, room.id);
      const token = secondTurn.env.MURAGE_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fromBotId: second.id,
          fromThreadId: room.threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed for the queued task",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = (await requested.json()) as { messageId: string };

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      const firstDump = (await startInternalFixtureTurn(first.id, room.id, `@${first.name} start the lead`)).dump;

      const resumed = await desktopApi("POST", `/api/bots/${second.id}/secret-cards/${messageId}/dismiss`, {
        threadId: room.threadId,
      });
      expect(resumed).toEqual({ status: 200, body: { dismissed: true, resumed: true } });

      const queued = (await api("GET", "/api/bots?messages=0")).body;
      expect(queued.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      const deletion = await desktopApi("DELETE", `/api/groups/${room.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/working/i);

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return {
          working: state.groups.find((group: { id: string }) => group.id === room.id)?.working,
          secondBusy: Boolean(state.bots.find((bot: { id: string }) => bot.id === second.id)?.busy),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, secondBusy: false });

      // The continuation sat behind the lead's hanging provider. Interrupting
      // the room must cancel it before a second provider process is spawned.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).pid).toBe(firstDump.pid);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.groups.find((group: { id: string }) => group.id === room.id)?.working;
      }, { timeout: 5_000 }).toBe(false);
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${first.id}`);
      await desktopApi("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("resolves trusted engine setup recipes only for the desktop owner", async () => {
    expect((await api("POST", "/api/engine-setup-command", { instanceId: "claude", action: "connect" })).status).toBe(404);
    expect((await api("GET", "/api/engine-management/claude")).status).toBe(404);
    expect((await desktopApi("POST", "/api/engine-setup-command", { instanceId: "claude", action: "connect", command: "UNTRUSTED_RENDERER_COMMAND" })).status).toBe(400);
    const recipe = await desktopApi("POST", "/api/engine-setup-command", { instanceId: "claude", action: "connect" });
    expect(recipe.status).toBe(200);
    expect(recipe.body.command).toContain("claude");
    expect(recipe.body.command).not.toContain("UNTRUSTED_RENDERER_COMMAND");
    expect((await desktopApi("POST", "/api/engine-setup-command", { instanceId: "__proto__", action: "connect" })).status).toBe(404);
  });

  it("enforces owner connected-app limits at the real internal relay and revokes stale tokens", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Scoped access HTTP fixture" })).body.bot;
    let permissionClient: import("node:net").Socket | undefined;
    try {
      expect((await api("GET", `/api/bots/${bot.id}/access`)).status).toBe(404);
      const view = await desktopApi("GET", `/api/bots/${bot.id}/access`);
      expect(view.status).toBe(200);
      expect((await desktopApi("PUT", `/api/bots/${bot.id}/access`, {
        action: "configure", revision: view.body.policy.revision, mode: "restricted", allowWrites: false, grants: [],
      })).status).toBe(200);
      const { dump, headers: agentHeaders } = await startInternalFixtureTurn(bot.id);
      // A held turn mounts the broker but does not itself ask permission.
      // Speak the actual permission-proxy protocol to that mounted broker;
      // the synthetic command is only card input and is never executed.
      const socketPath = dump.mcpConfig.mcpServers.muragebox?.args.at(-1);
      expect(socketPath).toBeTruthy();
      const { connect } = await import("node:net");
      permissionClient = connect(socketPath!);
      permissionClient.on("error", () => {});
      await once(permissionClient, "connect");
      permissionClient.write(JSON.stringify({ t: "ask", id: "c03-private-request-canary", tool: "Bash", input: { command: "rm -rf ./C03_SYNTHETIC_PRIVATE_COMMAND_NEVER_RUN" } }) + "\n");
      await expect.poll(async () => (await desktopApi("GET", `/api/bots/${bot.id}/access`)).body.pending.length, { timeout: 5_000 }).toBe(1);
      const token = dump.mcpConfig.mcpServers.composio.env.MURAGE_CONNECTORS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const listed = await fetch(`${BASE}/api/internal/connectors/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ result: { tools: [] } });
      const denied = await fetch(`${BASE}/api/internal/connectors/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "unapproved-fixture-account", arguments: {} }] } } }) });
      expect(denied.status).toBe(403);
      const current = await desktopApi("GET", `/api/bots/${bot.id}/access`);
      expect(current.body.pending.length).toBeGreaterThan(0);
      expect(current.body.pending[0]).not.toHaveProperty("command");
      const statusResponse = await fetch(`${BASE}/api/internal/permission-status`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ targetBotId: bot.id }) });
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json() as { pending: Array<{ kind: string; blockedReason: string; ageSeconds: number }> };
      expect(status).toMatchObject({ botId: bot.id, canApprove: false, pending: [{ kind: "tool", blockedReason: "Waiting for owner review" }] });
      expect(Object.keys(status.pending[0]).sort()).toEqual(["ageSeconds", "blockedReason", "kind"]);
      expect(status.pending[0].ageSeconds).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(status)).not.toMatch(/C03_SYNTHETIC_PRIVATE_COMMAND|c03-private-request-canary|Bash/);
      expect(JSON.stringify(status)).not.toContain(token);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === bot.id)).not.toHaveProperty("connectedAppAccess");
      expect((await desktopApi("PUT", `/api/bots/${bot.id}/access`, { action: "configure", revision: current.body.policy.revision, mode: "unrestricted", allowWrites: true, grants: [] })).status).toBe(200);
      const stale = await fetch(`${BASE}/api/internal/connectors/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
      expect(stale.status).toBe(401);
    } finally {
      permissionClient?.destroy();
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lets an active Chief inspect and update subordinate profiles without granting security settings", async () => {
    const ids: string[] = [];
    try {
      const chief = (await desktopApi("POST", "/api/bots", { name: "Management Chief", section: "Management Leadership" })).body.bot;
      ids.push(chief.id);
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
      const specialist = (await desktopApi("POST", "/api/bots", { name: "Management Specialist", section: "Management Studio" })).body.bot;
      ids.push(specialist.id);
      const { headers } = await startInternalFixtureTurn(chief.id);
      const manage = async (body: unknown) => {
        const response = await fetch(`${BASE}/api/internal/bot-management`, { method: "POST", headers, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as { bot: { revision: string; instructions: string } } };
      };
      const directory = await fetch(`${BASE}/api/internal/agents?self=${chief.id}`, { headers });
      const roster = await directory.json() as { bots: Array<{ id: string; reachable: boolean }> };
      expect(roster.bots.find((bot: { id: string }) => bot.id === specialist.id)).toMatchObject({ reachable: false });
      const original = await manage({ action: "get", targetBotId: specialist.id });
      expect(original.status).toBe(200);
      const instructions = "Longer, specific working instructions. ".repeat(50).trim();
      const changed = await manage({ action: "update", targetBotId: specialist.id, revision: original.body.bot.revision, instructions });
      expect(changed.status).toBe(200);
      expect(changed.body.bot.instructions).toBe(instructions);
      expect((await manage({ action: "update", targetBotId: specialist.id, revision: original.body.bot.revision, role: "Stale" })).status).toBe(409);
      expect((await manage({ action: "update", targetBotId: specialist.id, revision: changed.body.bot.revision, autoApprove: true })).status).toBe(400);
      expect(changed.body.bot).not.toHaveProperty("composio");
      expect(changed.body.bot).not.toHaveProperty("alwaysAllow");
    } finally {
      for (const id of ids) {
        await api("POST", `/api/bots/${id}/interrupt`);
        await desktopApi("DELETE", `/api/bots/${id}`);
      }
    }
  });

  it("keeps chat-created routines inert until their durable card is confirmed", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {})).body.bot;
    let routineId = "";
    let orphanRoutineId = "";
    let legacyRoutineId = "";
    try {
      const selected = await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a routine" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { MURAGE_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      let internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const before = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(before.status).toBe(200);
      expect(z.object({ routines: z.array(z.unknown()) }).parse(await before.json()).routines).toEqual([]);

      const unavailableCloud = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Cloud brief",
            instructions: "Summarize today's priorities in the Cloud VM.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "cloud",
          },
        }),
      });
      expect(unavailableCloud.status).toBe(409);
      // Upstream #1554: a Box-key refusal points a VPS user back at the
      // default destination instead of sending them after a Box key. An
      // earlier test in this file may leave a Box key saved, and then the
      // refusal is the runner's instead; both are a 409.
      expect(await unavailableCloud.json()).toMatchObject({
        error: expect.stringMatching(/Box API key.*self-hosted VPS, set run_on to murage|Cloud VM runner is unavailable/),
      });

      const proposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Weekday brief",
            instructions: "Summarize the priorities for today.",
            schedule: {
              type: "weekly",
              time: "09:00",
              weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
            },
            runOn: "ember",
            durationMinutes: 30,
          },
        }),
      });
      expect(proposed.status).toBe(201);
      const proposal = z.object({ requestId: z.string() }).passthrough().parse(await proposed.json());

      const stillInert = await api("GET", "/api/routines");
      expect(stillInert.body.routines.filter((routine: { botId: string }) => routine.botId === bot.id)).toEqual([]);
      const state = (await api("GET", "/api/bots")).body;
      const card = state.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === proposal.requestId);
      expect(card?.card).toMatchObject({
        tool: "schedule_routine",
        routineRequest: { botId: bot.id, threadId: bot.threadId },
      });
      expect(card?.card.answered).toBeUndefined();

      // Deliberately a REMOTE caller. Confirming a routine card is a phone
      // affordance: unlike POST /api/routines, which takes an arbitrary
      // payload and is desktop-only, this approves one specific proposal the
      // person is looking at — single-use, owner-bound and fingerprint-bound
      // (routine-card-integrity.test.ts pins all three).
      const confirmed = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(confirmed).toMatchObject({ status: 200, body: { outcome: "allowed-once", routineAction: "create" } });
      routineId = confirmed.body.resultId;
      await expect.poll(async () => {
        const decisions = (await desktopApi("GET", "/api/decisions")).body.decisions;
        return decisions
          .filter((decision: { requestId?: string }) => decision.requestId === proposal.requestId)
          .map((decision: { decision: string; source: string }) => `${decision.decision}:${decision.source}`)
          .sort();
      }).toEqual(["card-shown:routine", "user-approved:user"]);

      const after = await api("GET", "/api/routines");
      const confirmedRoutine = after.body.routines.find((routine: { id: string }) => routine.id === routineId);
      expect(confirmedRoutine).toMatchObject({
        botId: bot.id,
        sourceThreadId: bot.threadId,
      });
      const duplicate = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(duplicate.body.alreadySettled).toBe(true);
      expect((await api("GET", "/api/routines")).body.routines
        .filter((routine: { botId: string }) => routine.botId === bot.id)).toHaveLength(1);

      // A routine proposed "for another bot" binds to that bot, not the sender.
      const badTarget = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          forBotId: "bot-that-does-not-exist",
          routine: {
            name: "Nowhere brief",
            instructions: "Should never be scheduled.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "ember",
          },
        }),
      });
      expect(badTarget.status).toBe(404);
      expect(z.object({ error: z.string() }).parse(await badTarget.json()).error).toMatch(/list_bots/);

      const teammate = (await desktopApi("POST", "/api/bots", {})).body.bot;
      const crossProposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          forBotId: teammate.id,
          routine: {
            name: "Teammate brief",
            instructions: "Summarize for the teammate every weekday.",
            schedule: { type: "weekly", time: "08:30", weekdays: ["monday"] },
            runOn: "ember",
            durationMinutes: 30,
          },
        }),
      });
      expect(crossProposed.status).toBe(201);
      const crossProposal = z.object({ requestId: z.string() }).passthrough().parse(await crossProposed.json());
      // the card is confirmed in the proposer's conversation and says who it is for
      const crossState = (await api("GET", "/api/bots")).body;
      const crossCard = crossState.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === crossProposal.requestId);
      expect(crossCard?.card.title).toContain(`for @${teammate.name}`);
      const crossConfirmed = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: crossProposal.requestId,
        behavior: "allow",
      });
      expect(crossConfirmed).toMatchObject({ status: 200, body: { routineAction: "create" } });
      const crossRoutine = (await api("GET", "/api/routines")).body.routines
        .find((routine: { id: string }) => routine.id === crossConfirmed.body.resultId);
      expect(crossRoutine).toMatchObject({ botId: teammate.id, sourceThreadId: bot.threadId });
      await desktopApi("DELETE", `/api/bots/${teammate.id}`);

      // The initial fixture turn is deliberately hung. Once it is stopped,
      // force a deterministic dispatch failure by choosing the configured
      // but unavailable ghost provider. The execution stays detached, while one source card is
      // appended then patched through queued → running → failed.
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        return Boolean(current?.busy);
      }, { timeout: 5_000 }).toBe(false);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost", model: "unavailable-fixture" },
      })).status).toBe(200);

      const routineEvents = await openSse(`${BASE}/api/events`);
      try {
        const queued = await desktopApi("POST", `/api/routines/${routineId}/run`);
        expect(queued.status).toBe(201);
        const failedNotice = await routineEvents.until(
          (frame) =>
            frame.kind === "notify" &&
            frame.notification?.kind === "routine-failed" &&
            frame.notification?.botId === bot.id,
          5_000,
        );
        expect(failedNotice.notification.threadId).toBe(bot.threadId);

        await expect.poll(async () => {
          const current = (await api("GET", "/api/bots")).body.bots
            .find((candidate: { id: string }) => candidate.id === bot.id);
          return current?.messages.filter(
            (message: { kind?: string; routineRun?: { runId?: string } }) =>
              message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
          ) ?? [];
        }, { timeout: 5_000 }).toHaveLength(1);
        const current = (await api("GET", "/api/bots")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        const runCards = current.messages.filter(
          (message: { kind?: string; routineRun?: { runId?: string } }) =>
            message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
        );
        expect(runCards).toHaveLength(1);
        expect(runCards[0].routineRun).toMatchObject({
          runId: queued.body.run.id,
          routineId,
          routineName: "Weekday brief",
          status: "failed",
        });
        expect(runCards[0].routineRun.executionThreadId).not.toBe(bot.threadId);

        // Reading the source and then marking the failure seen in Routines
        // must not make the original conversation unread again. markSeen
        // re-emits the receipt without changing its lifecycle status.
        expect((await api("POST", `/api/bots/${bot.id}/read`, { threadId: bot.threadId })).status).toBe(200);
        // "Mark all as read" (upstream #1629) stamps the same run from any
        // signed-in surface, and a second sweep finds nothing left.
        const sweep = await desktopApi("POST", "/api/routine-runs/seen-all");
        expect(sweep.status).toBe(200);
        expect(sweep.body.runs.find((run: { id: string }) => run.id === queued.body.run.id)?.seenAt).toBeTypeOf("number");
        expect((await desktopApi("POST", "/api/routine-runs/seen-all")).body.runs).toEqual([]);
        expect((await desktopApi("POST", `/api/routine-runs/${queued.body.run.id}/seen`)).status).toBe(200);
        const afterSeen = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        expect(afterSeen.unread).toBe(false);

        internalHeaders = (await startInternalFixtureTurn(bot.id)).headers;
        const grounded = await fetch(
          `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
          { headers: internalHeaders },
        );
        const groundedBody = z.object({
          routines: z.array(z.object({
            id: z.string(),
            latestRun: z.object({
              status: z.string(),
              scheduledFor: z.string().nullable(),
              startedAt: z.string().nullable(),
              finishedAt: z.string().nullable(),
              output: z.string().nullable(),
              error: z.string().nullable(),
              executionThreadId: z.string().nullable(),
            }).nullable(),
          }).passthrough()),
        }).parse(await grounded.json());
        expect(groundedBody.routines.find((routine) => routine.id === routineId)?.latestRun).toMatchObject({
          status: "failed",
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          error: expect.stringMatching(/This bot's AI connection is unavailable.*App Settings/i),
          executionThreadId: runCards[0].routineRun.executionThreadId,
        });
        // Run health (upstream #1564) reaches the bot with the routine.
        expect(groundedBody.routines.find((routine) => routine.id === routineId)).toMatchObject({ overlap: "skip", failureStreak: 1 });
        expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
        await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id)?.busy,
        { timeout: 5_000 }).toBe(false);
        // The bot now has an execution task too: routine runs inherit the
        // bot defaults, so write those explicitly (N7, 89a41bd7).
        expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "ghost", model: "unavailable-fixture" }, settingsScope: "defaults",
        })).status).toBe(200);
      } finally {
        routineEvents.close();
      }

      // A deleted source conversation is a safe fallback, not an instruction
      // to recreate its transcript. The run still gets its detached receipt
      // and failure, but no lifecycle message is written to the orphan id.
      const orphanSource = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Temporary routine source" });
      expect(orphanSource.status).toBe(201);
      const orphanThreadId = z.object({
        task: z.object({ threadId: z.string() }),
      }).parse(orphanSource.body).task.threadId;
      internalHeaders = (await startInternalFixtureTurn(bot.id)).headers;
      const orphanProposalResponse = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: orphanThreadId,
          action: "create",
          routine: {
            name: "Orphan-safe brief",
            instructions: "Summarize without recreating the deleted source.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "ember",
          },
        }),
      });
      expect(orphanProposalResponse.status).toBe(201);
      const orphanProposal = z.object({ requestId: z.string() }).parse(await orphanProposalResponse.json());
      const orphanConfirmed = await desktopApi("POST", `/api/threads/${orphanThreadId}/respond`, {
        requestId: orphanProposal.requestId,
        behavior: "allow",
      });
      expect(orphanConfirmed.status).toBe(200);
      orphanRoutineId = orphanConfirmed.body.resultId;
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: orphanThreadId })).status).toBe(200);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)?.busy,
      { timeout: 5_000 }).toBe(false);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost", model: "unavailable-fixture" }, settingsScope: "defaults",
      })).status).toBe(200);
      expect((await desktopApi("DELETE", `/api/bots/${bot.id}/tasks/${orphanThreadId}`)).status).toBe(200);
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      const orphanRun = await desktopApi("POST", `/api/routines/${orphanRoutineId}/run`);
      expect(orphanRun.status).toBe(201);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === orphanRun.body.run.id)?.status;
      }, { timeout: 5_000 }).toBe("failed");
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      // Calendar-created routines may predate chat-card redaction. Listing
      // them to a model must redact the whole prompt before returning its
      // bounded preview, and tell the model when that preview is incomplete.
      const fakeSecret = `Bearer ${"a".repeat(24)}`;
      const fakeNameSecret = `sk-proj-${"b".repeat(24)}`;
      const legacy = await desktopApi("POST", "/api/routines", {
        name: `Legacy ${fakeNameSecret}`,
        prompt: `${fakeSecret}\n${"Review the archive. ".repeat(180)}`,
        botId: bot.id,
        runOn: "ember",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      legacyRoutineId = legacy.body.routine.id;
      // Deleting the active orphan task selected another surviving task;
      // explicitly return to the original source before obtaining its grant.
      expect((await api("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).status).toBe(200);
      internalHeaders = (await startInternalFixtureTurn(bot.id)).headers;
      const listed = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(listed.status).toBe(200);
      const listedBody = z.object({
        routines: z.array(z.object({
          id: z.string(),
          instructions: z.string(),
          instructionsTruncated: z.boolean(),
        }).passthrough()),
      }).parse(await listed.json());
      const legacyResult = listedBody.routines.find((routine) => routine.id === legacyRoutineId)!;
      expect(legacyResult.instructions).not.toContain(fakeSecret);
      expect(legacyResult.name).not.toContain(fakeNameSecret);
      expect(legacyResult.instructions).toContain("redacted");
      expect(legacyResult.instructionsTruncated).toBe(true);

      const wrongThread = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: "not-this-bots-thread",
          action: "pause",
          routineId,
        }),
      });
      expect(wrongThread.status).toBe(403);
    } finally {
      if (legacyRoutineId) await desktopApi("DELETE", `/api/routines/${legacyRoutineId}`);
      if (orphanRoutineId) await desktopApi("DELETE", `/api/routines/${orphanRoutineId}`);
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`);
      for (const task of (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.tasks ?? []) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: task.threadId }).catch(() => undefined);
      }
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("a skill or routine proposed from a room is reviewed by the bot that proposed it", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {})).body.bot;
    let room: any;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { skillRecorder: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
      room = (await api("POST", "/api/groups", { name: "Room proposals", memberIds: [bot.id] })).body.group;
      expect((await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "prepare a skill and a routine" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{ mcpConfig: { mcpServers: { agents: { env: { MURAGE_COMMS_TOKEN: string } } } } }>(fakeClaudeDump);
      const headers = { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" };
      const card = async (requestId: string) => {
        const state = (await api("GET", "/api/bots?messages=50")).body;
        return state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === requestId);
      };
      const skill = await fetch(`${BASE}/api/internal/skills/stage`, { method: "POST", headers, body: JSON.stringify({
        fromBotId: bot.id, fromThreadId: room.threadId, action: "create", source: "conversation", gist: "Room skill",
        skill_md: "---\nname: room-skill\ndescription: Room skill\n---\n\n# room-skill\n\nDo the reviewed thing.\n" }) });
      expect(skill.status).toBe(201);
      const staged = await skill.json() as { summary: string };
      const skillMessage = (await api("GET", "/api/bots?messages=50")).body.groups.find((candidate: { id: string }) => candidate.id === room.id)
        ?.messages.find((message: { card?: { skillRequest?: unknown } }) => message.card?.skillRequest);
      expect(skillMessage?.from?.botId, staged.summary).toBe(bot.id);
      const reviewed = await desktopApi("POST", `/api/threads/${room.threadId}/respond`, { requestId: skillMessage.card.requestId, behavior: "allow", reviewedSha256: skillMessage.card.skillRequest.sha256 });
      expect(reviewed).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
      const routine = await fetch(`${BASE}/api/internal/routine-requests`, { method: "POST", headers, body: JSON.stringify({
        fromBotId: bot.id, fromThreadId: room.threadId, action: "create",
        routine: { name: "Room brief", instructions: "Summarize the room.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] }, runOn: "ember" } }) });
      expect(routine.status).toBe(201);
      const proposed = await routine.json() as { requestId: string };
      expect((await card(proposed.requestId))?.from?.botId).toBe(bot.id);
      const confirmed = await desktopApi("POST", `/api/threads/${room.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" });
      expect(confirmed.status).toBe(200);
      const made = (await api("GET", "/api/routines")).body.routines.find((item: { id: string }) => item.id === confirmed.body.resultId);
      expect(made).toMatchObject({ botId: bot.id, sourceThreadId: room.threadId });
      if (confirmed.body.resultId) await desktopApi("DELETE", `/api/routines/${confirmed.body.resultId}`);
    } finally {
      if (room) { await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined); await desktopApi("DELETE", `/api/groups/${room.id}`).catch(() => undefined); }
      await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it("only enables the exact learned-skill proposal a current client reviewed", async () => {
    const bot = (await desktopApi("POST", "/api/bots", {})).body.bot;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { skillRecorder: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a skill" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { MURAGE_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const stage = async (
        name: string,
        extraInstructions = "",
        action: "create" | "update" = "create",
        description = `Use ${name} safely.`,
      ) => {
        const response = await fetch(`${BASE}/api/internal/skills/stage`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            fromBotId: bot.id,
            fromThreadId: bot.threadId,
            action,
            skill_name: action === "update" ? name : undefined,
            source: "conversation",
            gist: description,
            skill_md: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the reviewed thing.\n${extraInstructions}`,
          }),
        });
        expect(response.status).toBe(201);
        const state = (await api("GET", "/api/bots")).body;
        const cards = state.bots
          .find((candidate: { id: string }) => candidate.id === bot.id)
          ?.messages.filter((message: { card?: { skillRequest?: { name?: string; action?: string } } }) =>
            message.card?.skillRequest?.name === name && message.card.skillRequest.action === action,
          );
        const card = cards?.[cards.length - 1]?.card;
        expect(card?.title).toBe(action === "create" ? `Enable skill "${name}"?` : `Update skill "${name}"?`);
        expect(card?.options).toEqual([action === "create" ? "Enable" : "Update", "Deny"]);
        expect(card?.skillRequest?.action).toBe(action);
        expect(card?.skillRequest?.preview).toContain(`# ${name}`);
        expect(card?.skillRequest?.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(createHash("sha256").update(card.skillRequest.preview).digest("hex"))
          .toBe(card.skillRequest.sha256);
        return card as {
          requestId: string;
          skillRequest: { action: "create" | "update"; preview: string; sha256: string };
        };
      };

      const stagedSecret = `Bearer ${"a".repeat(24)}`;
      const first = await stage("reviewed-skill-one", `Use ${stagedSecret} when calling the API.\n`);
      expect(first.skillRequest.preview).not.toContain(stagedSecret);
      expect(first.skillRequest.preview).toContain("redacted");
      const stagedMessage = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === first.requestId);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/cards/${stagedMessage.id}`, {
        answered: "allow",
      })).status).toBe(409);
      const missingHash = await desktopApi("POST", `/api/bots/${bot.id}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
      });
      expect(missingHash.status).toBe(409);
      expect(missingHash.body.error).toMatch(/reviewedSha256/);

      const wrongHash = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
        reviewedSha256: "0".repeat(64),
      });
      expect(wrongHash.status).toBe(409);
      expect(wrongHash.body.error).toMatch(/reviewedSha256/);

      const approvedByBotRoute = await desktopApi("POST", `/api/bots/${bot.id}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
        reviewedSha256: first.skillRequest.sha256,
      });
      expect(approvedByBotRoute).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });

      const updated = await stage(
        "reviewed-skill-one",
        "Use only the newly reviewed workflow.\n",
        "update",
        "Uses the revised reviewed workflow.",
      );
      const beforeUpdate = await desktopApi("GET", `/api/bots/${bot.id}/skills/reviewed-skill-one`);
      expect(beforeUpdate).toMatchObject({ status: 200, body: { text: first.skillRequest.preview } });
      expect(beforeUpdate.body.text).not.toBe(updated.skillRequest.preview);

      const stagedListing = await fetch(
        `${BASE}/api/internal/skills?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(stagedListing.status).toBe(200);
      const stagedInventory = await stagedListing.json() as {
        staged: Array<{ name: string; action: string }>;
      };
      expect(stagedInventory.staged).toMatchObject([{ name: "reviewed-skill-one", action: "update" }]);
      expect(JSON.stringify(stagedInventory)).not.toContain("baseSha256");
      expect(JSON.stringify(stagedInventory)).not.toContain("baseAppliedStageId");

      const approvedUpdate = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: updated.requestId,
        behavior: "allow",
        reviewedSha256: updated.skillRequest.sha256,
      });
      expect(approvedUpdate).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
      expect(await desktopApi("GET", `/api/bots/${bot.id}/skills/reviewed-skill-one`))
        .toMatchObject({ status: 200, body: { text: updated.skillRequest.preview } });

      const deniedUpdate = await stage(
        "reviewed-skill-one",
        "This replacement must never land.\n",
        "update",
        "A denied replacement.",
      );
      expect(await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: deniedUpdate.requestId,
        behavior: "deny",
      })).toMatchObject({ status: 200, body: { outcome: "rejected" } });
      expect(await desktopApi("GET", `/api/bots/${bot.id}/skills/reviewed-skill-one`))
        .toMatchObject({ status: 200, body: { text: updated.skillRequest.preview } });

      const staleUpdate = await stage(
        "reviewed-skill-one",
        "This proposal will become stale.\n",
        "update",
        "A stale replacement.",
      );
      // Native discovery is per task: each turn links its pinned copy under
      // threads/<id>/.agents/skills, never the bot workspace root. The bytes
      // a staged update is checked against are the reviewed revision the
      // manifest selects in the bot's canonical skills/.revisions store.
      const revisionsRoot = join(home, ".murage", "workspaces", bot.id, "skills", ".revisions");
      const selectedRevisions = readdirSync(revisionsRoot)
        .map((revision) => join(revisionsRoot, revision, "SKILL.md"))
        .filter((path) => existsSync(path) && readFileSync(path, "utf8") === updated.skillRequest.preview);
      expect(selectedRevisions).toHaveLength(1);
      const skillPath = selectedRevisions[0]!;
      writeFileSync(skillPath, updated.skillRequest.preview.replace("newly reviewed", "changed after staging"));
      const staleResponse = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: staleUpdate.requestId,
        behavior: "allow",
        reviewedSha256: staleUpdate.skillRequest.sha256,
      });
      expect(staleResponse.status).toBe(422);
      expect(staleResponse.body.error).toMatch(/changed after this update was proposed/);
      const staleCard = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) =>
          message.card?.requestId === staleUpdate.requestId,
        )?.card;
      expect(staleCard?.held).toMatch(/changed after this update was proposed/);
      writeFileSync(skillPath, updated.skillRequest.preview);
      expect(await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: staleUpdate.requestId,
        behavior: "allow",
        reviewedSha256: staleUpdate.skillRequest.sha256,
      })).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
      const recoveredCard = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) =>
          message.card?.requestId === staleUpdate.requestId,
        )?.card;
      expect(recoveredCard?.answered).toBe("allow");
      expect(recoveredCard?.held).toBeUndefined();

      const second = await stage("reviewed-skill-two");
      const approvedByThreadRoute = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: second.requestId,
        behavior: "allow",
        reviewedSha256: second.skillRequest.sha256,
      });
      expect(approvedByThreadRoute).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });

      const denied = await stage("reviewed-skill-denied");
      const deniedWithoutHash = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: denied.requestId,
        behavior: "deny",
      });
      expect(deniedWithoutHash).toMatchObject({ status: 200, body: { outcome: "rejected" } });

      // Denial is still safe when a crash or later cleanup has already lost
      // the staged bytes. Settle the durable card instead of trapping the
      // composer behind a proposal that can no longer be applied.
      const missingStage = await stage("reviewed-skill-missing-stage");
      writeFileSync(
        join(home, ".murage", "skill-state", bot.id, "staged.json"),
        `${JSON.stringify({ writes: {} }, null, 2)}\n`,
      );
      expect(await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: missingStage.requestId,
        behavior: "deny",
      })).toMatchObject({ status: 200, body: { outcome: "rejected" } });
      const missingStageCard = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) =>
          message.card?.requestId === missingStage.requestId,
        )?.card;
      expect(missingStageCard).toMatchObject({ answered: "deny", dismissed: true });

      // Deleting the only transcript that owns a pending card must also drop
      // its bot-scoped stage; otherwise the invisible proposal reserves its
      // name until the 30-day expiry.
      await stage("deleted-task-skill");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      const nextTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "next task" });
      expect(nextTask).toMatchObject({ status: 201 });
      const nextThreadId = nextTask.body.task.threadId as string;
      expect((await desktopApi("DELETE", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).status).toBe(200);

      const listing = await fetch(
        `${BASE}/api/internal/skills?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(nextThreadId)}`,
        { headers: (await startInternalFixtureTurn(bot.id)).headers },
      );
      expect(listing.status).toBe(200);
      const inventory = await listing.json() as {
        skills: Array<{ name: string; enabled: boolean }>;
        staged: Array<{ name: string }>;
      };
      expect(inventory.skills).toMatchObject([
        { name: "reviewed-skill-one", enabled: true },
        { name: "reviewed-skill-two", enabled: true },
      ]);
      expect(inventory.skills.some((skill) => skill.name === "reviewed-skill-denied")).toBe(false);
      expect(inventory.staged).toEqual([]);

      // An approved skill reaches the engine through the next task's pin. The
      // listing above dispatched a held turn on that task, which pinned the latest
      // approved bytes of both skills and linked them for native discovery in its desk.
      const nextTaskState = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.tasks.find((task: { threadId: string }) => task.threadId === nextThreadId);
      const bundleId = nextTaskState?.procedurePin?.bundleId as string;
      expect(bundleId).toMatch(/^[a-f0-9]{64}$/);
      const desk = join(home, ".murage", "workspaces", bot.id, "threads", nextThreadId);
      const pinnedSkill = join(desk, ".murage-procedures", bundleId, "skills", "reviewed-skill-one", "SKILL.md");
      const nativeSkill = join(desk, ".agents", "skills", "reviewed-skill-one", "SKILL.md");
      await expect.poll(() => existsSync(nativeSkill), { timeout: 5_000 }).toBe(true);
      expect(readFileSync(pinnedSkill, "utf8")).toBe(staleUpdate.skillRequest.preview);
      expect(readFileSync(join(desk, ".murage-procedures", bundleId, "skills", "reviewed-skill-two", "SKILL.md"), "utf8"))
        .toBe(second.skillRequest.preview);
      expect(realpathSync.native(nativeSkill)).toBe(realpathSync.native(pinnedSkill));
    } finally {
      await desktopApi("PATCH", "/api/config", { features: { skillRecorder: false } });
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("validates the non-secret VPS alias and keeps old bots on Box by default", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    expect(bot.cloudBackend).toBeUndefined();

    const bad = await desktopApi("PUT", "/api/config", { vps: { sshAlias: "prod; reboot" } });
    expect(bad.status).toBe(400);

    const saved = await desktopApi("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
    expect(saved.status).toBe(200);
    expect(saved.body.vps).toEqual({ configured: true, sshAlias: "production-vps" });
    expect(JSON.stringify(saved.body)).not.toContain("privateKey");

    const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.cloudBackend).toBe("vps");
    const autoStart = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoStartVps: true });
    expect(autoStart.status).toBe(200);
    expect(autoStart.body.bot.autoStartVps).toBe(true);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoStartVps: "yes" })).status).toBe(400);
    const invalid = await desktopApi("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "daytona" });
    expect(invalid.status).toBe(400);
  });

  it("ignores an own project key, keeps externally stored secrets off disk, and runs connected apps through Flux Router", async () => {
    const saved = await desktopApi("PUT", "/api/config?secretStorage=external", {
      composio: { apiKey: "ak_good" },
      opencodeGo: { apiKey: "opencode-external" },
      profile: { name: "External Store" },
    });
    expect(saved.status).toBe(200);
    // The old key is accepted and ignored: this build's apps come from the
    // fake Flux broker, never from the key.
    expect(saved.body.composio).toMatchObject({
      configured: true,
      mode: "managed",
      broker: "flux",
      fluxBrokerEnabled: true,
      ownKeyRetired: false,
    });
    expect(saved.body.opencodeGo).toEqual({ configured: true });
    expect(saved.body.profile).toEqual({ name: "External Store", email: "" });
    expect(JSON.stringify(saved.body)).not.toContain("ak_good");

    const disk = JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8"));
    expect(disk.composio?.apiKey ?? "").toBe("");
    expect(disk.opencodeGo).toEqual({ apiKey: "" });
    expect(disk.profile).toEqual({ name: "External Store" });
    expect(JSON.stringify(disk)).not.toContain("ak_good");
    expect(JSON.stringify(disk)).not.toContain("opencode-external");

    // A later ordinary setting save keeps the same answer.
    expect((await desktopApi("PUT", "/api/config", { profile: { name: "Grace" } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.composio).toMatchObject({ configured: true, mode: "managed" });
  });

  it.skipIf(process.platform === "win32")("stores the credentials file with owner-only permissions", () => {
    expect(statSync(join(home, ".murage", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await desktopApi("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await desktopApi("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
    // any other surface is shown the name, not the email (0.1.61 audit round 2)
    expect((await api("GET", "/api/config")).body.profile).toEqual({ name: "Ada Lovelace", email: "" });
  });

  it("creates an independent webhook, accepts a delivery, deduplicates it, and rotates its secret", async () => {
    const bots = await api("GET", "/api/bots");
    const created = await desktopApi("POST", "/api/webhooks", {
      name: "Incoming build",
      prompt: "Review the incoming build event",
      botId: bots.body.bots[0].id,
      runOn: "ember",
    });
    expect(created.status).toBe(201);
    expect(created.body.ingress).toMatchObject({ available: true, baseUrl: WEBHOOK_BASE });
    expect(created.body.credential.url).toMatch(new RegExp(`^${WEBHOOK_BASE}/hooks/wh_`));

    const listed = await desktopApi("GET", "/api/webhooks");
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.body.attempts).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.credential.secret);

    const deliver = () => fetch(created.body.credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "build-42" },
      body: JSON.stringify({ status: "failed", build: 42, origin: { kind: "local-manual" }, budgetId: "payload-cannot-set-budget" }),
    });
    const first = await deliver();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { runId: string; accepted: boolean; duplicate: boolean };
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const retry = await deliver();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: accepted.runId });

    const afterDelivery = await desktopApi("GET", "/api/webhooks");
    expect(afterDelivery.body.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(["accepted", "duplicate"]);

    const receipts = await api("GET", "/api/routines");
    expect(receipts.body.runs.find((run: { id: string }) => run.id === accepted.runId)).toMatchObject({
      triggerSource: "webhook",
      deliveryId: "build-42",
      routineName: "Incoming build",
      event: { version: 1, id: accepted.runId, source: "webhook", definitionId: created.body.webhook.id,
        origin: { kind: "external-webhook", webhookId: created.body.webhook.id }, budgetId: accepted.runId },
    });
    const storedRun = readRoutinesWithRuns(join(home, ".murage", "routines.json")).runs.find((run: { id: string }) => run.id === accepted.runId);
    expect(storedRun.event).toEqual(receipts.body.runs.find((run: { id: string }) => run.id === accepted.runId).event);

    const rotated = await desktopApi("POST", `/api/webhooks/${created.body.webhook.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.credential.url).not.toBe(created.body.credential.url);
    expect((await deliver()).status).toBe(401);

    expect((await desktopApi("DELETE", `/api/webhooks/${created.body.webhook.id}`)).status).toBe(200);
    expect((await desktopApi("GET", "/api/webhooks")).body.webhooks).toHaveLength(0);
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".murage", "webhooks.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores OpenCode Go credentials as a configured-only status", async () => {
    const put = await desktopApi("PUT", "/api/config", { opencodeGo: { apiKey: "opencode-secret" } });
    expect(put.status).toBe(200);
    expect(put.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("opencode-secret");

    const after = await api("GET", "/api/config");
    expect(after.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("opencode-secret");
  });

  it("stores the avatar image key as configured-only status", async () => {
    try {
      const put = await desktopApi("PUT", "/api/config", { imageGen: { key: "sk-image-secret" } });
      expect(put.status).toBe(200);
      expect(put.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(put.body)).not.toContain("sk-image-secret");

      const after = await api("GET", "/api/config");
      expect(after.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(after.body)).not.toContain("sk-image-secret");
    } finally {
      await desktopApi("PUT", "/api/config", { imageGen: { key: "" } });
    }
  });

  it("rejects a non-string OpenCode Go API key", async () => {
    const bad = await desktopApi("PUT", "/api/config", { opencodeGo: { apiKey: 123 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("opencodeGo.apiKey");

    const array = await desktopApi("PUT", "/api/config", { opencodeGo: [] });
    expect(array.status).toBe(400);
    expect(array.body.error).toContain("opencodeGo");
  });

  it("never hands a client the provider session cursors", async () => {
    // resumeCursors is the harness's own bookkeeping. It reached clients for
    // a long time as harmless noise; once a phone is a client it is provider
    // session state leaving the machine, so nothing carrying a bot may have it.
    const listed = await api("GET", "/api/bots");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    const created = await desktopApi("POST", "/api/bots");
    const botId = created.body.bot.id;
    try {
      expect(created.body.bot).not.toHaveProperty("resumeCursors");
      const patched = await desktopApi("PATCH", `/api/bots/${botId}`, { name: "Cursorless" });
      expect(patched.body.bot).not.toHaveProperty("resumeCursors");

      const task = await api("POST", `/api/bots/${botId}/tasks`, {});
      expect(task.body.bot).not.toHaveProperty("resumeCursors");
      for (const t of task.body.bot.tasks ?? []) expect(t).not.toHaveProperty("resumeCursors");
      // the task alone, not just the bot it came attached to
      expect(task.body.task).not.toHaveProperty("resumeCursors");
      const renamed = await api("PATCH", `/api/bots/${botId}/tasks/${task.body.task.threadId}`, {
        title: "Cursorless task",
      });
      expect(renamed.body.task).not.toHaveProperty("resumeCursors");

      // and the same on the wire, not just in the HTTP responses
      const stream = await openSse(`${BASE}/api/events`);
      try {
        await desktopApi("PATCH", `/api/bots/${botId}`, { unread: true });
        const frame = await stream.until((f) => f.kind === "bot");
        expect(frame.bot).not.toHaveProperty("resumeCursors");
        expect(JSON.stringify(frame)).not.toContain("resumeCursors");
      } finally {
        stream.close();
      }
    } finally {
      await desktopApi("DELETE", `/api/bots/${botId}`);
    }
  });

  it("validates the event inspector limit at the HTTP boundary", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      const response = await desktopApi("GET", `/api/threads/${bot.threadId}/events?limit=${value}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("positive whole number");
    }
    const ok = await desktopApi("GET", `/api/threads/${bot.threadId}/events?limit=1`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.entries)).toBe(true);
    expect(ok.body.total).toEqual({ runtime: expect.any(Number), native: expect.any(Number) });
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await desktopApi("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
    // anyone else learns nothing about which routes exist (route-policy.ts)
    expect((await api("GET", "/api/definitely-not-a-route")).body).toEqual({ error: "no such route" });
  });
});
