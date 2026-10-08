// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins a local fake engine and inert shadow
// entries so the suite is deterministic with or without agent CLIs installed
// and exercises the shadow-instance behavior end to end.
// Part 4 of 4: the smaller API groups.
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { writeBotPackageArchive } from "./bot-package-archive.ts";
import { createBotPackageEntry } from "./bot-package-manifest.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";

// These cases need connected apps, which run through Flux Router only: the
// harness points its build at a fake broker when this is set.
vi.hoisted(() => { process.env.MURAGE_TEST_FAKE_FLUX_BROKER = "1"; });
import { z } from "zod";
import { openSse } from "./testing/sse.ts";
import { intakeChips, intakeNarrowPickChips, type IntakeCandidate, type IntakeCardData } from "../shared/intake-turn.ts";
import { BASE, DESKTOP_HEADERS, DESKTOP_QUERY, DESKTOP_SECRET, FAKE_CLAUDE_CLI, PAIRED_PHONE, PORT, SERVER_DIR, STATE_ONLY_SELECTION, api, boxStubPort, browserMount, browserNativeEvents, browserSession, connectorAliasFixture, delayedJsonBody, desktopApi, fakeClaudeDump, home, readJsonFileWhenReady, setConnectorAliasFixture, startInternalFixtureTurn, stopFixtureTurn, storedMessageCount, turnMemoryOutcomes } from "./testing/index-harness.ts";
import { browserEngineRefusesHost } from "./testing/index-harness.ts";


describe("section context API", () => {
  it("keeps user-managed briefs isolated by live section and clears them explicitly", async () => {
    const work = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await desktopApi("PATCH", `/api/bots/${work.id}`, { section: "Work" });
      await desktopApi("PATCH", `/api/bots/${personal.id}`, { section: "Personal" });

      const saved = await desktopApi("PUT", "/api/section-context?section=Work", { text: "# Goals\n- Ship Friday" });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ section: "Work", label: "Work", text: "# Goals\n- Ship Friday" });
      expect(saved.body.updatedAt).toEqual(expect.any(Number));

      const read = await desktopApi("GET", "/api/section-context?section=%20Work%20");
      expect(read.body.text).toBe("# Goals\n- Ship Friday");
      expect((await desktopApi("GET", "/api/section-context?section=Personal")).body.text).toBe("");
      expect((await desktopApi("GET", "/api/section-context?section=")).body.label).toBe("General");

      const cleared = await desktopApi("PUT", "/api/section-context?section=Work", { text: "  " });
      expect(cleared.body).toMatchObject({ text: "", updatedAt: null });
      expect((await desktopApi("GET", "/api/section-context?section=Work")).body.text).toBe("");
    } finally {
      await desktopApi("DELETE", `/api/bots/${work.id}`);
      await desktopApi("DELETE", `/api/bots/${personal.id}`);
    }
  });

  it("rejects missing, unknown, invalid, and oversized section context writes", async () => {
    expect((await desktopApi("GET", "/api/section-context")).status).toBe(400);
    expect((await desktopApi("PUT", "/api/section-context?section=Missing", { text: "x" })).status).toBe(404);
    expect((await desktopApi("PUT", "/api/section-context?section=", { text: 7 })).status).toBe(400);
    const oversized = await desktopApi("PUT", "/api/section-context?section=", { text: "x".repeat(24_001) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain("24KB");
  });

  it("edits a team's instructions after the team was created and keeps the saved copy on reload", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("POST", "/api/sidebar-sections", { name: "Creator Studio", botIds: [bot.id] })).status).toBe(200);
      const created = await desktopApi("PUT", "/api/section-context?section=Creator%20Studio", { text: "Draft scripts first." });
      expect(created.status).toBe(200);

      const edited = await desktopApi("PUT", "/api/section-context?section=Creator%20Studio", { text: "Publish on Tuesdays." });
      expect(edited.body).toMatchObject({ section: "Creator Studio", text: "Publish on Tuesdays." });
      expect((await desktopApi("GET", "/api/section-context?section=Creator%20Studio")).body.text).toBe("Publish on Tuesdays.");

      // A failed edit leaves the saved instructions alone.
      expect((await desktopApi("PUT", "/api/section-context?section=Creator%20Studio", {})).status).toBe(400);
      expect((await desktopApi("PUT", `/api/section-context?section=${"S".repeat(61)}`, { text: "x" })).status).toBe(400);
      expect((await desktopApi("PUT", "/api/section-context?section=Creator%20Studio", { text: "x".repeat(24_001) })).status).toBe(400);
      expect((await desktopApi("GET", "/api/section-context?section=Creator%20Studio")).body.text).toBe("Publish on Tuesdays.");
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

describe("task pin API", () => {
  it("pins and unpins a bot task, keeps it on reload, and rejects a non-boolean", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Quarterly plan" })).body;
      const threadId: string = task.bot?.threadId ?? task.task?.threadId;
      expect(threadId).toEqual(expect.any(String));

      const pinned = await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { pinned: true });
      expect(pinned.status).toBe(200);
      expect(pinned.body.task).toMatchObject({ threadId, pinned: true });
      const reloaded = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
      expect(reloaded.tasks.find((candidate: { threadId: string }) => candidate.threadId === threadId)?.pinned).toBe(true);

      expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { pinned: "yes" })).status).toBe(400);

      const unpinned = await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { pinned: false });
      expect(unpinned.status).toBe(200);
      expect(unpinned.body.task.pinned).toBeUndefined();
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// The memory routes expose plain files in the bot's workspace. The
// traversal cases matter more than the happy path here: a topic name in a
// URL is hostile-adjacent input, and the only defensible answer to "../"
// in any coat of encoding is a rejection before the filesystem is touched.
describe("bot memory API", () => {
  /** raw-path GET: fetch() normalizes "../" segments away client-side, and
   * the traversal tests need the wire to carry exactly the bytes shown */
  const rawGet = (rawPath: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: rawPath, headers: DESKTOP_HEADERS }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  const workspaceOf = (botId: string) => join(home, ".murage", "workspaces", botId);

  it("reads empty memory for a fresh bot and 404s a bot that does not exist", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const fresh = await desktopApi("GET", `/api/bots/${bot.id}/memory`);
      expect(fresh.status).toBe(200);
      expect(fresh.body).toEqual({ text: "", truncated: false, topics: [], lastWrittenAt: null });
      expect((await api("GET", "/api/bots/does-not-exist/memory")).status).toBe(404);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("round-trips a MEMORY.md edit and rejects non-string or oversized text", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const saved = await desktopApi("PUT", `/api/bots/${bot.id}/memory`, { text: "# Memory\n- prefers pnpm\n" });
      expect(saved.status).toBe(200);
      expect(saved.body.truncated).toBe(false);
      const read = await desktopApi("GET", `/api/bots/${bot.id}/memory`);
      expect(read.body.text).toBe("# Memory\n- prefers pnpm\n");
      // the write lands in the same file the bot's own tools read
      expect(readFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "utf8")).toContain("prefers pnpm");

      expect((await desktopApi("PUT", `/api/bots/${bot.id}/memory`, { text: 7 })).status).toBe(400);
      expect((await desktopApi("PUT", `/api/bots/${bot.id}/memory`, {})).status).toBe(400);
      const big = await desktopApi("PUT", `/api/bots/${bot.id}/memory`, { text: "x".repeat(256 * 1024 + 1) });
      expect(big.status).toBe(400);
      expect(big.body.error).toContain("256KB");
      // a rejected write must leave the file exactly as it was
      expect((await desktopApi("GET", `/api/bots/${bot.id}/memory`)).body.text).toBe("# Memory\n- prefers pnpm\n");
      expect((await desktopApi("PUT", "/api/bots/does-not-exist/memory", { text: "x" })).status).toBe(404);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lists memory/ topic files and serves one by (possibly encoded) name", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const memDir = join(workspaceOf(bot.id), "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "deploys.md"), "- deploy = pnpm ship\n");
      writeFileSync(join(memDir, "my notes.md"), "spaced");
      writeFileSync(join(memDir, "notes.txt"), "not a topic");
      const listed = await desktopApi("GET", `/api/bots/${bot.id}/memory`);
      expect(listed.body.topics).toEqual([
        { name: "deploys.md", bytes: 21 },
        { name: "my notes.md", bytes: 6 },
      ]);

      const topic = await desktopApi("GET", `/api/bots/${bot.id}/memory/topics/deploys.md`);
      expect(topic.status).toBe(200);
      expect(topic.body).toEqual({ name: "deploys.md", text: "- deploy = pnpm ship\n" });
      // a UI-sent name arrives percent-encoded and must resolve to the same file
      expect((await desktopApi("GET", `/api/bots/${bot.id}/memory/topics/my%20notes.md`)).body.text).toBe("spaced");
      expect((await desktopApi("GET", `/api/bots/${bot.id}/memory/topics/missing.md`)).status).toBe(404);
      expect((await api("GET", "/api/bots/does-not-exist/memory/topics/deploys.md")).status).toBe(404);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses every coat of path traversal without reading the target", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      // plant real files where a traversal would land, so a hole would show
      // as leaked content and not depend on what happens to exist
      mkdirSync(workspaceOf(bot.id), { recursive: true });
      writeFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "TOP-SECRET-MARKER memory");
      writeFileSync(join(home, ".murage", "secret.md"), "TOP-SECRET-MARKER sibling");

      for (const name of [
        "..%2F..%2Fsecret.md", // encoded slashes
        "%2e%2e%2fsecret.md", // dots encoded too
        "..%2FMEMORY.md", // one level up, inside the workspace
        "..%5C..%5Csecret.md", // encoded backslashes (Windows separators)
        "secret%00.md", // null byte
      ]) {
        const res = await rawGet(`/api/bots/${bot.id}/memory/topics/${name}`);
        expect(res.status, name).toBe(400);
        expect(res.text, name).not.toContain("TOP-SECRET");
      }
      // a raw ../ segment is normalized away by URL parsing before routing —
      // it can only miss the route, never reach a file
      const raw = await rawGet(`/api/bots/${bot.id}/memory/topics/../../secret.md`);
      expect(raw.status).toBe(404);
      expect(raw.text).not.toContain("TOP-SECRET");
      // malformed percent-encoding is a clean 400, not a crash
      expect((await rawGet(`/api/bots/${bot.id}/memory/topics/%zz.md`)).status).toBe(400);
    } finally {
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// Hydration is one call that returns every bot's entire transcript. Over
// loopback that is right; over a phone network it is the whole problem.
describe("message pages", () => {
  /** A room whose default responder is mentions-only, posted to without any
   * mention: the user message lands and nothing answers it. That makes the
   * transcript exactly as long as we asked for — no bot turn racing the
   * assertions. */
  const seedRoom = async (count: number) => {
    const { body } = await api("GET", "/api/bots");
    const created = await api("POST", "/api/groups", { name: "Paging", memberIds: [body.bots[0].id] });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    // finish room setup with a mentions-only responder so no bot answers the probes
    const quiet = await desktopApi("PATCH", `/api/groups/${groupId}/setup`, {
      action: "complete",
      defaultResponder: { kind: "mentions" },
      bulletin: "",
    });
    expect(quiet.status).toBe(200);

    for (let i = 0; i < count; i++) {
      const posted = await desktopApi("POST", `/api/groups/${groupId}/messages`, { text: `page probe ${i}` });
      expect(posted.status).toBe(202);
    }
    const after = await api("GET", "/api/bots");
    return after.body.groups.find((g: { id: string }) => g.id === groupId);
  };

  it("returns the whole transcript when nothing is asked for", async () => {
    const room = await seedRoom(6);
    expect(room.messages).toHaveLength(6);
    // the original shape carries no pagination fields at all
    expect(room).not.toHaveProperty("hasMore");
  });

  it("returns only the newest n when asked", async () => {
    const full = await seedRoom(6);
    const { status, body } = await api("GET", "/api/bots?messages=2");
    expect(status).toBe(200);
    const slim = body.groups.find((g: { id: string }) => g.id === full.id);
    expect(slim.messages).toHaveLength(2);
    expect(slim.hasMore).toBe(true);
    // the newest two, not the oldest two
    expect(slim.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(-2).map((msg: { id: string }) => msg.id),
    );
    // and every 1:1 thread is capped by the same parameter
    expect(body.bots.every((b: { messages: unknown[] }) => b.messages.length <= 2)).toBe(true);
  });

  it("pages backwards from a message the client already holds", async () => {
    const full = await seedRoom(6);
    const fourth = full.messages[3];

    const { status, body } = await api("GET", `/api/threads/${full.threadId}/messages?before=${fourth.id}&limit=2`);
    expect(status).toBe(200);
    expect(body.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(1, 3).map((msg: { id: string }) => msg.id),
    );
    expect(body.hasMore).toBe(true);

    // walking back far enough reaches the top and says so
    const top = await api("GET", `/api/threads/${full.threadId}/messages?limit=200`);
    expect(top.body.hasMore).toBe(false);
    expect(top.body.messages).toHaveLength(6);
  });

  it("returns a bounded transcript window around a search result", async () => {
    const full = await seedRoom(9);
    const target = full.messages[4];
    const result = await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&limit=5`);
    expect(result.status).toBe(200);
    expect(result.body.messages.map((message: { id: string }) => message.id)).toEqual(
      full.messages.slice(2, 7).map((message: { id: string }) => message.id),
    );
    expect(result.body.hasMore).toBe(true);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=nope`)).status).toBe(404);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&before=${target.id}`)).status).toBe(400);
  });

  it("refuses a cursor or size it cannot page from", async () => {
    const full = await seedRoom(1);
    // silently answering with the newest page would paginate in a circle
    expect((await api("GET", `/api/threads/${full.threadId}/messages?before=nope`)).status).toBe(404);
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots?messages=-1")).status).toBe(400);
    expect((await api("GET", "/api/bots?messages=lots")).status).toBe(400);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?limit=1.5`)).status).toBe(400);
  });

  it("404s an image on a message that has none", async () => {
    const full = await seedRoom(1);
    const res = await fetch(`${BASE}/api/threads/${full.threadId}/messages/${full.messages[0].id}/image`);
    expect(res.status).toBe(404);
  });

  it("404s an image on a conversation that does not exist, without inventing one", async () => {
    // `messagesFor` materialises and caches a ThreadState for any id it is
    // given, so an unguarded route lets a client grow that map by asking
    // for threads that were never real. The 404 is the visible half; not
    // creating the thread is the half worth having.
    const before = (await api("GET", "/api/bots")).body.bots.length;
    const res = await fetch(`${BASE}/api/threads/not-a-thread/messages/not-a-message/image`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no such conversation");
    // and the phantom thread is not now answerable as an empty conversation
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots")).body.bots.length).toBe(before);
  });
});

// A phone reconnects every time it unlocks, so "what did I miss?" has to
// be answerable without re-downloading every transcript.
describe("resumable event stream", () => {
  /** any request that makes the server broadcast exactly one frame */
  const nudge = async (botId: string) => {
    const res = await desktopApi("PATCH", `/api/bots/${botId}`, { unread: true });
    expect(res.status).toBe(200);
  };

  it("hands out a cursor and numbers every frame", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const stream = await openSse(`${BASE}/api/events`);
    try {
      const hello = await stream.until((f) => f.kind === "hello");
      expect(hello.cursor).toMatch(/^[0-9a-f]{8}:\d+$/);
      // a cold connection offered no cursor, so there is nothing to resume
      expect(hello.resumed).toBe(false);

      await nudge(botId);
      await nudge(botId);
      // the PATCH response and the SSE frame travel on different sockets —
      // wait for the frames themselves rather than assuming they landed
      await stream.until(() => stream.frames.filter((f) => f.kind === "bot").length >= 2);
      const bots = stream.frames.filter((f) => f.kind === "bot");
      expect(bots[1].seq).toBeGreaterThan(bots[0].seq);
    } finally {
      stream.close();
    }
  });

  it("sends browser-visible heartbeats without moving the replay cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;
    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((frame) => frame.kind === "hello");
    let cursorSeq = 0;
    try {
      expect(await first.until((frame) => frame.kind === "ping")).toEqual({ kind: "ping" });
      await nudge(botId);
      const next = await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      // Other broadcasts (inbox changes, another bot's activity) may take
      // sequence numbers between the hello and our frame on a busy runner,
      // so the frame is later than the hello, not necessarily the next one.
      // What a heartbeat must never do is carry or consume a number: it has
      // no seq (asserted above), and no two numbered frames share one.
      const helloSeq = Number(hello.cursor.split(":")[1]);
      expect(next.seq).toBeGreaterThan(helloSeq);
      const numbered = first.frames.filter((frame) => typeof frame.seq === "number").map((frame) => frame.seq);
      expect(new Set(numbered).size).toBe(numbered.length);
      cursorSeq = next.seq;
    } finally {
      first.close();
    }

    // Heartbeats describe connection health, not application state. A
    // reconnect from the numbered application frame remains fully resumable.
    const cursor = `${hello.cursor.split(":")[0]}:${cursorSeq}`;
    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
    } finally {
      resumed.close();
    }
  });

  it("replays exactly what a disconnected client missed", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    // A second client that never disconnects is the ground truth for what was
    // broadcast while the first was away. Sequence numbers are shared by every
    // frame kind, so on a busy runner unrelated frames (inbox changes, other
    // bots) take numbers between our three; "exactly what was missed" is what
    // the witness saw, not seen.seq + 1..3.
    const witness = await openSse(`${BASE}/api/events`);
    try {
      await witness.until((f) => f.kind === "hello");
      const first = await openSse(`${BASE}/api/events`);
      const hello = await first.until((f) => f.kind === "hello");
      await nudge(botId);
      const seen = await first.until((f) => f.kind === "bot");
      first.close();
      // a real client advances its cursor as frames arrive — resume from the
      // last frame it actually saw, not from where it connected
      const cursor = `${hello.cursor.split(":")[0]}:${seen.seq}`;

      // ...three things happen while the phone is asleep...
      const mine = () => witness.frames.filter((f) => f.kind === "bot" && f.bot?.id === botId && f.seq > seen.seq);
      await nudge(botId);
      await nudge(botId);
      await nudge(botId);
      await witness.until(() => mine().length >= 3);
      const cutoff = Math.max(...mine().map((f) => f.seq));

      const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
      try {
        // ...and an old cursor still replays them, in order, without a hydrate
        const back = await resumed.until((f) => f.kind === "hello");
        expect(back.resumed).toBe(true);
        await resumed.until(() => resumed.frames.some((f) => typeof f.seq === "number" && f.seq >= cutoff));
        const after = (frames: any[]) =>
          frames.filter((f) => typeof f.seq === "number" && f.seq > seen.seq && f.seq <= cutoff).map((f) => f.seq);
        const replayed = after(resumed.frames);
        expect(replayed.length).toBeGreaterThanOrEqual(3);
        // strictly ascending: in order, nothing twice
        expect(replayed).toEqual([...new Set(replayed)].sort((a, b) => a - b));
        // and it is exactly what the live client saw after the same cursor
        expect(replayed).toEqual(after(witness.frames));
      } finally {
        resumed.close();
      }
    } finally {
      witness.close();
    }
  });

  it("resumes a browser EventSource through Last-Event-ID alone", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    first.close();
    await nudge(botId);

    // the id: field is what a browser echoes back on its own reconnect
    const resumed = await openSse(`${BASE}/api/events`, { "last-event-id": hello.cursor });
    try {
      expect((await resumed.until((f) => f.kind === "hello")).resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot");
    } finally {
      resumed.close();
    }
  });

  it("prefers a newer Last-Event-ID over the EventSource URL's stale cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((frame) => frame.kind === "hello");
    await nudge(botId);
    const seen = await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
    first.close();
    await nudge(botId);

    // Native EventSource reconnects reuse their original URL, including its
    // old query, but add Last-Event-ID for the newest numbered frame seen.
    const resumed = await openSse(
      `${BASE}/api/events?since=${encodeURIComponent(hello.cursor)}`,
      { "last-event-id": `${hello.cursor.split(":")[0]}:${seen.seq}` },
    );
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
      await resumed.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      const replayed = resumed.frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      expect(replayed.map((frame) => frame.seq)).toEqual([seen.seq + 1]);
    } finally {
      resumed.close();
    }
  });

  it("keeps delivering everything else when a client declines screen frames", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    // a phone on cellular opts out of the live desktop captures; nothing
    // else about its stream changes
    const stream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      expect((await stream.until((f) => f.kind === "hello")).resumed).toBe(false);
      await nudge(botId);
      await stream.until((f) => f.kind === "bot");
      expect(stream.frames.some((f) => f.kind === "screen")).toBe(false);
    } finally {
      stream.close();
    }
  });

  it("refuses a cursor it cannot honour instead of replaying the wrong run", async () => {
    for (const cursor of ["deadbeef:1", "not-a-cursor", "12345678:999999"]) {
      const stream = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
      try {
        const hello = await stream.until((f) => f.kind === "hello");
        // false is the signal to hydrate — a partial replay would leave a
        // permanent hole in the client's state
        expect(hello.resumed).toBe(false);
      } finally {
        stream.close();
      }
    }
  });
});

describe("instance CLI override API", () => {
  it("engine enablement is desktop-only, typed and reflected by the live registry", async () => {
    try {
      const disabled = await desktopApi("PATCH", "/api/instances/claude", { enabled: false });
      expect(disabled.status).toBe(200);
      expect(disabled.body.instances.find((row: any) => row.instanceId === "claude")).toMatchObject({ enabled: false, snapshot: { state: "unavailable", reason: expect.stringContaining("disabled") } });
      expect((await api("PATCH", "/api/instances/claude", { enabled: true })).status).toBe(404);
      expect((await desktopApi("PATCH", "/api/instances/claude", { enabled: "true" })).status).toBe(400);
      expect((await desktopApi("PATCH", "/api/instances/claude", { enabled: true, cli: "/arbitrary" })).status).toBe(400);
      expect((await desktopApi("PATCH", "/api/instances/missing", { enabled: true })).status).toBe(404);
    } finally {
      const enabled = await desktopApi("PATCH", "/api/instances/claude", { enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.body.instances.find((row: any) => row.instanceId === "claude")).toMatchObject({ enabled: true, snapshot: { state: "available" } });
    }
  });
  it("round-trips a set, clear, and rejects bad input", async () => {
    // ghost is a fixture shadow instance (unknown driver)
    const set = await desktopApi("PATCH", "/api/instances/ghost", { cli: "/opt/ghost/wrapper sub" });
    expect(set.status).toBe(200);
    const setRow = set.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(setRow.cli).toBe("/opt/ghost/wrapper sub");

    // persisted for real: the next fleet rebuild reads it back
    const cleared = await desktopApi("PATCH", "/api/instances/ghost", { cli: "" });
    expect(cleared.status).toBe(200);
    const clearedRow = cleared.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(clearedRow.cli).toBeUndefined();

    expect((await desktopApi("PATCH", "/api/instances/nope", { cli: "/x" })).status).toBe(404);
    expect((await desktopApi("PATCH", "/api/instances/ghost", { cli: 42 })).status).toBe(400);
    expect((await desktopApi("PATCH", "/api/instances/ghost", { cli: "/x\ny" })).status).toBe(400);
  });

  it("echoes a path-ish name back as the only cli candidate", async () => {
    const res = await desktopApi("GET", "/api/cli-candidates?name=/opt/definitely/not/here");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual(["/opt/definitely/not/here"]);
    expect((await desktopApi("GET", "/api/cli-candidates?name=")).body.candidates).toEqual([]);
  });

  it("reports a missing binary as a failed probe with install info", async () => {
    const res = await desktopApi("POST", "/api/cli-test", { cli: "/no/such/binary-anywhere", driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("isn't installed");
    expect(res.body.install?.docsUrl).toBe("https://claude.com/claude-code");
  });

  it("probes the complete wrapper with fixed arguments and no inherited credentials", async () => {
    const script = join(home, "cli-wrapper-probe.mjs");
    writeFileSync(
      script,
      `if (process.argv.slice(2).join(" ") !== "fixed --version") process.exit(9);\nif (process.env.COMPOSIO_API_KEY) process.exit(8);\nconsole.log("wrapper-ok");\n`,
    );
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} fixed`;
    const res = await desktopApi("POST", "/api/cli-test", { cli });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: "wrapper-ok" });
  });

  it("reports excessive probe output without presenting install guidance", async () => {
    const script = join(home, "cli-noisy-probe.mjs");
    writeFileSync(script, `process.stdout.write("x".repeat(70 * 1024));\n`);
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const res = await desktopApi("POST", "/api/cli-test", { cli, driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("more than 64 KiB");
    expect(res.body.install).toBeUndefined();
  });

  it("rejects overlapping provider configuration writes", async () => {
    const slowConfigWrite = desktopApi("PUT", "/api/config", { box: { token: "box_slow" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const overlapping = await desktopApi("PATCH", "/api/instances/ghost", { cli: "/tmp/ghost-overlap" });
    expect(overlapping.status).toBe(409);
    expect((await slowConfigWrite).status).toBe(200);
  });

  // Choosing the engine binary is choosing what code runs on the machine.
  // Behind the tailnet that is the owner's own decision; through a browser
  // door or a paired phone it is remote code execution in one request, so
  // the harness refuses on its own rather than trusting a list in another
  // package to keep saying no.
  it("refuses both execution-policy routes on every surface but the desktop", async () => {
    // A real, harmless binary: if the gate ever regresses, this test fails by
    // reporting a successful probe rather than by failing to prove anything.
    const probe = await api("POST", "/api/cli-test", { cli: "/bin/echo" });
    expect(probe.status).toBe(404);
    expect(probe.body).toEqual({ error: "no such route" });

    const override = await api("PATCH", "/api/instances/ghost", { cli: "/bin/echo" });
    expect(override.status).toBe(404);
    expect(override.body).toEqual({ error: "no such route" });

    // 404 and not 403: the refusal must not confirm the route exists.
    expect(probe.status).not.toBe(403);
    expect(override.status).not.toBe(403);

    // ...and the refusal was real, not a persisted write reported as denied.
    const instances = await desktopApi("GET", "/api/instances");
    const ghost = instances.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(ghost?.cli).toBeUndefined();
  });

  // EventSource cannot set headers, so `?surface=desktop` travels in the
  // query string. That is fine for a loopback renderer and fatal for a door a
  // browser can type a URL into: the door must stamp `x-murage-companion: 1`,
  // which is checked first and cannot be overridden from the query string —
  // not even by a request that also carries the real secret.
  it("cannot be unlocked from the query string once the door marks the request remote", async () => {
    const forged = await fetch(`${BASE}/api/cli-test?${DESKTOP_QUERY}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-murage-companion": "1" },
      body: JSON.stringify({ cli: "/bin/echo" }),
    });
    expect(forged.status).toBe(404);
  });

  // The attack the desktop secret exists to stop, end to end and over a real
  // socket. `x-murage-surface: desktop` is a string anyone on this machine
  // can type, and every agent this app runs has a shell:
  //
  //   curl -H 'x-murage-surface: desktop' 127.0.0.1:8799/api/cli-test
  //
  // reached a route that spawns a caller-supplied binary. The marker still
  // says what a caller wants; only the per-launch secret says who it is.
  it("refuses a forged desktop marker at every execution-class route", async () => {
    const forgeries: Array<Record<string, string>> = [
      // the exact curl above: the marker, and nothing else
      { "x-murage-surface": "desktop" },
      // a guess at the secret, right shape and wrong bytes
      { "x-murage-surface": "desktop", "x-murage-surface-secret": "f".repeat(64) },
      // the empty proof, which must not compare equal to anything
      { "x-murage-surface": "desktop", "x-murage-surface-secret": "" },
      // a prefix of the real one — the compare is constant-time, not a
      // startsWith, and the length guard is not the only thing deciding
      { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET.slice(0, -1) },
    ];
    for (const headers of forgeries) {
      const label = JSON.stringify(headers);

      // the binary prober
      const probe = await fetch(`${BASE}/api/cli-test`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ cli: "/bin/echo" }),
      });
      expect(probe.status, `cli-test ${label}`).toBe(404);

      // the binary installer — deferred execution, same gate
      const install = await fetch(`${BASE}/api/instances/claudeAgent`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ cli: "/bin/echo" }),
      });
      expect(install.status, `instances ${label}`).toBe(404);

      // and the same forgery in the query string, which is the form the
      // door forwards verbatim
      const query = new URLSearchParams({
        surface: "desktop",
        ...(headers["x-murage-surface-secret"] === undefined
          ? {}
          : { surfaceSecret: headers["x-murage-surface-secret"] }),
      });
      const viaQuery = await fetch(`${BASE}/api/cli-test?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cli: "/bin/echo" }),
      });
      expect(viaQuery.status, `cli-test?${query} ${label}`).toBe(404);
    }

    // 404 and never 403, for all of them: a 403 would confirm the route is
    // there and worth attacking, and would turn the secret compare into an
    // oracle a caller could iterate against.
    const withProof = await desktopApi("POST", "/api/cli-test", { cli: "/bin/echo" });
    expect(withProof.status).toBe(200);
  });

  // The dev injection, from the renderer's side. In development the bundle is
  // served by Vite on another port with no Electron bridge to ask through, so
  // it asks the harness. This suite's child is exactly that shape.
  it("hands a dev renderer the secret, and only ever over loopback", async () => {
    const offered = await fetch(`${BASE}/api/desktop-secret`);
    expect(offered.status).toBe(200);
    expect(((await offered.json()) as { secret?: string }).secret).toBe(DESKTOP_SECRET);

    // …and never through the door, whatever the allowlist ever grows to.
    // 404, not 403 — the door learns nothing about what is behind it.
    const throughTheDoor = await fetch(`${BASE}/api/desktop-secret`, {
      headers: { "x-murage-companion": "1" },
    });
    expect(throughTheDoor.status).toBe(404);
  });
});

describe("computer control API (who is driving)", () => {
  let botId = "";

  beforeAll(async () => {
    const created = await desktopApi("POST", "/api/bots", {});
    botId = created.body.bot.id;
  });

  it("starts disengaged", async () => {
    const res = await desktopApi("GET", `/api/bots/${botId}/computer/control`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held, broadcast on the wire, release → disengaged", async () => {
    const sse = await openSse(`${BASE}/api/events`);
    try {
      const took = await desktopApi("POST", `/api/bots/${botId}/computer/control`, { action: "take" });
      expect(took.status).toBe(200);
      expect(took.body.held).toBe(true);
      const frame = await sse.until(
        (f) => f.kind === "computer-control" && f.botId === botId && f.held === true,
      );
      expect(frame.helpReason).toBeNull();
      const hydrated = await api("GET", "/api/bots");
      expect(hydrated.body.computerControl[botId]).toEqual({ held: true, helpReason: null });
      const released = await desktopApi("POST", `/api/bots/${botId}/computer/control`, { action: "release" });
      expect(released.body.held).toBe(false);
    } finally {
      sse.close();
    }
  });

  it("atomically owns and conditionally releases a workspace lease without returning its id", async () => {
    const owner = "lease_5b6bbbd2-b88b-4c50-a748-ec87f332662f";
    const other = "lease_ed602995-306f-480a-8817-e8d8c8fe7d90";
    const took = await desktopApi("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: owner,
    });
    expect(took.body).toMatchObject({ held: true, owned: true, acquired: true });
    expect(JSON.stringify(took.body)).not.toContain(owner);

    const blocked = await desktopApi("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: other,
    });
    expect(blocked.body).toMatchObject({ held: true, owned: false, acquired: false });

    const wrongRelease = await desktopApi("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: other,
    });
    expect(wrongRelease.body).toMatchObject({ held: true, released: false });

    const released = await desktopApi("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: owner,
    });
    expect(released.body).toMatchObject({ held: false, released: true });
    expect(JSON.stringify(released.body)).not.toContain(owner);
  });

  it("rejects malformed workspace leases without echoing them", async () => {
    const invalid = "bad lease value";
    const res = await desktopApi("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: invalid,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(invalid);
  });

  it("refuses an unknown action and an unknown bot", async () => {
    const bad = await desktopApi("POST", `/api/bots/${botId}/computer/control`, { action: "hijack" });
    expect(bad.status).toBe(400);
    const ghost = await api("GET", "/api/bots/nope/computer/control");
    expect(ghost.status).toBe(404);
  });

  it("refuses a form-shaped POST — control mutations are JSON-only", async () => {
    const res = await fetch(`${BASE}/api/bots/${botId}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...DESKTOP_HEADERS },
      body: "action=take",
    });
    expect(res.status).toBe(415);
  });

  it("keeps the internal who-is-driving endpoint behind a turn capability", async () => {
    const res = await fetch(`${BASE}/api/internal/computer-control?botId=${botId}`);
    expect(res.status).toBe(401);
  });
});

describe("internal capability authority", () => {
  it("never counts a message an unproven local caller posted as the owner's say-so", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Forged allowance fixture" })).body.bot;
    try {
      // no desktop secret, no companion credential: a script, or the bot's
      // own shell, typing the owner's words into the chat
      const { headers } = await startInternalFixtureTurn(bot.id, undefined, "you can delete anything in ~/Projects/site today\n__fixture_hold_authority__", api);
      const response = await fetch(`${BASE}/api/internal/stop-line-allowance`, { method: "POST", headers, body: JSON.stringify({ kind: "delete", place: "~/Projects/site" }) });
      expect(response.status).toBe(403);
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[];
      expect(messages.some((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("You allowed"))).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    }
  });

  it("records a chat allowance only for a place the owner's own message names, and says so in the chat", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Chat allowance fixture" })).body.bot;
    try {
      const { headers } = await startInternalFixtureTurn(bot.id, undefined, "you can delete anything in ~/Projects/site today\n__fixture_hold_authority__");
      const allow = async (body: object) => {
        const response = await fetch(`${BASE}/api/internal/stop-line-allowance`, { method: "POST", headers, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };
      // a place the owner never said is refused, whatever the bot claims
      expect((await allow({ kind: "delete", place: "~/Documents" })).status).toBe(400);
      expect((await allow({ kind: "delete", place: "~" })).status).toBe(400);
      const allowed = await allow({ kind: "delete", place: "~/Projects/site" });
      expect(allowed.status).toBe(200);
      expect(allowed.body.note).toBe("You allowed deleting anything in ~/Projects/site for the rest of this task.");
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[];
      expect(messages.some((m) => m.kind === "activity" && m.tool?.name === allowed.body.note)).toBe(true);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    }
  });

  it("registers verified task files through the live agent capability without accepting foreign paths", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Artifact API fixture" })).body.bot;
    try {
      const { headers } = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      // Since 0.1.51 a new task is pinned to its own thread workspace, which is
      // the scope register_artifact resolves against.
      const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
      mkdirSync(join(workspace, "reports"), { recursive: true });
      const bytes = "<h1>Morning report fixture</h1>";
      writeFileSync(join(workspace, "reports", "morning.html"), bytes);
      const register = async (relativePath: string) => {
        const response = await fetch(`${BASE}/api/internal/register-artifact`, { method: "POST", headers, body: JSON.stringify({ relativePath, name: "Morning report" }) });
        return { status: response.status, body: await response.json() as any };
      };
      expect((await register("../outside.txt")).status).toBeGreaterThanOrEqual(400);
      const saved = await register("reports/morning.html");
      expect(saved.status).toBe(201);
      const id = saved.body.artifact.id;
      expect(saved.body.artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect((await register("reports/morning.html")).body.artifact.id).toBe(id);
      expect((await api("GET", "/api/artifacts")).status).toBe(404);
      const listed = await desktopApi("GET", `/api/artifacts?botId=${bot.id}`);
      expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([id]);
      writeFileSync(join(workspace, "reports", "morning.html"), "changed original");
      const preview = await desktopApi("GET", `/api/artifacts/${id}/preview`);
      expect(preview.body.content).toBe(bytes);
      expect(preview.body.artifact.sourceState).toBe("changed");
      const state = (await api("GET", "/api/bots")).body.bots.find((item: { id: string }) => item.id === bot.id);
      expect(state.messages.filter((message: { artifactIds?: string[] }) => message.artifactIds?.includes(id))).toHaveLength(1);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("parks an oversized tool result for its own turn only, and never for a neighbouring bot", async () => {
    const owner = (await desktopApi("POST", "/api/bots", { name: "Tool result owner" })).body.bot;
    const other = (await desktopApi("POST", "/api/bots", { name: "Tool result neighbour" })).body.bot;
    try {
      const { headers } = await startInternalFixtureTurn(owner.id, undefined, "__fixture_hold_authority__");
      const text = "o".repeat(40_000);
      const save = await fetch(`${BASE}/api/internal/tool-result`, { method: "POST", headers, body: JSON.stringify({ text, truncated: false }) });
      expect(save.status).toBe(201);
      const saved = await save.json() as { id: string; length: number; truncated: boolean };
      expect(saved.id).toMatch(/^r-[0-9a-f-]{36}$/);
      expect(saved.length).toBe(text.length);

      const read = await fetch(`${BASE}/api/internal/tool-result?id=${saved.id}&offset=16000`, { headers });
      expect(read.status).toBe(200);
      const page = await read.json() as { text: string; offset: number; nextOffset: number; length: number };
      expect(page.offset).toBe(16_000);
      expect(page.text.length).toBe(16_000);
      expect(page.length).toBe(text.length);

      // An id is not a bearer token: another bot's live capability cannot read it.
      const { headers: otherHeaders } = await startInternalFixtureTurn(other.id, undefined, "__fixture_hold_authority__");
      expect((await fetch(`${BASE}/api/internal/tool-result?id=${saved.id}&offset=0`, { headers: otherHeaders })).status).toBe(404);
      // Nor is a malformed id or an offset past the end.
      expect((await fetch(`${BASE}/api/internal/tool-result?id=nope&offset=0`, { headers })).status).toBe(400);
      expect((await fetch(`${BASE}/api/internal/tool-result?id=${saved.id}&offset=999999`, { headers })).status).toBe(404);
      // And an unbounded body is refused rather than retained.
      expect((await fetch(`${BASE}/api/internal/tool-result`, { method: "POST", headers, body: JSON.stringify({ text: "p".repeat(200_000) }) })).status).toBe(400);
    } finally {
      for (const bot of [owner, other]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`);
        await desktopApi("DELETE", `/api/bots/${bot.id}`);
      }
    }
  });

  // R3-T3 (U-02): a terminal fake turn that writes a real report under the
  // managed task workspace's outputs/ without calling register_artifact.
  const outputFixture = async (name: string) => {
    const bot = (await desktopApi("POST", "/api/bots", { name })).body.bot;
    const state = async () => (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id);
    const cards = async () => (await state()).messages.filter((message: { artifactIds?: string[] }) => message.artifactIds?.length);
    const terminals = async () => (await state()).messages.filter((message: { turnTerminal?: boolean }) => message.turnTerminal).length;
    const turn = async (text: string) => {
      await expect.poll(async () => Boolean((await state())?.busy), { timeout: 5_000 }).toBe(false);
      const before = await terminals();
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
      await expect.poll(async () => (await terminals()) > before && !(await state()).busy, { timeout: 15_000 }).toBe(true);
    };
    const receipts = () => {
      const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT stage, path_token, artifact_id, message_id FROM output_publications WHERE bot_id=? AND producer='shell-output' ORDER BY created_at").all(bot.id) as Array<Record<string, unknown>>; }
      finally { db.close(); }
    };
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
    const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
    return { bot, cards, turn, receipts, workspace };
  };

  it("publishes a shell-written outputs/ report without register_artifact as one saved file and one persisted card", async () => {
    const f = await outputFixture("Output publication fixture");
    try {
      await f.turn("__fixture_finish_turn__ __fixture_write_output__:outputs/weekly/report.html");
      await expect.poll(async () => (await f.cards()).length, { timeout: 5_000 }).toBe(1);
      const [card] = await f.cards();
      expect(card.artifactIds).toHaveLength(1);
      const id = card.artifactIds[0];
      const report = join(f.workspace, "outputs", "weekly", "report.html");
      const bytes = readFileSync(report);
      const described = await desktopApi("GET", `/api/artifacts/${id}`);
      expect(described.body.artifact).toMatchObject({
        sha256: createHash("sha256").update(bytes).digest("hex"), producer: "shell-output", relativePath: "outputs/weekly/report.html",
        threadId: f.bot.threadId, sourceState: "current", sourceConversationAvailable: true, runId: expect.any(String),
      });
      expect((await desktopApi("GET", `/api/artifacts?botId=${f.bot.id}`)).body.items.map((item: { id: string }) => item.id)).toEqual([id]);

      // A later turn that writes nothing adds no card and no second saved file.
      const writtenAt = statSync(report).mtimeMs;
      await f.turn("__fixture_finish_turn__ plain follow-up without outputs");
      expect(statSync(report).mtimeMs).toBe(writtenAt);
      expect((await f.cards()).map((message: { id: string }) => message.id)).toEqual([card.id]);
      expect((await desktopApi("GET", `/api/artifacts?botId=${f.bot.id}`)).body.total).toBe(1);

      // Open/reopen keep that exact saved revision after the original changes.
      writeFileSync(report, "changed after publication");
      const preview = await desktopApi("GET", `/api/artifacts/${id}/preview`);
      expect(preview.body.content).toBe(bytes.toString("utf8"));
      expect(preview.body.artifact).toMatchObject({ id, sourceState: "changed" });
      const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      try {
        const stored = (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(f.bot.threadId) as Array<{ json: string }>)
          .map(row => JSON.parse(row.json) as { id: string; artifactIds?: string[] }).filter(message => message.artifactIds?.includes(id));
        expect(stored.map(message => message.id)).toEqual([card.id]);
      } finally { db.close(); }
      expect(f.receipts()).toEqual([{ stage: "registered", path_token: "outputs/weekly/report.html", artifact_id: id, message_id: card.id }]);
    } finally {
      await api("POST", `/api/bots/${f.bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${f.bot.id}`);
    }
  });

  it("keeps outputs from a failed turn as retained receipts without saving or announcing them", async () => {
    const f = await outputFixture("Failed output fixture");
    try {
      await f.turn("__fixture_write_output__:outputs/draft.html __fixture_fail_turn__");
      await expect.poll(() => f.receipts().length, { timeout: 5_000 }).toBe(1);
      expect(f.receipts()).toEqual([{ stage: "retained", path_token: "outputs/draft.html", artifact_id: null, message_id: null }]);
      expect(await f.cards()).toEqual([]);
      expect((await desktopApi("GET", `/api/artifacts?botId=${f.bot.id}`)).body.total).toBe(0);
      expect(readFileSync(join(f.workspace, "outputs", "draft.html"), "utf8")).toContain("Fixture report");
    } finally {
      await api("POST", `/api/bots/${f.bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${f.bot.id}`);
    }
  });

  it("imports role-aware Markdown package intent without automatically appointing a Chief", async () => {
    const payload = { format: "murage.package", version: 1, package: {
      id: "role-aware-export", release: "1.0.0", name: "Role-aware export", tagline: "Reviewed role intent.",
      summary: "Preserve private roles without authority.", category: "Work", author: { name: "Fixture" }, license: "MIT",
      outcomes: ["Import safely."], setupMinutes: 2, requirements: { apps: [], capabilities: [] }, chiefOfStaff: "chief",
      agents: [
        { key: "chief", name: "Role Chief Fixture", role: "chief", team: "Research", appearance: { color: "green" } },
        { key: "member", name: "Role Member Fixture", role: "member", team: "Research", appearance: { color: "blue" } },
      ], rooms: [{ key: "room", name: "Role Room Fixture", team: "Research", members: ["chief", "member"], defaultResponder: { kind: "agent", agent: "chief" } }],
    } };
    const { renderBotPackageMarkdown, parseBotPackage } = await import("./bot-package.ts");
    const result = await desktopApi("POST", "/api/teams/import", renderBotPackageMarkdown(parseBotPackage(payload)));
    try {
      expect(result.status).toBe(201);
      const bots = result.body.bots;
      expect(bots).toHaveLength(2);
      expect(bots.every((bot: { chiefOfStaff?: boolean }) => !bot.chiefOfStaff)).toBe(true);
      expect(bots[0].installedPackage).toMatchObject({ sourceRole: "chief", sourceTeam: "Research" });
      expect(bots[1].installedPackage).toMatchObject({ sourceRole: "member", sourceTeam: "Research" });
      expect(bots[0].section).toBe(bots[1].section);
    } finally {
      for (const group of result.body.groups ?? []) await desktopApi("DELETE", `/api/groups/${group.id}`);
      for (const bot of result.body.bots ?? []) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("applies all three starters through the reviewed transaction without changing existing roles", async () => {
    const botIds: string[] = [], routineIds: string[] = [];
    const botsFile = join(home, ".murage", "bots.json");
    try {
      expect((await api("POST", "/api/starter-profiles", { action: "catalog" })).status).toBe(404);
      expect((await desktopApi("POST", "/api/starter-profiles", { action: "preview", profileId: "../private", selection: {} })).status).toBe(400);
      const catalog = await desktopApi("POST", "/api/starter-profiles", { action: "catalog" });
      expect(catalog.status).toBe(200);
      expect(catalog.body.profiles.map((profile: { members: number }) => profile.members)).toEqual([1, 2, 3]);
      for (const profile of catalog.body.profiles) {
        const selection = { agents: profile.agents.map((agent: { key: string }) => agent.key), skills: [],
          routines: profile.routines.map((routine: { key: string }) => routine.key), instructions: [] };
        const request = { profileId: profile.id, selection };
        const before = readFileSync(botsFile);
        const preview = await desktopApi("POST", "/api/starter-profiles", { ...request, action: "preview" });
        expect(preview.status).toBe(200);
        expect(preview.body.scan.blocked).toBe(false);
        expect(readFileSync(botsFile)).toEqual(before);
        const reviewed = { ...request, action: "import", archiveSha256: preview.body.archiveSha256, reviewHash: preview.body.reviewHash, acknowledgeWarnings: true };
        const firstRunAttempt = await desktopApi("POST", "/api/starter-profiles", { ...reviewed, firstRun: true });
        expect(firstRunAttempt.status).toBe(409);
        expect(readFileSync(botsFile)).toEqual(before);
        expect((await desktopApi("POST", "/api/starter-profiles", { ...reviewed, reviewHash: "0".repeat(64) })).status).toBeGreaterThanOrEqual(400);
        expect(readFileSync(botsFile)).toEqual(before);
        const invalidModel = await desktopApi("POST", "/api/starter-profiles", { ...reviewed, modelSelection: { instanceId: "missing-onboarding-engine", model: "missing-model" } });
        expect(invalidModel.status).toBe(400);
        expect(readFileSync(botsFile)).toEqual(before);
        const chosenModel = { instanceId: "claude", model: "claude-sonnet-5", effort: "low" };
        const result = await desktopApi("POST", "/api/starter-profiles", { ...reviewed, modelSelection: chosenModel });
        expect(result.status).toBe(201);
        expect(result.body.bots).toHaveLength(profile.members);
        for (const bot of result.body.bots) expect(bot.modelSelection).toEqual(chosenModel);
        const newIds = result.body.bots.map((bot: { id: string }) => bot.id);
        botIds.push(...newIds);
        routineIds.push(...result.body.routines.map((routine: { id: string }) => routine.id));
        for (const bot of result.body.bots) expect(bot).toMatchObject({ chiefOfStaff: false, autoApprove: false, browser: false, composio: false, computer: "off" });
        for (const routine of result.body.routines) expect(routine).toMatchObject({ enabled: false, nextRunAt: null });
        const after = JSON.parse(readFileSync(botsFile, "utf8"));
        expect(after.filter((bot: { id: string }) => !newIds.includes(bot.id))).toEqual(JSON.parse(before.toString()));
        expect((await desktopApi("POST", "/api/starter-profiles", reviewed)).status).toBe(409);
        expect(JSON.parse(readFileSync(botsFile, "utf8"))).toHaveLength(after.length);
      }
    } finally {
      for (const id of routineIds) await desktopApi("DELETE", `/api/routines/${id}`);
      for (const id of botIds) await desktopApi("DELETE", `/api/bots/${id}`);
    }
  });

  it("previews and imports reviewed packages additively with inert defaults through the actual API", async () => {
    const root = mkdtempSync(join(home, "package-api-"));
    const archivePath = join(root, "reviewed.zip");
    const payloads = new Map([
      ["bots/scout/SOUL.md", "Use the notes provided by the user and report uncertainty."],
      ["skills/research/SKILL.md", "---\nname: research\ndescription: Review user notes.\nlicense: MIT\n---\nReview supplied notes.\n"],
    ]);
    const manifest = { format: "murage.package.bundle", version: 1,
      definition: { format: "murage.package", version: 1, package: {
        id: "fixture-import", release: "1.0.0", name: "Fixture import", tagline: "An inert package", summary: "Supplied notes only", category: "Starter", author: { name: "Fixture" }, license: "MIT", outcomes: ["A useful draft"], setupMinutes: 2,
        requirements: { apps: [], capabilities: [] }, chiefOfStaff: "scout",
        agents: [{ key: "scout", name: "Imported Scout", appearance: { color: "green" }, skills: ["research"] }],
        routines: [{ key: "daily", name: "Imported daily", agent: "scout", prompt: "Review supplied notes", runOn: "ember", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 15, enabledAfterInstall: false }],
      } }, skills: [{ key: "research", name: "Research", license: "MIT", dependencies: [], files: ["skills/research/SKILL.md"] }],
      instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }], entries: [...payloads].map(([path, content]) => createBotPackageEntry(path, content)),
    };
    const selection = { agents: ["scout"], skills: ["research"], routines: ["daily"], instructions: ["scout"] };
    const importedIds: string[] = [];
    const routineIds: string[] = [];
    try {
      await writeBotPackageArchive(archivePath, { manifest, payloads });
      const botsFile = join(home, ".murage", "bots.json");
      const before = readFileSync(botsFile);
      const request = { archivePath, selection };
      const options = await desktopApi("POST", "/api/packages/import", { archivePath, action: "options" });
      expect(options.status).toBe(200);
      expect(options.body.agents).toEqual([{ key: "scout", name: "Imported Scout", skills: ["research"] }]);
      expect(options.body.skills).toEqual([{ key: "research", name: "Research", dependencies: [], license: "MIT" }]);
      expect((await api("POST", "/api/packages/import", { ...request, action: "preview" })).status).toBe(404);
      const preview = await desktopApi("POST", "/api/packages/import", { ...request, action: "preview" });
      expect(preview.status).toBe(200);
      expect(preview.body.scan.blocked).toBe(false);
      expect(readFileSync(botsFile)).toEqual(before);
      expect(preview.body.comparison.status).toBe("new");
      const reviewed = { ...request, action: "import", archiveSha256: preview.body.archiveSha256, reviewHash: preview.body.reviewHash, acknowledgeWarnings: true };
      const stale = await desktopApi("POST", "/api/packages/import", { ...reviewed, reviewHash: "0".repeat(64) });
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(readFileSync(botsFile)).toEqual(before);
      const result = await desktopApi("POST", "/api/packages/import", reviewed);
      expect(result.status).toBe(201);
      const bot = result.body.bots[0]; importedIds.push(bot.id);
      routineIds.push(...result.body.routines.map((routine: { id: string }) => routine.id));
      expect(bot).toMatchObject({ chiefOfStaff: false, autoApprove: false, browser: false, composio: false, computer: "off" });
      expect(result.body.routines[0]).toMatchObject({ enabled: false, nextRunAt: null, botId: bot.id });
      expect(readFileSync(join(home, ".murage", "workspaces", bot.id, "SOUL.md"), "utf8")).toBe(payloads.get("bots/scout/SOUL.md"));
      expect(readFileSync(join(home, ".murage", "workspaces", bot.id, "skills", "research", "SKILL.md"), "utf8")).toBe(payloads.get("skills/research/SKILL.md"));
      expect(JSON.parse(readFileSync(join(home, ".murage", "skill-state", bot.id, "skills.json"), "utf8")).research.enabled).toBe(false);
      const after = JSON.parse(readFileSync(botsFile, "utf8"));
      expect(after.filter((candidate: { id: string }) => candidate.id !== bot.id)).toEqual(JSON.parse(before.toString()));
      // The durable import receipt prevents replaying this exact review.
      const again = await desktopApi("POST", "/api/packages/import", reviewed);
      expect(again.status).toBe(409);
      expect(JSON.parse(readFileSync(botsFile, "utf8"))).toHaveLength(after.length);
      expect(JSON.parse(readFileSync(botsFile, "utf8")).find((candidate: { id: string }) => candidate.id === bot.id)).toEqual(bot);
      expect(bot.packageImportReceipt.baseline.release).toBe("1.0.0");
      expect(JSON.stringify(bot.packageImportReceipt.baseline)).not.toContain("Use the notes provided");
      const samePreview = await desktopApi("POST", "/api/packages/import", { ...request, action: "preview" });
      expect(samePreview.body.comparison).toMatchObject({ status: "compared", previousRelease: "1.0.0", incomingRelease: "1.0.0", changes: [] });
      expect((await desktopApi("POST", "/api/packages/import", { ...reviewed, reviewHash: samePreview.body.reviewHash })).status).toBe(409);
      const nextPath = join(root, "next-version.zip");
      const nextPayloads = new Map(payloads);
      nextPayloads.set("bots/scout/SOUL.md", "New version: summarize supplied notes and list uncertainties.");
      await writeBotPackageArchive(nextPath, { manifest: { ...manifest,
        definition: { ...manifest.definition, package: { ...manifest.definition.package, release: "2.0.0" } },
        entries: [...nextPayloads].map(([path, content]) => createBotPackageEntry(path, content)),
      }, payloads: nextPayloads });
      const nextPreview = await desktopApi("POST", "/api/packages/import", { archivePath: nextPath, selection, action: "preview" });
      expect(nextPreview.status).toBe(200);
      expect(nextPreview.body.comparison).toMatchObject({ status: "compared", previousRelease: "1.0.0", incomingRelease: "2.0.0" });
      expect(nextPreview.body.comparison.changes).toContainEqual({ category: "file", key: "bots/scout/SOUL.md", change: "changed" });
      const nextResult = await desktopApi("POST", "/api/packages/import", { archivePath: nextPath, selection, action: "import",
        archiveSha256: nextPreview.body.archiveSha256, reviewHash: nextPreview.body.reviewHash, acknowledgeWarnings: true });
      expect(nextResult.status).toBe(201);
      importedIds.push(...nextResult.body.bots.map((item: { id: string }) => item.id));
      routineIds.push(...nextResult.body.routines.map((item: { id: string }) => item.id));
      expect(nextResult.body.bots[0].id).not.toBe(bot.id);
      expect(nextResult.body.bots[0]).toMatchObject({ chiefOfStaff: false, computer: "off", autoApprove: false });
      expect(JSON.parse(readFileSync(botsFile, "utf8")).find((candidate: { id: string }) => candidate.id === bot.id)).toEqual(bot);
      // Construct hostile intake directly: the normal archive writer correctly refuses it.
      const secretPath = join(root, "hostile.zip");
      const secretPayloads = new Map(payloads); secretPayloads.set("bots/scout/SOUL.md", "Bearer fake_secret_canary_1234567890");
      const zip = new ZipFile(); const writing = pipeline(zip.outputStream, createWriteStream(secretPath));
      zip.addBuffer(Buffer.from(JSON.stringify({ ...manifest, entries: [...secretPayloads].map(([path, content]) => createBotPackageEntry(path, content)) })), "manifest.json", { compress: false });
      for (const [path, content] of secretPayloads) zip.addBuffer(Buffer.from(content), path, { compress: false });
      zip.end(); await writing;
      const blockedOptions = await desktopApi("POST", "/api/packages/import", { archivePath: secretPath, action: "options" });
      expect(blockedOptions.status).toBe(200);
      expect(blockedOptions.body.scan.blocked).toBe(true);
      expect(blockedOptions.body).not.toHaveProperty("agents");
      expect(blockedOptions.body).not.toHaveProperty("skills");
      expect(JSON.stringify(blockedOptions.body)).not.toMatch(/fake_secret_canary|Imported Scout/);
      const blocked = await desktopApi("POST", "/api/packages/import", { archivePath: secretPath, selection, action: "preview" });
      expect(blocked.status).toBe(200); expect(blocked.body.scan.blocked).toBe(true);
      expect(JSON.stringify(blocked.body)).not.toContain("fake_secret_canary");
      const beforeBlocked = readFileSync(botsFile);
      const refused = await desktopApi("POST", "/api/packages/import", { archivePath: secretPath, selection, action: "import", archiveSha256: blocked.body.archiveSha256, reviewHash: blocked.body.reviewHash, acknowledgeWarnings: true });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(readFileSync(botsFile)).toEqual(beforeBlocked);
    } finally {
      for (const id of routineIds) await desktopApi("DELETE", `/api/routines/${id}`);
      for (const id of importedIds) await desktopApi("DELETE", `/api/bots/${id}`);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(browserEngineRefusesHost)("binds the unified browser relay and exact-profile cleanup to its live computer claim on every platform", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const offset = browserNativeEvents.length;
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { browser: true })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const mounted = await browserMount();
      expect(mounted.env).toMatchObject({ MURAGE_BOT_ID: bot.id, MURAGE_THREAD_ID: turn.env.MURAGE_THREAD_ID });
      expect(mounted.env).not.toHaveProperty("MURAGE_HEADLESS_BROWSER_URL");
      expect(mounted.env).not.toHaveProperty("AGENT_BROWSER_SESSION");
      const token = mounted.env.MURAGE_CONTROL_TOKEN;
      const endpoint = `${BASE}/api/internal/unified-browser`;
      const request = (url = endpoint, bearer = token, method = "tools/list", params?: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      const response = await request();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ tools: [expect.objectContaining({ name: "agent_browser_snapshot" })] });
      expect((await request(endpoint, turn.env.MURAGE_COMMS_TOKEN)).status).toBe(403);
      for (const key of ["botId", "threadId"]) {
        const mismatch = new URL(endpoint); mismatch.searchParams.set(key, "different-owner");
        expect((await request(mismatch.href)).status).toBe(403);
      }
      const taken = await desktopApi("POST", `/api/bots/${bot.id}/browser`, { action: "take" });
      expect(taken.status).toBe(200);
      expect(taken.body.held).toBe(true);
      // While the owner holds the browser the bot keeps its tool list, so the
      // engine never connects a browser with no tools; its actions are refused.
      expect((await request()).status).toBe(200);
      const heldCall = await request(endpoint, token, "tools/call", { name: "agent_browser_snapshot", arguments: {} });
      expect(heldCall.status).toBe(409);
      expect(await heldCall.json()).toMatchObject({ code: "browser_held" });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/browser`, { action: "release", generation: taken.body.generation })).status).toBe(200);
      expect((await request()).status).toBe(200);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      expect((await request()).status).toBe(401);
      // Turn retirement revokes only its claim; the owner can still view the
      // profile. Feature disable owns closing that exact native session.
      expect(browserNativeEvents.slice(offset).filter(event => event.operation === "close")).toEqual([]);
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: false } })).status).toBe(200);
      expect(browserNativeEvents.slice(offset).filter(event => event.operation === "close")).toEqual([
        { operation: "close", session: browserSession(bot.id) },
      ]);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } });
    }
  });

  it("keeps chat account aliases distinct through cards, OAuth, status and capability expiry", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: true })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const token = turn.dump.mcpConfig.mcpServers.composio?.env.MURAGE_CONNECTORS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      setConnectorAliasFixture({ accounts: [], links: [], calls: 0 });
      const request = (items: unknown[], bearer = token) => fetch(`${BASE}/api/internal/connectors/request`, {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ botId: bot.id, threadId: turn.env.MURAGE_THREAD_ID, resumeKey: "alias-fixture-resume", items }),
      });
      const items = [{ slug: "gmail", alias: "Personal" }, { slug: " GMAIL ", alias: " Work " }];
      const response = await request(items);
      expect(response.status).toBe(200);
      const { messageIds } = z.object({ messageIds: z.array(z.string()).length(2) }).parse(await response.json());
      expect(new Set(messageIds).size).toBe(2);
      const repeated = await request([{ slug: "gmail", alias: "personal" }, { slug: "gmail", alias: "WORK" }, items[1]]);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual({ messageIds });
      const route = (id: string, operation: string) => `/api/bots/${bot.id}/connector-cards/${id}/${operation}`;
      const threadId = turn.env.MURAGE_THREAD_ID;
      const first = await desktopApi("POST", route(messageIds[0], "authorize"), { threadId });
      const second = await desktopApi("POST", route(messageIds[1], "authorize"), { threadId });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.url).not.toBe(second.body.url);
      expect(connectorAliasFixture!.links).toEqual([{ toolkit: "gmail", alias: "Personal" }, { toolkit: "gmail", alias: "Work" }]);
      connectorAliasFixture!.accounts = [{ id: "ca_personal", alias: "Personal", status: "ACTIVE", toolkit: { slug: "gmail" } }];
      const personal = await desktopApi("GET", `${route(messageIds[0], "status")}?threadId=${threadId}`);
      const work = await desktopApi("GET", `${route(messageIds[1], "status")}?threadId=${threadId}`);
      expect(personal.status).toBe(200);
      expect(personal.body.connected).toBe(true);
      expect(work.status).toBe(200);
      expect(work.body.connected).toBe(false);
      const current = (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id);
      expect(current.messages.find((message: { id: string }) => message.id === messageIds[1]).connector).toMatchObject({ alias: "Work", status: "authorizing" });
      const calls = connectorAliasFixture!.calls;
      expect((await request([{ slug: "gmail", alias: 5 }])).status).toBe(400);
      expect((await request(items, turn.env.MURAGE_COMMS_TOKEN)).status).toBe(403);
      expect(connectorAliasFixture!.calls).toBe(calls);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      expect((await request(items)).status).toBe(401);
      expect(connectorAliasFixture!.calls).toBe(calls);
    } finally {
      setConnectorAliasFixture(undefined);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("ends a connect card in plain words: expired, timed out, and 'Try again' with the same label", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: true })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const token = turn.dump.mcpConfig.mcpServers.composio?.env.MURAGE_CONNECTORS_TOKEN;
      setConnectorAliasFixture({ accounts: [], links: [], calls: 0 });
      const threadId = turn.env.MURAGE_THREAD_ID;
      const ask = async (alias: string, resumeKey: string) => {
        const response = await fetch(`${BASE}/api/internal/connectors/request`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ botId: bot.id, threadId, resumeKey, items: [{ slug: "gmail", alias }] }),
        });
        expect(response.status).toBe(200);
        return z.object({ messageIds: z.array(z.string()).length(1) }).parse(await response.json()).messageIds[0];
      };
      const route = (id: string, operation: string) => `/api/bots/${bot.id}/connector-cards/${id}/${operation}`;
      const card = async (id: string) => (await api("GET", "/api/bots?messages=100")).body.bots
        .find((item: { id: string }) => item.id === bot.id).messages.find((message: { id: string }) => message.id === id).connector;
      const EXPIRED = "The sign-in link expired before it was finished. Try again.";

      // The provider ended the link: one plain sentence, never "Connection EXPIRED".
      const expired = await ask("Work", "plain-words-expired");
      expect((await desktopApi("POST", route(expired, "authorize"), { threadId })).status).toBe(200);
      connectorAliasFixture!.accounts = [{ id: "ca_dead", alias: "Work", status: "EXPIRED", toolkit: { slug: "gmail" } }];
      const polled = await desktopApi("GET", `${route(expired, "status")}?threadId=${threadId}`);
      expect(polled.body).toMatchObject({ connected: false, failed: true, failure: "timed-out", error: EXPIRED });
      expect(await card(expired)).toMatchObject({ status: "failed", failure: "timed-out", error: EXPIRED });

      // "Try again" with the same label: the dead attempt does not block it.
      const again = await desktopApi("POST", route(expired, "authorize"), { threadId });
      expect(again.status).toBe(200);
      expect(await card(expired)).toMatchObject({ status: "authorizing" });
      expect((await card(expired)).error).toBeUndefined();

      // The card's own polling ran out and the provider never ended the link.
      connectorAliasFixture!.accounts = [];
      const abandoned = await ask("Home", "plain-words-timeout");
      expect((await desktopApi("POST", route(abandoned, "authorize"), { threadId })).status).toBe(200);
      const ended = await desktopApi("POST", route(abandoned, "timeout"), { threadId });
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ connected: false, failed: true, failure: "timed-out", error: EXPIRED });
      expect(await card(abandoned)).toMatchObject({ status: "failed", failure: "timed-out", error: EXPIRED });

      // A link still inside its life, with the provider calling it pending, is
      // not ended early by a status read.
      const away = await ask("Away", "plain-words-away");
      expect((await desktopApi("POST", route(away, "authorize"), { threadId })).status).toBe(200);
      connectorAliasFixture!.accounts = [{ id: "ca_away", alias: "Away", status: "INITIATED", toolkit: { slug: "gmail" } }];
      const stillWaiting = await desktopApi("GET", `${route(away, "status")}?threadId=${threadId}`);
      expect(stillWaiting.body).toMatchObject({ connected: false, pending: true });
      expect(stillWaiting.body.failed).toBeUndefined();
      // (Past the link's life the same read ends it as timed out; the harness
      // server runs in its own process, so that half is covered by
      // abandonedLinkFailure's own tests in connector-requests.test.ts.)
      connectorAliasFixture!.accounts = [];

      // If the sign-in did finish just as polling ended, it is not called timed out.
      const finished = await ask("Late", "plain-words-late");
      expect((await desktopApi("POST", route(finished, "authorize"), { threadId })).status).toBe(200);
      connectorAliasFixture!.accounts = [{ id: "ca_late", alias: "Late", status: "ACTIVE", toolkit: { slug: "gmail" } }];
      const late = await desktopApi("POST", route(finished, "timeout"), { threadId });
      expect(late.body).toMatchObject({ connected: true });
      expect(await card(finished)).toMatchObject({ status: "connected" });
    } finally {
      setConnectorAliasFixture(undefined);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 90_000);

  it.skipIf(browserEngineRefusesHost)("accepts actual harness connector and computer calls from their exact live mounts", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({ version: 1,
      url: `http://127.0.0.1:${boxStubPort}`, token: "c".repeat(64), pid: process.pid }));
    try {
      expect((await desktopApi("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: true, browser: true })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const connectorToken = turn.dump.mcpConfig.mcpServers.composio?.env.MURAGE_CONNECTORS_TOKEN;
      const computerToken = turn.dump.mcpConfig.mcpServers.browser?.env.MURAGE_CONTROL_TOKEN;
      expect(connectorToken).toMatch(/^[a-f0-9]{48}$/);
      expect(computerToken).toMatch(/^[a-f0-9]{48}$/);
      expect(new Set([connectorToken, computerToken, turn.env.MURAGE_COMMS_TOKEN]).size).toBe(3);
      const control = await fetch(`${BASE}/api/internal/computer-control?botId=${bot.id}`, {
        headers: { authorization: `Bearer ${computerToken}` },
      });
      expect(control.status).toBe(200);
      expect(await control.json()).toMatchObject({ held: false, helpOpen: false });
      const connected = await fetch(`${BASE}/api/internal/connectors/request`, {
        method: "POST", headers: { authorization: `Bearer ${connectorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ botId: bot.id, threadId: turn.env.MURAGE_THREAD_ID, slugs: ["gmail"], resumeKey: "positive-fixture-connector" }),
      });
      expect(connected.status).toBe(200);
      const body = z.object({ messageIds: z.array(z.string()).length(1) }).parse(await connected.json());
      const current = (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id);
      expect(current.messages.find((message: { id: string }) => message.id === body.messageIds[0])).toMatchObject({
        kind: "connector", connector: { slug: "gmail", resumeKey: "positive-fixture-connector", status: "required" },
      });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
        .find((item: { id: string }) => item.id === bot.id)?.busy, { timeout: 5_000 }).toBe(false);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("PATCH", "/api/config", { features: { browser: false } });
      rmSync(descriptorFile, { force: true });
    }
  });

  it("binds agents calls to their actual bot, thread and route family", async () => {
    const source = (await desktopApi("POST", "/api/bots")).body.bot;
    const other = (await desktopApi("POST", "/api/bots")).body.bot;
    const next = await api("POST", `/api/bots/${source.id}/tasks`, { title: "Active authority task" });
    expect(next.status).toBe(201);
    try {
      const turn = await startInternalFixtureTurn(source.id);
      const liveThread = turn.env.MURAGE_THREAD_ID;
      expect(liveThread).toBe(next.body.task.threadId);
      expect((await fetch(`${BASE}/api/internal/agents?self=${source.id}`, { headers: turn.headers })).status).toBe(200);
      expect.soft((await fetch(`${BASE}/api/internal/agents?self=${other.id}`, { headers: turn.headers })).status).toBe(403);
      expect.soft((await fetch(`${BASE}/api/internal/routines?fromBotId=${source.id}&fromThreadId=${source.threadId}`, { headers: turn.headers })).status).toBe(403);
      expect((await fetch(`${BASE}/api/internal/routines?fromBotId=${source.id}&fromThreadId=${liveThread}`, { headers: turn.headers })).status).toBe(200);
      expect.soft((await fetch(`${BASE}/api/internal/computer-control?botId=${source.id}`, { headers: turn.headers })).status).toBe(403);
      const before = storedMessageCount(liveThread);
      const connector = await fetch(`${BASE}/api/internal/connectors/request`, {
        method: "POST", headers: turn.headers,
        body: JSON.stringify({ botId: source.id, threadId: liveThread, slugs: ["gmail"], resumeKey: "fixture-resume-identity" }),
      });
      expect.soft(connector.status).toBe(403);
      expect.soft(storedMessageCount(liveThread)).toBe(before);
      const exposed = JSON.stringify((await desktopApi("GET", "/api/bots?messages=100")).body);
      expect(exposed).not.toContain(turn.env.MURAGE_COMMS_TOKEN);
      expect(JSON.stringify((await desktopApi("GET", "/api/config")).body)).not.toContain(turn.env.MURAGE_COMMS_TOKEN);
    } finally {
      await api("POST", `/api/bots/${source.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${source.id}`);
      await desktopApi("DELETE", `/api/bots/${other.id}`);
    }
  });

  it("rejects forged recursion depth before queueing any delegation", async () => {
    const source = (await desktopApi("POST", "/api/bots")).body.bot;
    const target = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const turn = await startInternalFixtureTurn(source.id);
      const before = storedMessageCount(source.threadId);
      for (const depth of [-1, 1, "0", "invalid"]) {
        const response = await fetch(`${BASE}/api/internal/delegate-bot`, {
          method: "POST", headers: turn.headers,
          body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId, toBotId: target.id, message: "must not queue", depth }),
        });
        expect(response.status).toBe(403);
      }
      expect(storedMessageCount(source.threadId)).toBe(before);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === target.id)?.busy).toBeFalsy();
    } finally {
      await api("POST", `/api/bots/${source.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${target.id}`);
      await desktopApi("DELETE", `/api/bots/${source.id}`);
    }
  });

  it("revokes stopped and replaced generations without revoking the new turn", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const first = await startInternalFixtureTurn(bot.id);
      await stopFixtureTurn(bot.id, first);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: first.headers })).status).toBe(401);
      const second = await startInternalFixtureTurn(bot.id);
      expect(second.env.MURAGE_COMMS_TOKEN).not.toBe(first.env.MURAGE_COMMS_TOKEN);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: first.headers })).status).toBe(401);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: second.headers })).status).toBe(200);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("revalidates a capability after a delayed HTTP body before creating a card", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    let held: Awaited<ReturnType<typeof delayedJsonBody>> | undefined;
    try {
      const turn = await startInternalFixtureTurn(bot.id);
      held = await delayedJsonBody("POST", "/api/internal/request-credential", {
        fromBotId: bot.id, fromThreadId: bot.threadId,
        credentialId: "openaiImageApiKey", reason: "must not append after revocation",
      }, turn.headers);
      // Idle is not teardown for the Claude driver: interrupt releases the
      // run as soon as the kill is requested (A2 kept Claude's retained
      // sessions on that contract) and the child closes afterwards. Since
      // STOP1 a user Stop settles as cancelled — turn.completed ok:true
      // "cancelled", no "claude exited … before result" chip — so the
      // fixture's end of teardown is the stopped engine process being gone
      // (stopFixtureTurn) and its terminal fold having recorded the memory
      // outcome "cancelled" (STOP2); measure only after both.
      await stopFixtureTurn(bot.id, turn);
      await expect.poll(() => turnMemoryOutcomes(bot.threadId).at(-1), { timeout: 5_000 }).toBe("cancelled");
      const before = storedMessageCount(bot.threadId);
      const response = await held.finish();
      expect(response.status).toBe(401);
      expect(storedMessageCount(bot.threadId)).toBe(before);
    } finally {
      held?.close();
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps an event create budget across credential resumption while ordinary human turns retain their allowance", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const createdIds: string[] = [];
    let routineId = "", runId = "";
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "Event budget test", chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
      routineId = (await desktopApi("POST", "/api/routines", { name: "Budget event", prompt: "__fixture_hold_authority__",
        botId: bot.id, enabled: false, schedule: { type: "daily", time: "10:00", weekdays: [1] } })).body.routine.id;
      rmSync(fakeClaudeDump, { force: true });
      const queued = await desktopApi("POST", `/api/routines/${routineId}/run`);
      expect(queued.status).toBe(201); runId = queued.body.run.id;
      const first = await readJsonFileWhenReady<{ pid: number; mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } }>(fakeClaudeDump);
      const env = first.mcpConfig.mcpServers.agents.env;
      const threadId = env.MURAGE_THREAD_ID;
      expect(threadId).toBeTruthy();
      const headers = { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" };
      const create = async (requestHeaders: Record<string, string>, sourceThread: string, index: number) => {
        const response = await fetch(`${BASE}/api/internal/create-bot`, { method: "POST", headers: requestHeaders,
          body: JSON.stringify({ fromBotId: bot.id, fromThreadId: sourceThread, name: `Event operator ${index}`, role: "Research", instructions: "Review notes.", eventId: "forged-new-event" }) });
        const body = await response.json() as { id?: string; error?: string };
        if (body.id) createdIds.push(body.id);
        return { status: response.status, body };
      };
      for (let index = 0; index < 4; index++) expect((await create(headers, threadId, index)).status).toBe(201);
      const card = await fetch(`${BASE}/api/internal/request-credential`, { method: "POST", headers,
        body: JSON.stringify({ fromBotId: bot.id, fromThreadId: threadId, credentialId: "openaiImageApiKey", reason: "Test continuation ownership" }) });
      expect(card.status).toBe(201);
      const { messageId } = await card.json() as { messageId: string };
      writeFileSync(join(home, "finish-fake", String(first.pid)), "finish");
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === bot.id)?.busy).toBe(false);
      rmSync(fakeClaudeDump, { force: true });
      const resumed = await desktopApi("POST", `/api/bots/${bot.id}/secret-cards/${messageId}/dismiss`, { threadId });
      expect(resumed.status).toBe(200);
      const second = await readJsonFileWhenReady<{ pid: number; mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } }>(fakeClaudeDump);
      const nextToken = second.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      expect(nextToken).not.toBe(env.MURAGE_COMMS_TOKEN);
      const denied = await create({ ...headers, authorization: `Bearer ${nextToken}` }, threadId, 4);
      expect(denied.status).toBe(429);
      expect(denied.body.error).toMatch(/cumulative action limit/);
      const stored = readRoutinesWithRuns(join(home, ".murage", "routines.json")).runs.find((item: { id: string }) => item.id === runId);
      expect(stored.eventBudget.admissions.filter((item: { kind: string }) => item.kind === "create")).toHaveLength(4);
      writeFileSync(join(home, "finish-fake", String(second.pid)), "finish");
      const human = await startInternalFixtureTurn(bot.id);
      expect((await create(human.headers, human.env.MURAGE_THREAD_ID, 5)).status).toBe(201);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      if (runId) await desktopApi("POST", `/api/routine-runs/${runId}/cancel`);
      if (routineId) await desktopApi("DELETE", `/api/routines/${routineId}`);
      for (const id of createdIds) await desktopApi("DELETE", `/api/bots/${id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("bounds concurrent creates by the server-owned generation budget", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const created: string[] = [];
    try {
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
        section: "Capability creation budget", chiefOfStaff: true,
      })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const results = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        const response = await fetch(`${BASE}/api/internal/create-bot`, {
          method: "POST", headers: turn.headers,
          body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId,
            name: `Budget operator ${index}`, role: "Research operator", instructions: "Report concise findings." }),
        });
        const body = await response.json() as { id?: string };
        if (body.id) created.push(body.id);
        return response.status;
      }));
      expect(results.filter((status) => status === 201)).toHaveLength(4);
      expect(results.filter((status) => status === 429)).toHaveLength(2);
      expect(created).toHaveLength(4);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      for (const id of created) await desktopApi("DELETE", `/api/bots/${id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each([
    { senderAuto: true, recipientAuto: false, outcome: "holds recipient card despite sender Auto" },
    { senderAuto: false, recipientAuto: true, outcome: "allows recipient request despite sender manual mode" },
  ])("N6 delegated recipient permission $outcome", async ({ senderAuto, recipientAuto }) => {
    const startedAt = Date.now();
    const stage = (name: string) => console.info(`N6 recipientAuto=${recipientAuto} +${Date.now() - startedAt}ms ${name}`);
    stage("create source");
    const source = (await desktopApi("POST", "/api/bots", { name: "N6 sender" })).body.bot;
    stage("create recipient");
    const recipient = (await desktopApi("POST", "/api/bots", { name: "N6 recipient" })).body.bot;
    let permissionClient: import("node:net").Socket | undefined;
    try {
      for (const [bot, autoApprove] of [[source, senderAuto], [recipient, recipientAuto]] as const) {
        stage(bot.id === source.id ? "configure source" : "configure recipient");
        const cwd = join(home, `n6-work-${bot.id}`);
        mkdirSync(cwd);
        expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
          autoApprove, alwaysAllow: [], autoReview: "off", approvePeerComms: false,
          computer: "off", browser: false, composio: false, cwd,
        })).status).toBe(200);
      }
      stage("start source and obtain mounted capability");
      const turn = await startInternalFixtureTurn(source.id);
      stage("queue delegation");
      const queued = await fetch(`${BASE}/api/internal/delegate-bot`, {
        method: "POST", headers: turn.headers,
        body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId,
          toBotId: recipient.id, message: "__fixture_hold_authority__ N6 recipient permission", depth: 0 }),
      });
      expect(queued.status).toBe(200);
      expect(await queued.json()).toMatchObject({ queued: true, taskId: expect.any(String) });
      // Natural source completion is the production queue-drain trigger.
      rmSync(fakeClaudeDump, { force: true });
      writeFileSync(join(home, "finish-fake", String(turn.dump.pid)), "finish");
      stage("await naturally dispatched recipient mount");
      const recipientDump = await readJsonFileWhenReady<typeof turn.dump>(fakeClaudeDump);
      expect(recipientDump.pid).not.toBe(turn.dump.pid);
      const env = recipientDump.mcpConfig.mcpServers.agents.env;
      expect(env.MURAGE_BOT_ID).toBe(recipient.id);
      expect(env.MURAGE_THREAD_ID).toBe(recipient.threadId);
      stage("confirm source settled and recipient active");
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return [state.bots.find((b: { id: string }) => b.id === source.id)?.busy,
          state.bots.find((b: { id: string }) => b.id === recipient.id)?.busy];
      }).toEqual([false, true]);

      // Speak the real mounted proxy protocol; this is only an approval
      // payload, not a file read or command executed by the fixture.
      const socketPath = recipientDump.mcpConfig.mcpServers.muragebox?.args.at(-1);
      expect(socketPath).toBeTruthy();
      const { connect } = await import("node:net");
      stage("connect recipient permission broker");
      permissionClient = connect(socketPath!);
      permissionClient.on("error", () => {});
      await once(permissionClient, "connect");
      let received = "";
      permissionClient.on("data", chunk => { received += chunk.toString(); });
      const requestId = `n6-recipient-${recipient.id}`;
      permissionClient.write(JSON.stringify({ t: "ask", id: requestId, tool: "Read",
        input: { file_path: "N6_SYNTHETIC_PERMISSION_ONLY.txt" } }) + "\n");
      stage("permission sent; await recipient decision");
      const messages = async (id: string) => (await api("GET", "/api/bots?messages=100")).body.bots
        .find((bot: { id: string }) => bot.id === id).messages as Array<{
          card?: { requestId?: string; tool?: string; title?: string }; tool?: { name?: string };
        }>;
      if (recipientAuto) {
        await expect.poll(() => received).toContain("\n");
        expect(JSON.parse(received.trim())).toMatchObject({ t: "answer", id: requestId, behavior: "allow" });
        await expect.poll(async () => (await messages(recipient.id))
          .some(message => message.tool?.name?.includes("auto-approved Read"))).toBe(true);
        expect((await messages(recipient.id)).some(message => message.card?.requestId === requestId)).toBe(false);
      } else {
        await expect.poll(async () => (await messages(recipient.id))
          .find(message => message.card?.requestId === requestId)?.card)
          .toMatchObject({ requestId, tool: "Read", title: "Approval needed" });
        expect(received).toBe("");
        stage("recipient card held with no answer; send owner deny");
        expect((await desktopApi("POST", `/api/threads/${recipient.threadId}/respond`, { requestId, behavior: "deny" })).status).toBe(200);
        stage("owner deny accepted; await broker reply");
        await expect.poll(() => received).toContain("\n");
        expect(JSON.parse(received.trim())).toMatchObject({ t: "answer", id: requestId, behavior: "deny" });
      }
      stage("verify sender has no recipient approval");
      const senderMessages = await messages(source.id);
      expect(senderMessages.some(message => message.card?.requestId === requestId)).toBe(false);
      expect(senderMessages.some(message => message.tool?.name?.includes("auto-approved Read"))).toBe(false);
      stage("all permission assertions passed");
    } finally {
      stage("cleanup recipient");
      permissionClient?.destroy();
      await api("POST", `/api/bots/${recipient.id}/interrupt`);
      stage("cleanup source");
      await api("POST", `/api/bots/${source.id}/interrupt`);
      stage("delete recipient");
      await desktopApi("DELETE", `/api/bots/${recipient.id}`);
      stage("delete source");
      await desktopApi("DELETE", `/api/bots/${source.id}`);
      stage("cleanup complete");
    }
  });

  it("rejects approval-time reuse after the source provider naturally completes", async () => {
    const source = (await desktopApi("POST", "/api/bots")).body.bot;
    const target = (await desktopApi("POST", "/api/bots")).body.bot;
    let pending: Promise<Response> | undefined;
    const abort = new AbortController();
    try {
      expect((await desktopApi("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${target.id}`, { modelSelection: STATE_ONLY_SELECTION })).status).toBe(200);
      const targetMessagesBefore = storedMessageCount(target.threadId);
      const turn = await startInternalFixtureTurn(source.id);
      pending = fetch(`${BASE}/api/internal/ask-bot`, {
        method: "POST", headers: turn.headers, signal: abort.signal,
        body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId,
          toBotId: target.id, message: "needs current source authority", depth: 0 }),
      });
      void pending.catch(() => {});
      let requestId = "";
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=100")).body;
        const card = state.bots.find((bot: { id: string }) => bot.id === source.id)?.messages
          .find((message: { card?: { tool?: string; requestId?: string } }) => message.card?.tool === "ask_bot")?.card;
        requestId = card?.requestId ?? "";
        return Boolean(requestId);
      }).toBe(true);
      // Natural completion leaves the awaited human decision distinct from
      // explicit Stop's existing peer-approval cancellation mechanism.
      writeFileSync(join(home, "finish-fake", String(turn.dump.pid)), "finish");
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
        .find((bot: { id: string }) => bot.id === source.id)?.busy).toBe(false);
      await desktopApi("POST", `/api/threads/${source.threadId}/respond`, { requestId, behavior: "allow" });
      expect((await pending).status).toBe(401);
      const state = (await desktopApi("GET", "/api/bots?messages=0")).body;
      expect(state.groups.filter((group: { memberIds: string[] }) => group.memberIds.includes(source.id) && group.memberIds.includes(target.id))).toHaveLength(0);
      expect(storedMessageCount(target.threadId)).toBe(targetMessagesBefore);
    } finally {
      abort.abort();
      await pending?.catch(() => {});
      await api("POST", `/api/bots/${source.id}/interrupt`);
      await api("POST", `/api/bots/${target.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${target.id}`);
      await desktopApi("DELETE", `/api/bots/${source.id}`);
    }
  });

  it("bounds handoffs and lets a fresh source turn read its historical receipt", async () => {
    const source = (await desktopApi("POST", "/api/bots")).body.bot;
    const target = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const first = await startInternalFixtureTurn(source.id);
      const results = await Promise.all(Array.from({ length: 18 }, async (_, index) => {
        const response = await fetch(`${BASE}/api/internal/delegate-bot`, {
          method: "POST", headers: first.headers,
          body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId,
            toBotId: target.id, message: `Independent handoff ${index}`, depth: 0 }),
        });
        return { status: response.status, body: await response.json() as { taskId?: string } };
      }));
      expect(results.filter((result) => result.body.taskId)).toHaveLength(16);
      expect(results.filter((result) => result.status === 429)).toHaveLength(2);
      const receipt = results.find((result) => result.body.taskId)!.body.taskId!;
      await stopFixtureTurn(source.id, first);
      const second = await startInternalFixtureTurn(source.id);
      const url = `${BASE}/api/internal/delegations/${receipt}?fromBotId=${source.id}&fromThreadId=${source.threadId}&wait_ms=0`;
      expect((await fetch(url, { headers: first.headers })).status).toBe(401);
      const historical = await fetch(url, { headers: second.headers });
      expect(historical.status).toBe(200);
      expect(await historical.json()).toHaveProperty("status");
    } finally {
      await api("POST", `/api/bots/${source.id}/interrupt`);
      await api("POST", `/api/bots/${target.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${target.id}`);
      await desktopApi("DELETE", `/api/bots/${source.id}`);
    }
  });

  it("revokes room-member authority when its room stops", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Identity room stop", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    try {
      const turn = await startInternalFixtureTurn(bot.id, room.id);
      expect(turn.env.MURAGE_THREAD_ID).toBe(room.threadId);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: turn.headers })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: turn.headers })).status).toBe(401);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it.each(["delete", "model", "reload"] as const)("revokes authority on %s before a retired proxy can act", async (action) => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      const turn = await startInternalFixtureTurn(bot.id);
      if (action === "model" || action === "delete") {
        // Changing an active model, or deleting a bot with a running thread
        // (N7, 05cce991), is deliberately refused; it must leave the current
        // grant valid. Stop first, then apply the actual change.
        const refused = action === "model"
          ? await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: STATE_ONLY_SELECTION })
          : await desktopApi("DELETE", `/api/bots/${bot.id}`);
        expect(refused.status).toBe(409);
        expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: turn.headers })).status).toBe(200);
        expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
        await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id)?.busy,
        { timeout: 5_000 }).toBe(false);
      }
      const response = action === "delete"
        ? await desktopApi("DELETE", `/api/bots/${bot.id}`)
        : action === "model"
          ? await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: STATE_ONLY_SELECTION })
          : await desktopApi("PATCH", "/api/instances/claude", { cli: FAKE_CLAUDE_CLI });
      expect(response.status).toBe(200);
      expect((await fetch(`${BASE}/api/internal/agents?self=${bot.id}`, { headers: turn.headers })).status).toBe(401);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// The transcript-disclosure holes, closed end to end against the real
// harness. Each of these was reachable with nothing but a paired device
// token: hold /api/events open and every message on every thread arrives in
// real time, then read or grep whatever ids that stream just handed you.
describe("remote surfaces see only the conversations a person can see", () => {
  /** A bot with one distinctive line in its transcript, then hidden. */
  const seedHiddenBot = async (needle: string) => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const posted = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: needle });
    expect(posted.status).toBe(202);
    // the user's own message is persisted before the turn is dispatched, so
    // the transcript is searchable without waiting on a provider
    await expect
      .poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.length)
      .toBeGreaterThan(0);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);
    return bot;
  };

  it("does not push a hidden bot's frames to a stream that did not opt out", async () => {
    const bot = await seedHiddenBot("firehose probe alpha");

    // Two streams, one workspace, one event: the only difference is the
    // marker. Opening the desktop stream second and waiting on IT proves the
    // scoped stream was given a real chance to receive the frame.
    const scoped = await openSse(`${BASE}/api/events`);
    const desktop = await openSse(`${BASE}/api/events?${DESKTOP_QUERY}`);
    try {
      await scoped.until((f) => f.kind === "hello");
      await desktop.until((f) => f.kind === "hello");

      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { unread: true })).status).toBe(200);
      await desktop.until((f) => f.kind === "bot" && f.bot?.id === bot.id);
      expect(scoped.frames.some((f) => f.kind === "bot" && f.bot?.id === bot.id)).toBe(false);

      // and the scoped stream is not merely dead — a visible bot still lands
      const open = (await api("GET", "/api/bots")).body.bots.find((b: any) => !b.hidden);
      expect((await desktopApi("PATCH", `/api/bots/${open.id}`, { unread: true })).status).toBe(200);
      await scoped.until((f) => f.kind === "bot" && f.bot?.id === open.id);
    } finally {
      scoped.close();
      desktop.close();
    }
  });

  it("filters the replay buffer too, so a reconnect is not the way back in", async () => {
    // Scoping only the live write would mean a phone that dropped its
    // connection for one second got the firehose back on resume.
    const bot = await seedHiddenBot("firehose probe beta");

    const first = await openSse(`${BASE}/api/events?${DESKTOP_QUERY}`);
    const hello = await first.until((f) => f.kind === "hello");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { unread: true })).status).toBe(200);
    await first.until((f) => f.kind === "bot" && f.bot?.id === bot.id);
    first.close();

    const since = encodeURIComponent(hello.cursor);
    const resumed = await openSse(`${BASE}/api/events?since=${since}`);
    const resumedDesktop = await openSse(`${BASE}/api/events?since=${since}&${DESKTOP_QUERY}`);
    try {
      expect((await resumed.until((f) => f.kind === "hello")).resumed).toBe(true);
      // the desktop's replay carries the frame, so it really was in the
      // buffer and really was withheld from the other one
      await resumedDesktop.until((f) => f.kind === "bot" && f.bot?.id === bot.id);
      expect(resumed.frames.some((f) => f.kind === "bot" && f.bot?.id === bot.id)).toBe(false);
    } finally {
      resumed.close();
      resumedDesktop.close();
    }
  });

  it("scopes /api/search in SQL rather than after LIMIT", async () => {
    const needle = "firehose probe gamma";
    const bot = await seedHiddenBot(needle);

    const q = `/api/search?q=${encodeURIComponent(needle)}`;
    const desktop = await api("GET", `${q}&${DESKTOP_QUERY}`);
    expect(desktop.status).toBe(200);
    expect(desktop.body.hits.some((hit: any) => hit.threadId === bot.threadId)).toBe(true);

    const scoped = await api("GET", q);
    expect(scoped.status).toBe(200);
    expect(scoped.body.hits.some((hit: any) => hit.threadId === bot.threadId)).toBe(false);

    // asking for the thread by name is answered as "no hits", not as a
    // different status — the route must not become a membership oracle
    const named = await api("GET", `${q}&threadId=${bot.threadId}`);
    expect(named.status).toBe(200);
    expect(named.body.hits).toEqual([]);
  });

  it("refuses the direct reads that a harvested thread id used to unlock", async () => {
    const bot = await seedHiddenBot("firehose probe delta");

    for (const path of [
      `/api/threads/${bot.threadId}/messages`,
      `/api/threads/${bot.threadId}/export`,
      `/api/threads/${bot.threadId}/export?format=json`,
      // the inspector: the turn's prompts and tool traffic, which is
      // transcript content under another name and on the same thread
      `/api/threads/${bot.threadId}/events`,
    ]) {
      // 404, not 403: the two answers are the same fact, and distinguishing
      // them would hand back exactly the ids the scoping just withheld
      const scoped = await fetch(`${BASE}${path}`);
      expect(scoped.status, path).toBe(404);
      const joiner = path.includes("?") ? "&" : "?";
      const desktop = await fetch(`${BASE}${path}${joiner}${DESKTOP_QUERY}`);
      expect(desktop.status, path).toBe(200);
    }
  });

  it("does not lose the first messages of a brand-new conversation", async () => {
    // The staleness direction, and the likelier bug of the two. A frame that
    // outruns the store's thread→bot mapping is indistinguishable, at the
    // filter, from a conversation the person may not see — so the fix for a
    // leak becomes a phone that silently misses the opening lines of every
    // new chat and nobody finds out until someone is looking at a phone.
    const scoped = await openSse(`${BASE}/api/events`);
    try {
      await scoped.until((f) => f.kind === "hello");
      const before = (await api("GET", "/api/health")).body.unresolvedFrameDrops;

      const bot = (await desktopApi("POST", "/api/bots", { name: "Brand New" })).body.bot;
      const needle = "opening line of a new conversation";
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: needle })).status).toBe(202);

      // the very first frame on a thread created moments ago
      const first = await scoped.until(
        (f) => f.kind === "message" && f.threadId === bot.threadId && f.message?.role === "user",
        20_000,
      );
      expect(first.message.text).toContain(needle);

      // and nothing was withheld because it could not be resolved — the
      // counter exists so this is observable instead of inferred
      const after = (await api("GET", "/api/health")).body.unresolvedFrameDrops;
      expect(after).toBe(before);
    } finally {
      scoped.close();
    }
  }, 40_000);

  it("hydrates /api/bots with the same workspace the stream describes", async () => {
    // The widest read on the port: every bot and room with a page of
    // transcript inline. Scoping the stream while this answered for
    // everything would have been theatre — one request gets the content back.
    const bot = await seedHiddenBot("firehose probe zeta");

    const scoped = await api("GET", "/api/bots?messages=20");
    expect(scoped.status).toBe(200);
    expect(scoped.body.bots.some((b: any) => b.id === bot.id)).toBe(false);
    expect(JSON.stringify(scoped.body)).not.toContain("firehose probe zeta");
    expect(scoped.body.computerControl[bot.id]).toBeUndefined();
    // still a working hydration, not an empty one
    expect(scoped.body.bots.length).toBeGreaterThan(0);

    const desktop = await api("GET", `/api/bots?messages=20&${DESKTOP_QUERY}`);
    expect(desktop.body.bots.some((b: any) => b.id === bot.id)).toBe(true);
    expect(JSON.stringify(desktop.body)).toContain("firehose probe zeta");
  }, 40_000);

  // The renderer cannot tell which door it came through on its own —
  // `window.muragebox` is absent whenever the desktop runs against the Vite
  // dev server, which is how it is developed — so the harness, which is the
  // thing that read the markers, reports the answer here. Both surfaces may
  // call this route, which is what makes it usable as the seam.
  it("tells the renderer which surface it is on, and cannot be talked out of it", async () => {
    const desktop = await desktopApi("GET", "/api/config");
    expect(desktop.status).toBe(200);
    expect(desktop.body.surface).toBe("desktop");

    // What the door actually sends: it stamps the companion marker into a
    // fresh header object, so the renderer's own desktop marker rides along
    // and must lose.
    const throughTheDoor = await fetch(`${BASE}/api/config?${DESKTOP_QUERY}`, {
      headers: { "x-murage-companion": "1", ...DESKTOP_HEADERS },
    });
    expect(((await throughTheDoor.json()) as { surface: string }).surface).toBe("remote");

    // Node joins duplicate headers into "1, 1"; a value check read that as
    // "not a companion" and handed back "desktop".
    const duplicated = await fetch(`${BASE}/api/config?${DESKTOP_QUERY}`, {
      headers: [
        ["x-murage-companion", "1"],
        ["x-murage-companion", "1"],
      ] as [string, string][],
    });
    expect(((await duplicated.json()) as { surface: string }).surface).toBe("remote");
  });

  it("keeps a companion scoped even when it appends the desktop marker itself", async () => {
    // proxy.ts forwards req.url whole, so the query string is the device's
    // to write. The header is checked first for exactly this reason.
    const bot = await seedHiddenBot("firehose probe epsilon");
    const res = await fetch(`${BASE}/api/threads/${bot.threadId}/export?${DESKTOP_QUERY}`, {
      headers: { "x-murage-companion": "1" },
    });
    expect(res.status).toBe(404);
  });
});

// For the Inbox and for calls the harness, not the door, is the boundary: the
// door only adds the launch credential. These drive the composition in
// index.ts (the desktop-authority gate, inboxDoor, callAccess) with the real
// companionAuthorized, over a socket. The marker alone proves nothing.
describe("the Inbox, calls and image uploads open only to a proven companion", () => {
  const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const inboxThreads = (body: any) => new Set((body.items as Array<{ id: string }>).map((item) => JSON.parse(Buffer.from(item.id, "base64url").toString())[0]));
  const MARKER_ONLY = { "x-murage-companion": "1" };
  const WRONG_TOKEN = { "x-murage-companion": "1", "x-murage-companion-token": "e".repeat(64) };

  it("refuses the Inbox to the marker alone or a guessed credential, and scopes it for the real one", async () => {
    expect((await send("GET", "/api/inbox?view=all", MARKER_ONLY)).status).toBe(404);
    expect((await send("GET", "/api/inbox?view=all", WRONG_TOKEN)).status).toBe(404);

    const desktop = await send("GET", "/api/inbox?view=all&pageSize=100", DESKTOP_HEADERS);
    expect(desktop.status).toBe(200);
    expect(inboxThreads(desktop.body).has("test-inbox-open-room-thread")).toBe(true);
    expect(inboxThreads(desktop.body).has("test-inbox-dm-thread")).toBe(true);

    const phone = await send("GET", "/api/inbox?view=all&pageSize=100", PAIRED_PHONE);
    expect(phone.status).toBe(200);
    expect(inboxThreads(phone.body).has("test-inbox-open-room-thread")).toBe(true);
    // the private room is absent, not merely unlabeled, and not searchable
    expect(inboxThreads(phone.body).has("test-inbox-dm-thread")).toBe(false);
    expect(JSON.stringify(phone.body)).not.toContain("Inbox private channel");
    const searched = await send("GET", "/api/inbox?view=all&query=private", PAIRED_PHONE);
    expect(inboxThreads(searched.body).has("test-inbox-dm-thread")).toBe(false);

    // A state write is scoped the same way: the private room's item is not
    // found for the phone, and the marker alone never reaches the route.
    const privateItem = desktop.body.items.find((item: { id: string }) => inboxThreads({ items: [item] }).has("test-inbox-dm-thread"));
    const openItem = phone.body.items.find((item: { id: string }) => inboxThreads({ items: [item] }).has("test-inbox-open-room-thread"));
    const mark = (item: { id: string; version: string }) => ({ id: item.id, version: item.version, read: true });
    expect((await send("POST", "/api/inbox/state", MARKER_ONLY, mark(openItem))).status).toBe(404);
    expect(await send("POST", "/api/inbox/state", PAIRED_PHONE, mark(privateItem))).toEqual({ status: 404, body: { error: "Inbox item is unavailable." } });
    expect(await send("POST", "/api/inbox/state", PAIRED_PHONE, mark(openItem))).toEqual({ status: 200, body: { ok: true } });

    // the rest of the /api/inbox prefix stays desktop-only for the phone too
    // (0.1.61: a proven phone hears why, route-policy.ts)
    expect(await send("GET", "/api/inbox/other", PAIRED_PHONE)).toEqual({ status: 403, body: { error: "This needs the Murage app on your computer." } });
  });

  it("answers a call to a hidden bot exactly like a missing one, and refuses the marker alone", async () => {
    const visible = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const hidden = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${hidden.id}`, { hidden: true, chiefOfStaff: false })).status).toBe(200);
      for (const route of ["voice-host", "call-note"]) {
        const marker = await send("POST", `/api/bots/${visible.id}/${route}`, MARKER_ONLY, {});
        // 0.1.61: the gate (route-policy.ts, class companion) answers first,
        // and a caller that proved nothing learns nothing.
        expect(marker).toMatchObject({ status: 404, body: { error: "no such route" } });
        expect((await send("POST", `/api/bots/${visible.id}/${route}`, WRONG_TOKEN, {})).status).toBe(404);

        const hiddenCall = await send("POST", `/api/bots/${hidden.id}/${route}`, PAIRED_PHONE, {});
        const missingCall = await send("POST", `/api/bots/no-such-bot/${route}`, PAIRED_PHONE, {});
        expect(hiddenCall).toEqual({ status: 404, body: { error: "no such bot" } });
        expect(hiddenCall).toEqual(missingCall);
      }
      // A visible bot reaches each handler, which answers its own next error
      // (voice-host needs something said) or writes nothing for an empty log.
      expect(await send("POST", `/api/bots/${visible.id}/voice-host`, PAIRED_PHONE, {})).toEqual({ status: 400, body: { error: "text required" } });
      expect(await send("POST", `/api/bots/${visible.id}/call-note`, PAIRED_PHONE, { log: [] })).toEqual({ status: 200, body: { ok: true, written: false } });
    } finally {
      await desktopApi("DELETE", `/api/bots/${visible.id}`);
      await desktopApi("DELETE", `/api/bots/${hidden.id}`);
    }
  });

  it("takes a phone's image for a conversation it can see, and answers a hidden one like a missing one", async () => {
    const visible = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const hidden = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
    const upload = async (threadId: string, headers: Record<string, string>) => {
      const res = await fetch(`${BASE}/api/attachments?threadId=${threadId}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: png });
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    try {
      expect((await desktopApi("PATCH", `/api/bots/${hidden.id}`, { hidden: true, chiefOfStaff: false })).status).toBe(200);
      expect(await upload(visible.threadId, MARKER_ONLY)).toEqual({ status: 404, body: { error: "no such conversation" } });
      expect((await upload(visible.threadId, WRONG_TOKEN)).status).toBe(404);

      const taken = await upload(visible.threadId, PAIRED_PHONE);
      expect(taken.status).toBe(201);
      expect(taken.body).toMatchObject({ mime: "image/png", bytes: png.byteLength });
      const hiddenUpload = await upload(hidden.threadId, PAIRED_PHONE);
      expect(hiddenUpload).toEqual({ status: 404, body: { error: "no such conversation" } });
      expect(hiddenUpload).toEqual(await upload("no-such-thread", PAIRED_PHONE));
      // the private bot-to-bot room is not the phone's either
      expect((await upload("test-inbox-dm-thread", PAIRED_PHONE)).status).toBe(404);
    } finally {
      await desktopApi("DELETE", `/api/bots/${visible.id}`);
      await desktopApi("DELETE", `/api/bots/${hidden.id}`);
    }
  });
});

describe("the Chief of Staff is not replaced by accident", () => {
  // Every other role in this chart is a handover: electing a team lead stands
  // the previous one down and the UI says whose role moved. The Chief is the
  // bot the whole workspace routes through, and every surface that could
  // elect a second one did it silently — a mis-click on a role control, a
  // package naming a coordinator. Sean asked for a refusal instead, and a
  // refusal is only worth having if it changes nothing when it fires.
  const makeBot = async (name: string) =>
    (await desktopApi("POST", "/api/bots", { name, title: "Test", description: "t", color: "purple" })).body.bot;

  /** Stand down whoever currently holds the role.
   *
   * These tests share one workspace with every other test in this file, and
   * the rule under test is precisely "there can only be one" — so a test that
   * assumed an empty chair was refused by the feature it was written to
   * verify. Clearing first makes each one independent of what ran before it,
   * and exercises the stand-down path on the way in. */
  const standDownChief = async () => {
    const bots: { id: string; chiefScope?: string }[] = (await api("GET", "/api/bots")).body.bots;
    for (const bot of bots.filter((candidate) => candidate.chiefScope === "workspace")) {
      await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: false, chiefScope: null, individual: false });
    }
  };

  it("refuses a second Chief and names the one already holding it", async () => {
    await standDownChief();
    const first = await makeBot("Single Holder Sable");
    const second = await makeBot("Single Holder Rex");
    expect((await desktopApi("PATCH", `/api/bots/${first.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);

    const refused = await desktopApi("PATCH", `/api/bots/${second.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Single Holder Sable");
    // The message has to say how to leave the state, not just that you are in it.
    expect(refused.body.error).toMatch(/Remove that role/);
  });

  it("changes NOTHING when it refuses", async () => {
    await standDownChief();
    // The guard runs before patchBot, so a rejected request must leave both
    // bots exactly as they were. A refusal that half-applied would be worse
    // than the silent handover it replaced.
    const first = await makeBot("Untouched Chief");
    const second = await makeBot("Rejected Claimant");
    await desktopApi("PATCH", `/api/bots/${first.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
    await desktopApi("PATCH", `/api/bots/${second.id}`, { chiefOfStaff: true, chiefScope: "workspace" });

    const bots = (await api("GET", "/api/bots")).body.bots;
    const incumbent = bots.find((bot: { id: string }) => bot.id === first.id);
    const claimant = bots.find((bot: { id: string }) => bot.id === second.id);
    expect(incumbent.chiefOfStaff).toBe(true);
    expect(incumbent.chiefScope).toBe("workspace");
    expect(claimant.chiefScope).toBeUndefined();
  });

  it("still lets the SAME bot re-assert the role", async () => {
    await standDownChief();
    // The guard compares ids. Without that, re-saving a role control on the
    // incumbent would refuse her her own job.
    const chief = await makeBot("Re-asserting Chief");
    expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
    expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
  });

  it("lets the role move once the incumbent stands down", async () => {
    await standDownChief();
    // The whole point: one extra step, not a locked door.
    const outgoing = await makeBot("Outgoing Chief");
    const incoming = await makeBot("Incoming Chief");
    await desktopApi("PATCH", `/api/bots/${outgoing.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
    expect((await desktopApi("PATCH", `/api/bots/${incoming.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(409);

    await desktopApi("PATCH", `/api/bots/${outgoing.id}`, { chiefOfStaff: false, chiefScope: null, individual: false });
    expect((await desktopApi("PATCH", `/api/bots/${incoming.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
  });

  it("does not block a TEAM LEAD, which is an ordinary handover", async () => {
    await standDownChief();
    // The asymmetry is deliberate. A team's lead changing is reversible and
    // local; blocking it would make the sidebar's own menu item fail.
    const chief = await makeBot("Guarding Chief");
    await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
    const lead = await makeBot("Ordinary Lead");
    expect((await desktopApi("PATCH", `/api/bots/${lead.id}`, { chiefOfStaff: true, chiefScope: "section" })).status).toBe(200);
  });
});

// ── the new-bot setup conversation ────────────────────────────────────
//
// POST /api/bots/:botId/intake. Everything here asserts a CONTRACT — a step,
// a chip built by the shared helper, an outcome, a bot that was not renamed —
// and deliberately not a sentence. The copy on these cards is meant to be
// edited; pinning it here would make every edit look like a regression, and
// several stale tests in this repo were written exactly that way.
// The suite timeout is deliberate and generous: this describe runs last in a
// ten-minute file, and every answer classifies the WHOLE catalogue (~465ms
// measured, see the memo comment beside `intakeCandidates`). The default 20s
// is a load measurement here rather than a contract.
describe("new-bot setup conversation", () => {
  interface IntakeCard {
    title: string;
    subtitle: string;
    options: string[];
    answered?: string;
    dismissed?: boolean;
    intake?: IntakeCardData;
  }
  interface TranscriptMessage {
    id: string;
    role: "bot" | "user";
    kind: string;
    text?: string;
    card?: IntakeCard;
  }

  const makeBot = async (name: string): Promise<{ id: string; name: string; threadId: string }> =>
    (await desktopApi("POST", "/api/bots", { name, title: "Test", description: "t", color: "purple" })).body.bot;

  const transcript = async (threadId: string): Promise<TranscriptMessage[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;

  /** The question on the table, read the way the renderer reads it: the LAST
   * intake card the server has not recorded an answer on. */
  const openQuestion = (messages: readonly TranscriptMessage[]): TranscriptMessage | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.kind !== "options" || !message.card?.intake) continue;
      if (message.card.answered !== undefined || message.card.dismissed) continue;
      return message;
    }
    return null;
  };

  const openCardOf = async (threadId: string): Promise<IntakeCard> => {
    const open = openQuestion(await transcript(threadId));
    expect(open?.card?.intake).toBeTruthy();
    return open!.card!;
  };

  const openIdOf = async (threadId: string): Promise<string> => {
    const open = openQuestion(await transcript(threadId));
    expect(open).toBeTruthy();
    return open!.id;
  };

  /** One turn: whatever the person said or pressed, sent back verbatim. */
  const say = async (bot: { id: string; threadId: string }, text: string) => {
    const messageId = await openIdOf(bot.threadId);
    const response = await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, text });
    return { messageId, response };
  };

  const close = async (
    bot: { id: string; threadId: string },
    messageId: string,
    outcome: "profile" | "general" | "library",
  ) => desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, outcome });

  const intakeCards = (messages: readonly TranscriptMessage[]): IntakeCard[] =>
    messages.flatMap((message) => (message.card?.intake ? [message.card] : []));

  /** Measured against the shipped catalogue, and re-derived rather than
   * assumed: the catalogue grew (201 single-bot profiles now), and "chasing
   * invoices" reaches two of them firmly (collections, coin), so it forks. The
   * firm answer must reach exactly ONE profile on a whole word; "meal
   * planning" reaches only meal-planner. Re-derive when the catalogue grows. */
  const FIRM_ANSWER = "meal planning";
  /** The same topic word alone. One word cannot corroborate itself, so it is
   * thin by construction however well it matches. */
  const THIN_ANSWER = "meal";
  /** Three topic words that reach more than one profile firmly. */
  const FORKED_ANSWER = "reading my trading charts";
  /** No topic words at all. */
  const EMPTY_ANSWER = "hi";

  it("seeds one open question and nothing else to answer", async () => {
    const bot = await makeBot("Freshly Made");
    const card = await openCardOf(bot.threadId);
    expect(card.intake).toMatchObject({ step: "open", asked: 1 });
    // No chips on the opening question: the composer is the answer.
    expect(card.options).toEqual([]);
    expect(intakeCards(await transcript(bot.threadId))).toHaveLength(1);
  });

  it("proposes a speciality on ONE question when the answer is firm", async () => {
    const bot = await makeBot("Firm Answer");
    expect((await say(bot, FIRM_ANSWER)).response.status).toBe(202);

    const messages = await transcript(bot.threadId);
    // the person's own words are in the transcript, and the question is spent
    expect(messages.some((message) => message.role === "user" && message.text === FIRM_ANSWER)).toBe(true);
    expect(intakeCards(messages)[0]!.answered).toBe(FIRM_ANSWER);

    const card = openQuestion(messages)!.card!;
    expect(card.intake!.step).toBe("confirm");
    expect(card.intake!.outcome).toBe("profile");
    expect(card.intake!.asked).toBe(1);
    expect(card.intake!.candidate!.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(card.intake!.candidate!.name).toBeTruthy();
    // A firm answer is never asked a second question.
    expect(intakeCards(messages).filter((entry) => entry.intake!.step === "narrow")).toHaveLength(0);
  });

  it("asks a SECOND question rather than guessing a profile from a thin answer", async () => {
    const bot = await makeBot("Thin Answer");
    expect((await say(bot, THIN_ANSWER)).response.status).toBe(202);

    const card = await openCardOf(bot.threadId);
    // The contract: a thin answer buys a question. Not a profile, and not a
    // silent install of the profile the word happened to brush against.
    expect(card.intake!.step).toBe("narrow");
    expect(card.intake!.asked).toBe(2);
    expect(card.intake!.candidate!.name).toBeTruthy();
    expect(card.intake!.outcome).toBeUndefined();

    // …and the SAME topic word inside a fuller sentence does resolve, which
    // is what makes this a strength tier rather than a blanket refusal.
    const firm = await makeBot("Firm Companion");
    await say(firm, FIRM_ANSWER);
    expect((await openCardOf(firm.threadId)).intake!.step).toBe("confirm");
  });

  it("resolves the one clarifier from the combined intent, with an explicit correction taking priority", async () => {
    const continued = await makeBot("Carry The Opening Intent");
    await say(continued, THIN_ANSWER);
    expect((await openCardOf(continued.threadId)).intake!.step).toBe("narrow");
    await say(continued, "planning them");
    // "planning them" alone has no meal subject. The opening answer is the
    // missing context, so this must take the same firm profile branch as
    // "meal planning" without asking a duplicated third question.
    expect((await openCardOf(continued.threadId)).intake).toMatchObject({
      step: "confirm", outcome: "profile", asked: 2,
    });

    const corrected = await makeBot("Correction Wins");
    await say(corrected, "trading");
    const beforeCorrection = (await openCardOf(corrected.threadId)).intake!.candidate!;
    await say(corrected, "Actually, I mean meal planning");
    const afterCorrection = (await openCardOf(corrected.threadId)).intake!;
    expect(afterCorrection).toMatchObject({ step: "confirm", outcome: "profile", asked: 2 });
    expect(afterCorrection.candidate!.slug).not.toBe(beforeCorrection.slug);
  });

  it("never asks a third question, whatever the second answer is", async () => {
    const bot = await makeBot("Nothing To Say");
    expect((await say(bot, EMPTY_ANSWER)).response.status).toBe(202);
    const second = await openCardOf(bot.threadId);
    expect(second.intake!.step).toBe("narrow");
    expect(second.intake!.asked).toBe(2);

    expect((await say(bot, "dunno")).response.status).toBe(202);

    const messages = await transcript(bot.threadId);
    const cards = intakeCards(messages);
    // Two questions were asked and the third turn is a decision, not a
    // question. `asked` never leaves {1, 2}, on any card, ever.
    expect(cards.filter((card) => card.intake!.step !== "confirm")).toHaveLength(2);
    for (const card of cards) expect([1, 2]).toContain(card.intake!.asked);
    expect(openQuestion(messages)!.card!.intake!.step).toBe("confirm");
  });

  it("reaches general chat as an outcome, and stops there", async () => {
    const bot = await makeBot("General Is Fine");
    await say(bot, EMPTY_ANSWER);
    await say(bot, "dunno");

    const card = await openCardOf(bot.threadId);
    expect(card.intake).toMatchObject({ step: "confirm", outcome: "general" });
    // general chat installs nothing, so it carries no candidate at all
    expect(card.intake!.candidate).toBeUndefined();
    expect(card.options).toEqual([...intakeChips("confirm-general")]);

    const messageId = await openIdOf(bot.threadId);
    const closed = await close(bot, messageId, "general");
    expect(closed.status).toBe(202);

    const messages = await transcript(bot.threadId);
    // the accept chip is recorded by POSITION, off the card's own options
    const settled = messages.find((message) => message.id === messageId)!.card!;
    expect(settled.answered).toBe(intakeChips("confirm-general")[0]);
    // one closing line from the bot, and then nothing left to answer
    expect(messages.at(-1)!.role).toBe("bot");
    expect(messages.at(-1)!.kind).toBe("text");
    expect(openQuestion(messages)).toBeNull();
  });

  it("opens the library as its own outcome, without installing anything", async () => {
    const bot = await makeBot("Show Me The Library");
    await say(bot, EMPTY_ANSWER);
    await say(bot, "dunno");
    const card = await openCardOf(bot.threadId);
    expect(card.intake).toMatchObject({ step: "confirm", outcome: "general" });

    const messageId = await openIdOf(bot.threadId);
    expect((await close(bot, messageId, "library")).status).toBe(202);

    const messages = await transcript(bot.threadId);
    // the second chip, by position, and a closing line of its own
    expect(messages.find((message) => message.id === messageId)!.card!.answered).toBe(
      intakeChips("confirm-general")[1],
    );
    expect(messages.at(-1)!.kind).toBe("text");
    expect(openQuestion(messages)).toBeNull();
    // the library is a place to look, not an install
    expect((await api("GET", `/api/bots/${bot.id}/skills`)).body.skills).toEqual([]);
  });

  it("answers an already-answered card once and only once", async () => {
    const bot = await makeBot("Double Press");
    const { messageId } = await say(bot, EMPTY_ANSWER);
    const afterFirst = await transcript(bot.threadId);

    const again = await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, text: EMPTY_ANSWER });
    expect(again.status).toBe(409);
    // the renderer shows this string to a person as it stands
    expect(typeof again.body.error).toBe("string");
    expect(again.body.error).toMatch(/already answered/);
    expect(await transcript(bot.threadId)).toHaveLength(afterFirst.length);

    // the same guard on the outcome form
    const outcomeAgain = await close(bot, messageId, "general");
    expect(outcomeAgain.status).toBe(409);
    expect(await transcript(bot.threadId)).toHaveLength(afterFirst.length);
  });

  it("never renames the bot and never installs anything, even on 'profile'", async () => {
    const bot = await makeBot("Named By The Person");
    await say(bot, FIRM_ANSWER);
    const card = await openCardOf(bot.threadId);
    const candidate = card.intake!.candidate as IntakeCandidate;
    // the proposal is for a differently-named profile, so a rename would show
    expect(candidate.name).not.toBe(bot.name);

    const messageId = await openIdOf(bot.threadId);
    expect((await close(bot, messageId, "profile")).status).toBe(202);

    const after = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (entry: { id: string }) => entry.id === bot.id,
    );
    // rename: false, pinned. The install itself belongs to the desktop-gated
    // assistant-profile route, which this route must never stand in for.
    expect(after.name).toBe("Named By The Person");
    expect((await api("GET", `/api/bots/${bot.id}/skills`)).body.skills).toEqual([]);
    // and the closing line names the profile the person accepted
    const messages = await transcript(bot.threadId);
    expect(messages.at(-1)!.text).toContain(candidate.name);
    expect(openQuestion(messages)).toBeNull();
  });

  it("builds every two-chip card through the shared helper, in the helper's order", async () => {
    // The renderer maps intake chips BY INDEX. A pair written by hand in the
    // wrong order records "set this up" as a refusal, silently, with nothing
    // thrown on either side of the seam — so the order is pinned against the
    // helper rather than against two strings written out again here.
    const confirming = await makeBot("Chip Order Confirm");
    await say(confirming, FIRM_ANSWER);
    expect((await openCardOf(confirming.threadId)).options).toEqual([...intakeChips("confirm-profile")]);

    const checking = await makeBot("Chip Order Check");
    await say(checking, THIN_ANSWER);
    expect((await openCardOf(checking.threadId)).options).toEqual([...intakeChips("narrow-check")]);

    const general = await makeBot("Chip Order General");
    await say(general, EMPTY_ANSWER);
    await say(general, "dunno");
    expect((await openCardOf(general.threadId)).options).toEqual([...intakeChips("confirm-general")]);

    const forked = await makeBot("Chip Order Pick");
    await say(forked, FORKED_ANSWER);
    const pick = await openCardOf(forked.threadId);
    expect(pick.intake!.step).toBe("narrow");
    const choices = pick.intake!.choices!;
    expect(choices).toHaveLength(2);
    expect(pick.options).toEqual([...intakeNarrowPickChips(choices[0]!, choices[1]!)]);
    // four conversations in one test, and the first intake answer in the
    // process pays for the cold pass over the whole skills library
  });

  it("writes no chip label of its own into the server source", async () => {
    // The behavioural check above passes just as happily if a call site
    // inlines the pair in the RIGHT order today and someone swaps it
    // tomorrow. This is the check that keeps the helper the only source: the
    // fixed labels live in shared/intake-turn.ts, so the server must not
    // contain one.
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    const labels = (["narrow-check", "confirm-profile", "confirm-general"] as const).flatMap((kind) => [
      ...intakeChips(kind),
    ]);
    expect(labels.length).toBe(6);
    for (const label of labels) expect(source).not.toContain(label);
  });

  it("resolves a narrow-check by POSITION, both ways", async () => {
    const accepting = await makeBot("Narrow Accept");
    await say(accepting, THIN_ANSWER);
    const offered = (await openCardOf(accepting.threadId)).intake!.candidate!;
    await say(accepting, intakeChips("narrow-check")[0]);
    const accepted = await openCardOf(accepting.threadId);
    expect(accepted.intake).toMatchObject({ step: "confirm", outcome: "profile", asked: 2 });
    expect(accepted.intake!.candidate!.slug).toBe(offered.slug);

    const declining = await makeBot("Narrow Decline");
    await say(declining, THIN_ANSWER);
    await say(declining, intakeChips("narrow-check")[1]);
    const declined = await openCardOf(declining.threadId);
    expect(declined.intake).toMatchObject({ step: "confirm", outcome: "general" });
    expect(declined.intake!.candidate).toBeUndefined();
  });

  it("refuses a body that names no open question", async () => {
    const bot = await makeBot("Bad Bodies");
    const messageId = await openIdOf(bot.threadId);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId })).status).toBe(400);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, text: "  " })).status).toBe(400);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, outcome: "nope" })).status).toBe(400);
    // an open question is not a confirm card, so it takes no outcome
    expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId, outcome: "profile" })).status).toBe(400);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, { messageId: "nope", text: "x" })).status).toBe(404);
    expect((await api("POST", "/api/bots/not-a-bot/intake", { messageId, text: "x" })).status).toBe(404);
    // and none of that spent the question
    expect((await openCardOf(bot.threadId)).intake!.step).toBe("open");
  });

  it("offers the shipped Home Planner playbook through ordinary conversational discovery", async () => {
    const bot = await makeBot("Household helper");
    expect((await say(bot, "Home Planner for household tasks and appointments")).response.status).toBe(202);
    const card = await openCardOf(bot.threadId);
    const candidates = [card.intake?.candidate, ...(card.intake?.choices ?? [])];
    const offered = candidates.find(candidate => candidate?.slug === "starter-personal-home");
    expect(offered).toMatchObject({ slug: "starter-personal-home", profileReviewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
    expect(current).toMatchObject({ id: bot.id, name: "Household helper", threadId: bot.threadId });
    expect(current.playbooks ?? []).toEqual([]);
  });

  it.each(["cowork", "starter-personal-home"])("adapts a reviewed one-bot playbook package without flattening a team: %s", async (slug) => {
    const bot = await makeBot("Keep this name");
    const before = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)!;
    const catalog = await api("GET", "/api/team-library/catalog");
    const cowork = catalog.body.teams.find((entry: { slug: string }) => entry.slug === slug);
    expect(cowork).toMatchObject({ members: 1, adaptable: true, playbooks: expect.any(Array) });
    expect(cowork.profileReviewHash).toMatch(/^[a-f0-9]{64}$/);

    const legacy = await desktopApi("POST", `/api/bots/${bot.id}/assistant-profile`, { slug, rename: false });
    expect(legacy.status).toBe(200);
    expect(legacy.body.playbooks).toEqual([]);
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)!.playbooks)
      .toEqual(before.playbooks);

    const applied = await desktopApi("POST", `/api/bots/${bot.id}/assistant-profile`, {
      slug, rename: false, profileReviewHash: cowork.profileReviewHash,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.bot).toMatchObject({ id: bot.id, name: "Keep this name" });
    expect(applied.body.playbooks.length).toBeGreaterThan(0);
    const after = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)!;
    expect(after).toMatchObject({ id: before.id, name: before.name, threadId: before.threadId });
    expect(after.chiefOfStaff).toBe(before.chiefOfStaff);
    expect(after.playbooks).toMatchObject(applied.body.playbooks);

    const repeated = await desktopApi("POST", `/api/bots/${bot.id}/assistant-profile`, {
      slug, rename: false, profileReviewHash: cowork.profileReviewHash,
    });
    expect(repeated.status).toBe(200);
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)!.playbooks)
      .toEqual(after.playbooks);

    expect((await desktopApi("POST", `/api/bots/${bot.id}/assistant-profile`, {
      slug, rename: false, profileReviewHash: "0".repeat(64),
    })).status).toBe(409);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/assistant-profile`, {
      slug: "starter-business-team", rename: false,
    })).status).toBe(422);
  });

  // ── M1 ──────────────────────────────────────────────────────────────
  //
  // "the first message to a new bot is treated as its intake answer, the
  // request is dropped, and it can suggest an absurd profile" — the 0.1.56
  // Mac customer test, verbatim, including the sentence that reproduced it.
  //
  // Two separate defects wear one bug number and each is pinned on its own
  // here, because fixing either alone still leaves a person worse off than
  // having no setup conversation at all:
  //
  //   THE REQUEST WAS DROPPED. The composer sent a typed answer to the intake
  //   route INSTEAD of to the bot, so whatever the first message was, it was
  //   read as an answer to "What do you actually want me for?" and never run.
  //
  //   THE PROFILE WAS ABSURD. `game-3d`'s curated terms carry `file` and
  //   `containing`, from its own summary, and two ordinary words out of ten
  //   were enough to confirm a Three.js game generator for a request about a
  //   prices file.
  describe("M1: a first message is a request, not an answer", () => {
    /** The exact sentence from the repro. */
    const REQUEST = 'Save a file named notes/prices.md containing the line "Croissant 3.50". Then say done.';

    it("runs the turn, with the opening question still on the table", async () => {
      const bot = await makeBot("Nova");
      // The question really is open: this is the state M1 happens in.
      const question = await openIdOf(bot.threadId);
      expect((await openCardOf(bot.threadId)).intake).toMatchObject({ step: "open", asked: 1 });

      // THE SEND, exactly as the composer makes it: the ordinary chat route,
      // question or no question. The fixture engine's launch dump is the
      // proof — it carries the prompt the engine was actually given.
      const turn = await startInternalFixtureTurn(bot.id, undefined, REQUEST);
      try {
        expect(JSON.stringify(turn.dump.prompt)).toContain("notes/prices.md");
        expect(JSON.stringify(turn.dump.prompt)).toContain("Croissant 3.50");
      } finally {
        await stopFixtureTurn(bot.id, turn, bot.threadId);
      }

      // AND THE SETUP CONVERSATION IS TOLD, second, the way the composer tells
      // it. It listens: it records the answer, it does not repeat the person's
      // words, and — the catalogue having nothing confident to say about a
      // prices file — it says nothing.
      const heard = await desktopApi("POST", `/api/bots/${bot.id}/intake`, {
        messageId: question, text: REQUEST, alongside: true,
      });
      expect(heard.status, JSON.stringify(heard.body)).toBe(202);

      const after = await transcript(bot.threadId);
      expect(after.filter((message) => message.role === "user" && message.text === REQUEST)).toHaveLength(1);
      // Nothing left to answer, and no second question or verdict appended.
      expect(openQuestion(after)).toBeNull();
      expect(intakeCards(after).map((entry) => entry.intake?.step)).toEqual(["open"]);
      expect(intakeCards(after)[0]).toMatchObject({ answered: REQUEST });
    });

    it("never names 3D Star Adventure for a request about a prices file", async () => {
      // THE ROUTE AND THE CATALOGUE THE APP SHIPS. `profile.slug` was
      // "game-3d" here; the confidence floor is what stops it.
      const suggested = await api("GET", `/api/library/suggest?q=${encodeURIComponent(REQUEST)}`);
      expect(suggested.status).toBe(200);
      expect(suggested.body.profile?.slug).not.toBe("game-3d");

      // And the same sentence through the CONVERSATION's own classifier,
      // which reads the whole catalogue rather than a bm25 top-8: a fresh
      // bot answering with it is offered no profile at all.
      const bot = await makeBot("Second Nova");
      const question = await openIdOf(bot.threadId);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, {
        messageId: question, text: REQUEST, alongside: true,
      })).status).toBe(202);
      const cards = intakeCards(await transcript(bot.threadId));
      expect(cards.flatMap((entry) => entry.intake?.candidate ? [entry.intake.candidate.slug] : [])).toEqual([]);
    });

    it("the soft case is answered by the bot, not by a second question", async () => {
      // "Reply with one short sentence: what is the capital of Australia?"
      // came back as another intake question instead of the answer.
      const soft = "Reply with one short sentence: what is the capital of Australia?";
      const bot = await makeBot("Third Nova");
      const question = await openIdOf(bot.threadId);
      const turn = await startInternalFixtureTurn(bot.id, undefined, soft);
      try {
        expect(JSON.stringify(turn.dump.prompt)).toContain("capital of Australia");
      } finally {
        await stopFixtureTurn(bot.id, turn, bot.threadId);
      }
      expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, {
        messageId: question, text: soft, alongside: true,
      })).status).toBe(202);
      // No follow-up question, and no "Fine, general it is" either.
      const after = await transcript(bot.threadId);
      expect(intakeCards(after).map((entry) => entry.intake?.step)).toEqual(["open"]);
      expect(after.some((message) => message.text?.startsWith("Fine, general it is"))).toBe(false);
    });

    it("a confirm card is not spent by a request that has nothing to do with it", async () => {
      // The same bug one turn later. A person who answers the opening
      // question, is offered a profile, and then asks for something else must
      // get the something else — and must not lose the offer, which is a
      // decision they have not made yet.
      const bot = await makeBot("Fourth Nova");
      await say(bot, FIRM_ANSWER);
      const offer = await openCardOf(bot.threadId);
      expect(offer.intake).toMatchObject({ step: "confirm", outcome: "profile" });
      const offerId = await openIdOf(bot.threadId);

      const heard = await desktopApi("POST", `/api/bots/${bot.id}/intake`, {
        messageId: offerId, text: REQUEST, alongside: true,
      });
      expect(heard.status).toBe(202);

      const after = await transcript(bot.threadId);
      // The offer is untouched and still pressable.
      expect(openQuestion(after)?.id).toBe(offerId);
      expect(after.find((message) => message.id === offerId)?.card?.answered).toBeUndefined();
      // Nothing was said over the top of it, and the request is not recorded
      // here — the chat route carries that.
      expect(after.some((message) => message.text?.startsWith("Fine, general it is"))).toBe(false);
      expect(after.some((message) => message.role === "user" && message.text === REQUEST)).toBe(false);
    });

    it("still offers a profile alongside, when the catalogue has one to name", async () => {
      // THE FEATURE IS NOT DELETED. A person whose first message really is
      // about one thing gets their turn AND the offer.
      const bot = await makeBot("Fifth Nova");
      const question = await openIdOf(bot.threadId);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/intake`, {
        messageId: question, text: FIRM_ANSWER, alongside: true,
      })).status).toBe(202);
      const after = await transcript(bot.threadId);
      expect(openQuestion(after)?.card?.intake).toMatchObject({ step: "confirm", outcome: "profile" });
      // Still without repeating the person's words: the chat route has them.
      expect(after.filter((message) => message.role === "user" && message.text === FIRM_ANSWER)).toHaveLength(0);
    });
  });
}, 120_000);
