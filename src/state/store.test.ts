import { describe, expect, it, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  StoreProvider,
  configStatusFromFrame,
  initialState,
  loadSnapshotBoundary,
  openNotificationTarget,
  reducer,
  useStore,
  visibleNotificationThread,
  type Action,
  type Bot,
  type Group,
  type Message,
  type OptionCardData,
} from "./store";
import { intakeChips, type IntakeCardData } from "../../shared/intake-turn.js";
import { openLiveEvents, type LiveEventSourceLike, type LiveEventsPlatform } from "../lib/live-events";
import { openerAt } from "../../shared/bot-openers.js";
import type { RoutineRun } from "../lib/routines";

type SnapshotFrame =
  | { kind: "hello"; resumed: boolean; cursor: string }
  | { kind: "message"; threadId: string; message: { id: string } };

class SnapshotEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  message(frame: SnapshotFrame, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

describe("replacement snapshot boundary", () => {
  it("flushes bot frames without reconnecting when a peripheral snapshot fails", async () => {
    const sources: SnapshotEventSource[] = [];
    const applied: unknown[] = [];
    const pending: unknown[] = [];
    const scheduleRetry = vi.fn();
    let hydrated = false;
    const platform: LiveEventsPlatform = {
      createEventSource: (url) => {
        const source = new SnapshotEventSource(url);
        sources.push(source);
        return source;
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };
    const stop = openLiveEvents(
      {
        onSnapshotRequired: async () => {
          const chatReady = await loadSnapshotBoundary(
            async () => {},
            [{ key: "webhooks", load: async () => Promise.reject(new Error("webhooks unavailable")) }],
            (part, error) => scheduleRetry(part.key, error),
          );
          if (chatReady) {
            hydrated = true;
            applied.push(...pending.splice(0));
          }
          return chatReady;
        },
        onFrame: (frame) => {
          if (hydrated) applied.push(frame);
          else pending.push(frame);
        },
        retryMinMs: 1,
        retryMaxMs: 1,
      },
      platform,
    );

    sources[0]!.message({ kind: "hello", resumed: false, cursor: "stream00:4" });
    sources[0]!.message(
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
      "stream00:5",
    );
    await vi.waitFor(() => expect(applied).toHaveLength(1));

    expect(applied).toEqual([
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
    ]);
    expect(scheduleRetry).toHaveBeenCalledWith("webhooks", expect.any(Error));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.close).not.toHaveBeenCalled();
    stop();
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];
  const groups = [{
    id: "room-1",
    threadId: "room-thread",
    tasks: [
      { threadId: "room-thread", title: "Current", createdAt: 1 },
      { threadId: "older-room-thread", title: "Older", createdAt: 0 },
    ],
  }];

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("opens the room and restores the exact inactive channel task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "older-room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });

  it("identifies only the exact chat thread currently on screen", () => {
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBe("main-thread");
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "room-1",
      bots,
      groups,
    })).toBe("room-thread");
    expect(visibleNotificationThread({
      activeView: "routines",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBeNull();
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
        features: { skillRecorder: true },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
      features: { skillRecorder: true },
    });
  });
});

describe("task rename", () => {
  it("updates the task title in local state immediately", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "New task", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const next = reducer(
      { ...initialState, bots: [bot] },
      { type: "renameTask", botId: bot.id, threadId: "t1", title: "Renamed" },
    );
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.title).toBe("Renamed");
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.title).toBe("Other");
  });

  it("updates a channel task title in local state immediately", () => {
    const group = {
      id: "room",
      threadId: "room-task-1",
      name: "Launch",
      memberIds: [],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
      tasks: [
        { threadId: "room-task-1", title: "New task", createdAt: 1 },
        { threadId: "room-task-2", title: "Other", createdAt: 2 },
      ],
    } satisfies Group;
    const next = reducer(
      { ...initialState, groups: [group] },
      { type: "renameGroupTask", groupId: group.id, threadId: "room-task-1", title: "Renamed" },
    );
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-1")?.title).toBe("Renamed");
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-2")?.title).toBe("Other");
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
describe("where a fresh sign-in lands", () => {
  const member = (id: string, name: string) => ({
    id,
    threadId: `t-${id}`,
    name,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
  }) as unknown as Bot;

  // A phone signs in with no stored selection, so this fallback IS its first
  // impression. It used to be `bots[0]` — creation order — which on Sean's
  // workspace meant landing on a teammate rather than on the Chief of Staff
  // that runs it. On the desktop the same line barely showed, because
  // `selectedId` persists and only a first run reaches it.
  it("opens the Chief of Staff, not whichever bot was made first", () => {
    const bruce = { ...member("bruce", "Bruce"), chiefOfStaff: true } as unknown as Bot;
    const sable = { ...member("sable", "Sable"), chiefOfStaff: true, chiefScope: "workspace" } as unknown as Bot;
    const next = reducer({ ...initialState, selectedId: "" }, {
      type: "hydrate",
      bots: [bruce, sable],
      groups: [],
      computerControl: {},
    } as never);
    expect(next.selectedId).toBe("sable");
  });

  it("keeps a selection the person already made", () => {
    const sable = { ...member("sable", "Sable"), chiefOfStaff: true, chiefScope: "workspace" } as unknown as Bot;
    const next = reducer({ ...initialState, selectedId: "bruce" }, {
      type: "hydrate",
      bots: [member("bruce", "Bruce"), sable],
      groups: [],
      computerControl: {},
    } as never);
    expect(next.selectedId).toBe("bruce");
  });

  it("falls back to the first bot when no Chief exists", () => {
    const next = reducer({ ...initialState, selectedId: "" }, {
      type: "hydrate",
      bots: [member("one", "One"), member("two", "Two")],
      groups: [],
      computerControl: {},
    } as never);
    expect(next.selectedId).toBe("one");
  });

  it("never opens a hidden Chief", () => {
    const hidden = { ...member("ghost", "Ghost"), chiefOfStaff: true, chiefScope: "workspace", hidden: true } as unknown as Bot;
    const next = reducer({ ...initialState, selectedId: "" }, {
      type: "hydrate",
      bots: [hidden, member("real", "Real")],
      groups: [],
      computerControl: {},
    } as never);
    expect(next.selectedId).toBe("real");
  });
});

  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("puts the quiz back when they ask for it, and does not delete the field", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const hidden = reducer(state, { type: "dismissCard", botId: bot.id, messageId: "q" });
    expect(hidden.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);

    const back = reducer(hidden, { type: "restoreCard", botId: bot.id, messageId: "q" });
    const card = back.bots[0]?.messages.find((message) => message.id === "q")?.card;
    // false, not absent: undefined means nobody decided, and the transcript
    // rule would hide the card again the moment anything follows it
    expect(card?.dismissed).toBe(false);
    expect(card?.answered).toBeUndefined();
    expect(card?.title).toBe(quizCard.title);
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  // 0.1.52 ASK2. A question is not a card you can wave away: whoever asked it
  // is waiting, so closing it has to mean something definite.
  const questionBot: Bot = {
    ...bot,
    messages: [
      ...bot.messages,
      {
        id: "ask",
        role: "bot",
        kind: "options",
        card: {
          title: "Question",
          subtitle: "Ship it?",
          options: ["Yes", "No"],
          requestId: "r1",
          questions: [
            { id: "q1", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: true },
          ],
        },
        at: 3,
      },
    ],
    activeLeafId: "ask",
  };
  const questionState = { ...initialState, bots: [questionBot], selectedId: questionBot.id };
  const askCard = (state: ReturnType<typeof reducer>) =>
    state.bots[0]?.messages.find((message) => message.id === "ask")?.card;

  it("never hides a live question locally — the server's patch settles it", () => {
    // Hiding it here would leave the bot waiting on a card nobody can see.
    // dismissCard's request branch sends an explicit skip instead.
    expect(askCard(reducer(questionState, { type: "dismissCard", botId: questionBot.id, messageId: "ask" }))?.dismissed).toBeUndefined();
    expect(askCard(reducer(questionState, { type: "send", botId: questionBot.id, text: "ok" }))?.dismissed).toBeUndefined();
  });

  it("waits for the server on an answer or a skip rather than guessing the outcome", () => {
    const actions: Action[] = [
      { type: "answerQuestion", threadId: "t1", requestId: "r1", behavior: "answer", answers: [{ id: "q1", selected: ["Yes"] }] },
      { type: "answerQuestion", threadId: "t1", requestId: "r1", behavior: "skip" },
      { type: "sendQuestionAsMessage", botId: "echo", threadId: "t1", requestId: "r1", text: "Q: Ship it?\nA: Yes", answers: [{ id: "q1", selected: ["Yes"] }] },
    ];
    for (const action of actions) {
      const next = reducer(questionState, action);
      expect(askCard(next)?.answered).toBeUndefined();
      expect(askCard(next)?.dismissed).toBeUndefined();
      expect(next).toBe(questionState);
    }
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      // A real opener rather than hand-written copy: the greeting is one of
      // the thirty in shared/bot-openers.ts, and that module's own test bans
      // em and en dashes. Pinning the fixture to it keeps this SSE frame
      // honest and keeps a stray dash from creeping back in here.
      text: openerAt(0, "Scout"),
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("routine receipt retention", () => {
  const run = (id: string, scheduledFor: number, status: RoutineRun["status"]): RoutineRun => ({
    id,
    routineId: "routine",
    routineName: "Check inbox",
    target: "bot",
    botId: "echo",
    runOn: "ember",
    scheduledFor,
    status,
    manual: false,
    createdAt: scheduledFor,
  });

  it("trims finished history without hiding older active work", () => {
    const waiting = run("waiting", 0, "waiting");
    const history = Array.from({ length: 2_000 }, (_, index) =>
      run(`finished-${index}`, index + 1, "completed"),
    );

    const hydrated = reducer(initialState, {
      type: "routinesHydrated",
      routines: [],
      runs: [waiting, ...history],
    });
    expect(hydrated.routineRuns).toHaveLength(2_000);
    expect(hydrated.routineRuns).toContainEqual(waiting);

    const running = { ...waiting, status: "running" as const, startedAt: 2_000 };
    const activePatched = reducer(hydrated, {
      type: "routineRunPatched",
      run: running,
    });
    expect(activePatched.routineRuns).toContainEqual(running);

    const next = reducer(activePatched, {
      type: "routineRunPatched",
      run: run("newest", 2_001, "completed"),
    });
    expect(next.routineRuns).toHaveLength(2_000);
    expect(next.routineRuns).toContainEqual(running);
    expect(next.routineRuns[0]?.id).toBe("newest");
  });
});

describe("canonical message races", () => {
  it("does not rewind the active branch when POST repeats a user message after the reply", () => {
    const sent = {
      id: "sent",
      role: "user",
      kind: "text",
      text: "Ship it",
      at: 1,
      parentId: null,
    } satisfies Message;
    const reply = {
      id: "reply",
      role: "bot",
      kind: "text",
      text: "Done",
      at: 2,
      parentId: sent.id,
    } satisfies Message;
    const bot = {
      id: "race-bot",
      threadId: "race-thread",
      name: "Race",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
      messages: [sent, reply],
      activeLeafId: reply.id,
    } satisfies Bot;
    const state = { ...initialState, bots: [bot] };

    const next = reducer(state, {
      type: "messageAdded",
      threadId: bot.threadId,
      message: sent,
    });

    expect(next).toBe(state);
    expect(next.bots[0]?.activeLeafId).toBe(reply.id);
    expect(next.bots[0]?.messages).toEqual([sent, reply]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  /** The Chief carries the workspace tier; a team leader does not. */
  const chief = (id: string, section: string) => ({ ...bot(id, section, true), chiefScope: "workspace" as const });

  // The renderer half of the Chief-vanishes bug. The server half was fixed by
  // exempting the workspace tier from the same-section demotion loop; this
  // reducer kept doing it, and because the server correctly changes nothing
  // it never emits a frame that would put her back. The wrong state sticks
  // until a full hydration — which is why she came back after a restart and
  // looked like a mystery.
  it("never demotes the workspace Chief when a team leader is elected", () => {
    // The DEFAULT workspace: nobody made a section, so the Chief and the new
    // leader share sectionKey "". This is the common case, not an edge one.
    const sable = chief("sable", "");
    const bruce = bot("bruce", "");
    const state = {
      ...initialState,
      bots: [sable, bruce].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, { type: "updateBot", botId: bruce.id, patch: { chiefOfStaff: true } });

    const after = next.bots.find((candidate) => candidate.id === sable.id);
    expect(after?.chiefOfStaff, "the Chief was fired by electing a team leader").toBe(true);
    expect(after?.chiefScope).toBe("workspace");
    expect(next.bots.find((candidate) => candidate.id === bruce.id)?.chiefOfStaff).toBe(true);
  });

  it("never demotes the workspace Chief on a broadcast frame either", () => {
    // The same loop exists twice. Fixing only the optimistic one would paint
    // correctly and then get it wrong a network round-trip later.
    const sable = chief("sable", "");
    const bruce = bot("bruce", "");
    const state = {
      ...initialState,
      bots: [sable, bruce].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, { type: "botPatched", bot: { ...bruce, chiefOfStaff: true } });

    expect(next.bots.find((candidate) => candidate.id === sable.id)?.chiefOfStaff).toBe(true);
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  // The tier and the lone-worker branch ride the same optimistic path as the
  // flag, and both have a shape the renderer must not persist: "section" is
  // a wire word meaning "drop the tier", and `individual: false` is spelled
  // as an absent field everywhere else in the app.
  it("mirrors a workspace handover optimistically and demotes the previous holder", () => {
    const ember = { ...bot("ember", ""), chiefOfStaff: true, chiefScope: "workspace" as const };
    const rex = { ...bot("rex", "Sales"), chiefOfStaff: true };
    const state = {
      ...initialState,
      bots: [ember, rex].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: rex.id,
      patch: { chiefOfStaff: true, chiefTier: "workspace", individual: false },
    });

    expect(next.bots.find((candidate) => candidate.id === rex.id)?.chiefScope).toBe("workspace");
    // demoted to leader of its own team, not fired — what the harness does
    expect(next.bots.find((candidate) => candidate.id === ember.id)?.chiefScope).toBeUndefined();
    expect(next.bots.find((candidate) => candidate.id === ember.id)?.chiefOfStaff).toBe(true);
  });

  it("never folds the wire-only tier word into a bot", () => {
    const rex = { ...bot("rex", "Sales"), chiefOfStaff: true, chiefScope: "workspace" as const };
    const state = { ...initialState, bots: [{ ...rex, messages: [] }] };

    const next = reducer(state, {
      type: "updateBot",
      botId: rex.id,
      patch: { chiefOfStaff: true, chiefTier: "section", individual: false },
    });

    expect(next.bots[0]?.chiefScope).toBeUndefined();
    expect(JSON.stringify(next.bots[0])).not.toContain("section\":\"section");
  });

  it("spells the lone-worker branch as absent, never false", () => {
    const bruce = { ...bot("bruce", "Smart Trader"), individual: true };
    const state = { ...initialState, bots: [{ ...bruce, messages: [] }] };

    const cleared = reducer(state, {
      type: "updateBot",
      botId: bruce.id,
      patch: { chiefOfStaff: false, chiefTier: null, individual: false },
    });
    expect(cleared.bots[0]?.individual).toBeUndefined();

    const set = reducer(cleared, {
      type: "updateBot",
      botId: bruce.id,
      patch: { chiefOfStaff: false, chiefTier: null, individual: true },
    });
    expect(set.bots[0]?.individual).toBe(true);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q1", text: "later" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q-ml", text: "line one\nline two" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued).toEqual({ t1: [{ queueId: "q-stay", text: "stay here" }] });
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued).toEqual({
      t1: [
        { queueId: "qa", text: "same" },
        { queueId: "qb", text: "same" },
      ],
    });
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued).toEqual({ t1: [{ queueId: "qb", text: "same" }] });
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("reconciles a missed drain from hydration and rejects its late POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    const canonical = {
      id: "m-snapshot",
      at: 100,
      role: "user",
      kind: "text",
      text: "already ran",
      queueId: "q-snapshot",
    } satisfies Message;
    const hydrated = reducer(queued, {
      type: "hydrate",
      bots: [{ ...bot, messages: [canonical] }],
      groups: [],
      computerControl: {},
    });

    expect(hydrated.pendingQueued).toEqual({});
    expect(hydrated.consumedQueueIds["q-snapshot"]).toBe(true);
    const late = reducer(hydrated, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["q-snapshot"]).toBeUndefined();
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });

  it("drops a cancelled pending chip without waiting for drain", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelQueued",
      botId: "b1",
      queueId: "q-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });

  it("drops a cancelled channel follow-up from its original task", () => {
    const queued = reducer(initialState, {
      type: "pendingQueued",
      threadId: "room-task-1",
      queueId: "q-room-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelGroupQueued",
      groupId: "room-1",
      threadId: "room-task-1",
      queueId: "q-room-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });
});

describe("messageAdded leaf adoption", () => {
  const baseBot = {
    id: "bot-1",
    threadId: "thread-1",
    messages: [
      { id: "m1", at: 1, role: "bot", kind: "text", text: "turn done" },
      { id: "m2", at: 2, parentId: "m1", role: "user", kind: "text", text: "next question" },
    ],
    activeLeafId: "m2",
  } as never as Bot;
  const state = { ...initialState, bots: [baseBot] };

  it("adopts the leaf for a message chaining onto it", () => {
    const next = reducer(state, {
      type: "messageAdded",
      threadId: "thread-1",
      message: { id: "m3", at: 3, parentId: "m2", role: "bot", kind: "text", text: "reply" } as never as Message,
    });
    expect(next.bots[0].activeLeafId).toBe("m3");
  });

  it("keeps the leaf when a late artifact is chain-inserted mid-branch", () => {
    // the settle-time screenshot arrives parented to m1 while m2 is the leaf
    const next = reducer(state, {
      type: "messageAdded",
      threadId: "thread-1",
      message: { id: "shot", at: 3, parentId: "m1", role: "bot", kind: "screen", png: "x" } as never as Message,
    });
    expect(next.bots[0].activeLeafId).toBe("m2"); // the user's message stays the tail
    expect(next.bots[0].messages.map((m) => m.id)).toContain("shot");
  });
});

// ── the renderer's half of three wire contracts ────────────────────────
//
// The first two are TYPE contracts, so the test that enforces them is
// `tsc -p tsconfig.json --noEmit` and not this runner: each fixture is
// written with `satisfies`, so deleting the field it pins fails the build
// with a real error. The runtime assertions below them are the weaker half
// — they check the value survives the reducer, which it would even with the
// type missing. Both halves are stated plainly rather than dressed up.
const bare = (id: string, name: string) => ({
  id,
  threadId: `t-${id}`,
  name,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "x", model: "y" },
  messages: [],
}) as unknown as Bot;

describe("wire shapes the renderer must declare", () => {
  it("carries an intake payload on an options card", () => {
    // Imported from shared/intake-turn.ts, never re-declared here: the
    // server's OptionCardData holds the same field from the same file, and
    // two declarations of one wire shape is how the two ends drift.
    const intake = {
      step: "confirm",
      outcome: "profile",
      candidate: { slug: "day-trader", name: "Day Trader", skillNames: ["Charting"] },
      asked: 2,
    } satisfies IntakeCardData;
    const card = {
      title: "Set this up?",
      subtitle: "Day Trader",
      // Never matched by label: chips are answered BY INDEX (see the CHIP
      // ORDER note in shared/intake-turn.ts). Built by the shared builder so
      // the wrong order is not expressible.
      options: [...intakeChips("confirm-profile")],
      intake,
    } satisfies OptionCardData;

    const bot = {
      ...bare("echo", "Echo"),
      messages: [{ id: "q", role: "bot", kind: "options", card, at: 1 }],
    } as unknown as Bot;
    const next = reducer({ ...initialState, bots: [bot] }, {
      type: "answerCard",
      botId: "echo",
      messageId: "q",
      answer: card.options[0]!,
    });
    // the payload is not dropped on the way through the reducer
    expect(next.bots[0]?.messages[0]?.card?.intake).toEqual(intake);
  });

  it("carries the installed package's required apps on a bot", () => {
    const installedPackage = {
      id: "trading-desk",
      name: "Trading Desk",
      release: "1.2.0",
      requiredApps: [
        { slug: "gmail", label: "Gmail", reason: "sends the morning note" },
        { slug: "slack", label: "Slack", reason: "posts alerts", optional: true },
      ],
    };
    // `satisfies Bot` is the assertion: without `installedPackage` declared on
    // the client Bot this line is an excess-property error, and no UI could
    // render which connected services the assistant needs.
    const packaged = { ...bare("packaged", "Packaged"), messages: [], installedPackage } satisfies Bot;

    const next = reducer(initialState, { type: "botPatched", bot: packaged } as never);
    expect(next.bots[0]?.installedPackage?.requiredApps.map((app) => app.slug)).toEqual(["gmail", "slack"]);
  });
});

// The one behavioral test of the three. It drives the REAL wrapped dispatch
// out of StoreProvider — rendered with `renderToStaticMarkup` because the
// renderer suite has no DOM — and watches `fetch`. Under Fizz the reducer's
// own dispatch is a no-op after the render returns, which is why the bot is
// seeded onto `initialState` (restored in `finally`) rather than dispatched
// in: `stateRef.current` is the object `useReducer` was initialised with.
describe("answerCard routing", () => {
  const seatedIntakeBot = {
    ...bare("echo", "Echo"),
    messages: [
      {
        id: "q",
        role: "bot",
        kind: "options",
        at: 1,
        card: {
          title: "Set this up?",
          subtitle: "Day Trader",
          options: [...intakeChips("confirm-profile")],
          intake: { step: "confirm", outcome: "profile", asked: 2 } satisfies IntakeCardData,
        },
      },
    ],
  } as unknown as Bot;

  const plainQuizBot = {
    ...bare("echo", "Echo"),
    messages: [
      {
        id: "q",
        role: "bot",
        kind: "options",
        at: 1,
        card: { title: "What for?", subtitle: "", options: ["Work & projects", "Personal"] },
      },
    ],
  } as unknown as Bot;

  /** Render the provider, seed `bot` as the reducer's initial state, press
   *  `answer` on message `q`, and return every URL fetch was asked for. */
  async function urlsFetchedFor(bot: Bot, answer: string): Promise<string[]> {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : String(input));
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as typeof fetch;
    initialState.bots.push(bot);
    try {
      let dispatch: ((action: never) => void) | null = null;
      const Probe = () => {
        dispatch = useStore().dispatch as unknown as (action: never) => void;
        return null;
      };
      renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
      expect(dispatch).toBeTypeOf("function");
      dispatch!({ type: "answerCard", botId: bot.id, messageId: "q", answer } as never);
      // `api()` awaits the desktop-surface probe (itself a fetch and a
      // `.json()`) before it sends anything, so the POST this test is
      // looking for lands several macrotasks later. Drained the same number
      // of times for both cases, so neither is given a different budget.
      for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      initialState.bots.length = 0;
      globalThis.fetch = realFetch;
    }
    return urls;
  }

  // The control that makes the test above meaningful: the harness CAN see the
  // chat route, so a green intake case is a guard working and not a rig that
  // never observes anything.
  it("posts an ordinary quiz answer to the chat route", async () => {
    const urls = await urlsFetchedFor(plainQuizBot, "Work & projects");
    expect(urls).toContain("/api/bots/echo/messages");
  });

  it("never posts an intake chip's label to the chat route", async () => {
    const urls = await urlsFetchedFor(seatedIntakeBot, intakeChips("confirm-profile")[0]);
    expect(urls).not.toContain("/api/bots/echo/messages");
    // and it does not settle the card behind the intake's back either
    expect(urls).not.toContain("/api/bots/echo/cards/q");
  });
});
