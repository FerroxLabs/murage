// DESIGN-CARDRED H1: a card the owner settles while an enforced AI review is
// still thinking must never come back as "waiting on you" when the review
// returns. The owner's Allow (H1a) or Stop (H1b) settles the card first; the
// held reviewer one-shot is released afterwards with an allow verdict.
//
// The engine is the fake Claude CLI: the permission fixture asks about one
// command, and its one-shot helper (the reviewer) waits for a gate file.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const MARKER = "attention-race-fixture";

interface MessageView { id: string; card?: { requestId?: string; requestHandle?: string; tool?: string; answered?: string } }
interface BotView { id: string; threadId: string; busy: boolean; activity?: string }

describe("a card settled while the enforced review is still thinking", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let gate: string;
  // While this file is missing, the tool the owner allowed keeps running: the turn is still working when the review returns.
  let afterGate: string;
  let seen: string;
  // The server's retained approval-attention counts, written by the test preload (testing/attention-stats-preload.mjs).
  let statsFile: string;
  // While this file exists, the next engine card's presentation return is held by the preload (W10).
  let holdFile: string;
  let stderr = "";
  // The owner's desktop proof, read from the server once it is up (as decision-log-wiring does).
  let desktopHeaders: Record<string, string> = {};

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  const api = (method: string, path: string, body?: unknown) => request(method, path, body);
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
  const botView = async (id: string): Promise<BotView | undefined> =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
  const messagesOf = async (threadId: string): Promise<MessageView[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as MessageView[];
  const reviewPids = (): number[] => existsSync(seen)
    ? readFileSync(seen, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; prompt: string }).filter(entry => entry.prompt.includes(MARKER)).map(entry => entry.pid)
    : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  /** An Ask bot with the reviewer enforced: a command no grant covers opens a base ("no-grant") card and the review runs (held).
   * Auto would answer the command itself ("auto-mode"), so no card would open and no review would run. */
  const reviewedBot = async (name: string) => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off", autoApprove: false, autoReview: "enforce" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.autoReview).toBe("enforce");
    return bot;
  };

  /** Send the permission fixture; return the open card once the reviewer for it is in flight (and still held).
   * With `working`, the allowed tool keeps the turn working until afterGate is written. */
  const cardUnderReview = async (bot: BotView, { working }: { working: boolean }) => {
    if (existsSync(gate)) unlinkSync(gate);
    if (working) { if (existsSync(afterGate)) unlinkSync(afterGate); } else writeFileSync(afterGate, "go");
    const before = reviewPids().length;
    // The owner types it in the app: an attended turn, so the enforced reviewer runs.
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER}` })).status).toBe(202);
    await expect.poll(() => reviewPids().length, { timeout: 20_000 }).toBeGreaterThan(before);
    let card: MessageView | undefined;
    await expect.poll(async () => {
      card = (await messagesOf(bot.threadId)).find(message => message.card?.requestHandle && !message.card.answered);
      return Boolean(card);
    }, { timeout: 20_000 }).toBe(true);
    return { card: card!, reviewer: reviewPids().at(-1)! };
  };

  /** Release the reviewer with its allow verdict, wait until it has answered and exited, then watch the bot for a while. */
  const releaseAndWatch = async (bot: BotView, reviewer: number) => {
    writeFileSync(gate, "go");
    await expect.poll(() => alive(reviewer), { timeout: 20_000 }).toBe(false);
    const activities: (string | undefined)[] = [];
    for (let i = 0; i < 30; i++) {
      activities.push((await botView(bot.id))?.activity);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return activities;
  };

  interface AttentionCounts { scopes: number; cards: number; requests: number; waits: number; holds: number }
  /** The server's retained attention counts, from a sample it wrote after this call began. */
  const attentionCounts = async (): Promise<AttentionCounts> => {
    const from = Date.now();
    let sample: (AttentionCounts & { at: number }) | undefined;
    await expect.poll(() => {
      try { sample = JSON.parse(readFileSync(statsFile, "utf8")); } catch { return false; }
      return sample!.at > from;
    }, { timeout: 5_000, interval: 20 }).toBe(true);
    const { scopes, cards, requests, waits, holds } = sample!;
    return { scopes, cards, requests, waits, holds };
  };
  const NONE: AttentionCounts = { scopes: 0, cards: 0, requests: 0, waits: 0, holds: 0 };

  interface BoardCard { id: string; state: string; waitingOn?: { kind: string } | null; deskThreadId?: string }
  /** A project whose one card is assigned to the bot: the card run asks about the fixture command on the bot's desk.
   * Returns the open card once the reviewer for it is in flight (and still held). */
  const projectCardUnderReview = async (bot: BotView, name: string, { working }: { working: boolean }) => {
    if (existsSync(gate)) unlinkSync(gate);
    if (working) { if (existsSync(afterGate)) unlinkSync(afterGate); } else writeFileSync(afterGate, "go");
    const before = reviewPids().length;
    const made = await desktopApi("POST", "/api/groups", { name, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const group = made.body.group as { id: string };
    expect((await desktopApi("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Touch one file" } })).status).toBe(200);
    const created = await desktopApi("POST", `/api/groups/${group.id}/board/cards`, { clientId: `${name.toLowerCase().replaceAll(" ", "-")}-card`, title: "Touch the file", description: `__fixture_permission_tool__ ${MARKER}`, assigneeBotId: bot.id, writes: false });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const made1 = created.body.card as BoardCard & { revision: number };
    const started = await desktopApi("PATCH", `/api/groups/${group.id}/board/cards/${made1.id}`, { expectedRevision: made1.revision, action: "start" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const board = async (): Promise<BoardCard | undefined> => (await desktopApi("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: BoardCard) => entry.id === made1.id);
    await expect.poll(async () => (await board())?.deskThreadId, { timeout: 30_000 }).toBeTruthy();
    const desk = (await board())!.deskThreadId!;
    await expect.poll(() => reviewPids().length, { timeout: 30_000 }).toBeGreaterThan(before);
    let card: MessageView | undefined;
    await expect.poll(async () => {
      card = (await messagesOf(desk)).find(message => message.card?.requestHandle && !message.card.answered);
      return Boolean(card);
    }, { timeout: 20_000 }).toBe(true);
    return { board, desk, card: card!, reviewer: reviewPids().at(-1)! };
  };
  /** Release the reviewer with its allow verdict, wait until it has answered and exited, then watch the board card for a while. */
  const releaseAndWatchBoard = async (board: () => Promise<BoardCard | undefined>, reviewer: number) => {
    writeFileSync(gate, "go");
    await expect.poll(() => alive(reviewer), { timeout: 20_000 }).toBe(false);
    const seenStates: { state?: string; waiting?: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const current = await board();
      seenStates.push({ state: current?.state, waiting: current?.waitingOn?.kind });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return seenStates;
  };

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-attention-race-"));
    gate = join(home, "review-gate");
    afterGate = join(home, "tool-gate");
    seen = join(home, "review-seen.jsonl");
    statsFile = join(home, "attention-stats.json");
    holdFile = join(home, "present-hold");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_MODE: "happy",
            FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: `touch ./${MARKER}` }),
            FAKE_CLAUDE_ONE_SHOT_GATE: gate,
            FAKE_CLAUDE_PERM_AFTER_GATE: afterGate,
            FAKE_CLAUDE_ONE_SHOT_SEEN: seen,
            FAKE_CLAUDE_ONE_SHOT_TEXT: JSON.stringify({ allow: true, reason: "fixture reviewer allows" }),
          },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    // The same server env as decision-log-wiring: the dev desktop-secret route is open, so the owner's desktop proof can be read.
    child = spawn(process.execPath, [...fakeEngineImportArgs(), "--import", pathToFileURL(join(SERVER_DIR, "testing", "attention-stats-preload.mjs")).href, join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: { ...powerBlockTestEnv(),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        NODE_ENV: "test",
        MURAGE_ENGINE_EXCLUSION_PATH: process.env.MURAGE_ENGINE_EXCLUSION_PATH,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_TEST_ATTENTION_STATS: statsFile,
        MURAGE_TEST_PRESENT_HOLD: holdFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    expect(proof.body.secret).toMatch(/^[a-f0-9]{64}$/);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    if (existsSync(gate ?? "")) unlinkSync(gate);
    if (afterGate) writeFileSync(afterGate, "go");
    for (const file of [holdFile, `${holdFile}.held`]) if (holdFile && existsSync(file)) unlinkSync(file);
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("an owner Allow while the reviewer is still thinking leaves the bot working and the board card doing", async () => {
    const bot = await reviewedBot("Answered under review");
    const { card, reviewer } = await cardUnderReview(bot, { working: true });
    // The review is still out, so the owner has not been told to look yet.
    expect((await botView(bot.id))?.activity).not.toBe("waiting-on-you");
    const answered = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestHandle: card.card!.requestHandle, action: "allow" });
    expect(answered.status).toBe(200);
    await expect.poll(async () => (await messagesOf(bot.threadId)).find(message => message.id === card.id)?.card?.answered, { timeout: 10_000 }).toBeTruthy();
    const activities = await releaseAndWatch(bot, reviewer);
    writeFileSync(afterGate, "go");
    expect(activities, "the settled card came back as waiting on you").not.toContain("waiting-on-you");
  }, 90_000);

  it("Stop while the reviewer is thinking never brings the card back to waiting on you", async () => {
    const bot = await reviewedBot("Stopped under review");
    const { reviewer } = await cardUnderReview(bot, { working: false });
    expect((await desktopApi("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 10_000 }).toBe(false);
    const activities = await releaseAndWatch(bot, reviewer);
    expect(activities, "the stopped card came back as waiting on you").not.toContain("waiting-on-you");
  }, 90_000);
  it("an owner Allow on a project card run while the reviewer is still thinking keeps the board card doing, never on the owner", async () => {
    const bot = await reviewedBot("Project answered under review");
    const { board, desk, card, reviewer } = await projectCardUnderReview(bot, "Allow under review", { working: true });
    // The review is still out, so the board card is not parked on the owner yet.
    expect(await board()).toMatchObject({ state: "doing" });
    expect((await board())?.waitingOn).toBeNull();
    const answered = await desktopApi("POST", `/api/threads/${desk}/respond`, { requestHandle: card.card!.requestHandle, action: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const states = await releaseAndWatchBoard(board, reviewer);
    writeFileSync(afterGate, "go");
    expect(states, "the settled card parked the board card on the owner").toEqual(states.map(() => ({ state: "doing", waiting: undefined })));
  }, 120_000);

  it("Stop on a project card run while the reviewer is thinking leaves the board card stopped, never back on the owner", async () => {
    const bot = await reviewedBot("Project stopped under review");
    const { board, desk, reviewer } = await projectCardUnderReview(bot, "Stop under review", { working: false });
    expect((await desktopApi("POST", `/api/bots/${bot.id}/interrupt`, { threadId: desk })).status).toBe(200);
    await expect.poll(async () => (await board())?.waitingOn?.kind, { timeout: 20_000 }).toBe("stopped");
    const stopped = await board();
    const states = await releaseAndWatchBoard(board, reviewer);
    expect(states, "the stopped card came back as waiting on the owner").toEqual(states.map(() => ({ state: stopped?.state, waiting: "stopped" })));
  }, 120_000);
  // design1019-approval-attention W33 H. A room turn has no direct run, so no direct-release callback retires it: the
  // completion fold is the route that must leave nothing of the finished generation behind.
  it("W33 normal completion and rebuild leave no old attention", async () => {
    const bot = await reviewedBot("Completed then asked again");
    const made = await desktopApi("POST", "/api/groups", { name: "Completion room", memberIds: [bot.id], setup: { bulletin: "Fixture only", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const room = made.body.group as { id: string; threadId: string };
    // The reviewer answers at once and the allowed tool finishes at once: each turn ends normally after the owner's Allow.
    writeFileSync(gate, "go");
    writeFileSync(afterGate, "go");
    expect(await attentionCounts(), "attention left by an earlier case").toEqual(NONE);
    const approvedTurn = async (label: string) => {
      const answeredBefore = (await messagesOf(room.threadId)).filter(message => message.card?.answered).length;
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER} ${label}` })).status).toBe(202);
      let card: MessageView | undefined;
      await expect.poll(async () => {
        card = (await messagesOf(room.threadId)).find(message => message.card?.requestHandle && !message.card.answered);
        return Boolean(card);
      }, { timeout: 30_000 }).toBe(true);
      // The actual engine approval is waiting on the owner in this turn's own scope.
      await expect.poll(async () => { const now = await attentionCounts(); return [now.scopes, now.cards, now.waits > 0]; }, { timeout: 20_000 }).toEqual([1, 1, true]);
      const answered = await desktopApi("POST", `/api/threads/${room.threadId}/respond`, { requestHandle: card!.card!.requestHandle, action: "allow" });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      await expect.poll(async () => (await messagesOf(room.threadId)).filter(message => message.card?.answered).length, { timeout: 20_000 }).toBe(answeredBefore + 1);
      await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 30_000 }).toBe(false);
    };
    await approvedTurn("first");
    // Before the next request: the finished generation's scope, cards, request index, waits and holds are all gone.
    await expect.poll(attentionCounts, { timeout: 5_000 }).toEqual(NONE);
    // The next admitted turn waits and resolves normally, and leaves nothing either.
    await approvedTurn("second");
    await expect.poll(attentionCounts, { timeout: 5_000 }).toEqual(NONE);
  }, 180_000);

  // design1019-approval-attention W10 H, on the real server: the engine card's real presentApproval has returned (its card
  // message is in the thread) and the return is held; the owner's Stop retires the generation; a successor turn then shows its
  // own card; only then does the old presentation continue. It must not promote, review, index or flag anything.
  it("W10 a presentation returning after its generation retired recreates nothing and leaves the successor card unchanged", async () => {
    const bot = await reviewedBot("Held presentation");
    // The reviewer answers at once and the allowed tool finishes at once (as W33).
    writeFileSync(gate, "go");
    writeFileSync(afterGate, "go");
    expect(await attentionCounts(), "attention left by an earlier case").toEqual(NONE);
    const reviewsBefore = reviewPids().length;
    const openCards = async () => (await messagesOf(bot.threadId)).filter(message => message.card?.requestHandle && !message.card.answered);

    writeFileSync(holdFile, "hold");
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER} held` })).status).toBe(202);
    // The real presentation committed the card message, and its return is held: registered (PENDING), not yet promoted.
    await expect.poll(() => existsSync(`${holdFile}.held`), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await openCards()).length, { timeout: 10_000 }).toBe(1);
    const heldCard = (await openCards())[0]!;
    const held = await attentionCounts();
    expect([held.scopes, held.cards]).toEqual([1, 1]);
    expect((await botView(bot.id))?.activity).not.toBe("waiting-on-you");
    expect(reviewPids().length, "a review started before the card was promoted").toBe(reviewsBefore);

    // The owner's Stop retires the generation while the presentation is still held: nothing of it is retained.
    expect((await desktopApi("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 20_000 }).toBe(false);
    await expect.poll(attentionCounts, { timeout: 5_000 }).toEqual(NONE);
    expect(existsSync(`${holdFile}.held`), "the held presentation returned early").toBe(true);

    // A successor turn on the same thread shows its own card; its presentation is not held. Its enforced review is held
    // (as in the cases above), so its card stays presented and open for the owner.
    unlinkSync(gate);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER} successor` })).status).toBe(202);
    let successor: MessageView | undefined;
    await expect.poll(async () => {
      successor = (await openCards()).find(message => message.id !== heldCard.id);
      return Boolean(successor);
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => reviewPids().length, { timeout: 20_000 }).toBe(reviewsBefore + 1);
    const reviewer = reviewPids().at(-1)!;
    const shown = await attentionCounts();
    expect([shown.scopes, shown.cards, shown.requests]).toEqual([1, 1, 1]);

    // Now the old presentation returns. Watch well past its continuation: the successor's attention is unchanged, and the
    // retired card started no review (the first effect of a promoted card).
    unlinkSync(`${holdFile}.held`);
    await expect.poll(() => existsSync(`${holdFile}.released`), { timeout: 10_000 }).toBe(true);
    for (let i = 0; i < 15; i++) {
      expect(await attentionCounts(), "the returned presentation changed retained attention").toEqual(shown);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(reviewPids().length, "the retired generation's card was promoted and reviewed").toBe(reviewsBefore + 1);
    expect(alive(reviewer)).toBe(true);
    expect((await openCards()).map(message => message.id)).toContain(successor!.id);

    // The successor still resolves normally (the owner allows it while its review is out) and leaves nothing.
    const answered = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestHandle: successor!.card!.requestHandle, action: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    writeFileSync(gate, "go");
    await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 30_000 }).toBe(false);
    await expect.poll(attentionCounts, { timeout: 5_000 }).toEqual(NONE);
  }, 180_000);
});
