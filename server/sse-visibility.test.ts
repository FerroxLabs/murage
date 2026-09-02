// The surface filter in front of the SSE fan-out and the transcript reads.
//
// These are the pure decisions — which conversation a frame is about, who may
// see that conversation, and which door asked — stated without a server, so
// each rule can be read on one screen and each failure names one rule.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_SURFACE,
  KNOWN_FRAME_KINDS,
  frameSubject,
  requestSurface,
  subjectResolves,
  visibleToCompanion,
  type FrameSubject,
  type VisibilityStore,
} from "./sse-visibility.ts";

/** A workspace in four lines: one ordinary bot, one hidden bot, one room,
 * one bot⇄bot dm channel. `t*` are thread ids, including task threads. */
const world = (): VisibilityStore => {
  const bots: Record<string, { id: string; hidden?: boolean; threads: string[] }> = {
    open: { id: "open", threads: ["t-open", "t-open-task"] },
    secret: { id: "secret", hidden: true, threads: ["t-secret", "t-secret-task"] },
  };
  const groups: Record<string, { id: string; dm?: boolean; threads: string[] }> = {
    room: { id: "room", threads: ["t-room", "t-room-task"] },
    chatter: { id: "chatter", dm: true, threads: ["t-dm"] },
  };
  return {
    bot: (id) => bots[id] ?? null,
    botByThread: (threadId) => Object.values(bots).find((b) => b.threads.includes(threadId)) ?? null,
    group: (id) => groups[id],
    groupByThread: (threadId) => Object.values(groups).find((g) => g.threads.includes(threadId)),
  };
};

const visible = (subject: FrameSubject) => visibleToCompanion(world(), subject);

describe("requestSurface", () => {
  it("defaults to the narrow answer for a caller that announces nothing", () => {
    // The whole point of the inversion. A door added later is a new file
    // that will not know this one exists; forgetting a line there must cost
    // that door its live updates, not cost the user their transcripts.
    expect(requestSurface({})).toBe("remote");
    expect(requestSurface({}, new URLSearchParams())).toBe("remote");
    expect(requestSurface({ accept: "text/event-stream" }, new URLSearchParams("screens=off"))).toBe("remote");
  });

  it("lets the desktop opt out by header or by query", () => {
    // EventSource cannot set a request header, so the query form is the only
    // one the renderer's live stream can use; fetch callers use either.
    expect(requestSurface({ "x-murage-surface": DESKTOP_SURFACE })).toBe("desktop");
    expect(requestSurface({}, new URLSearchParams(`surface=${DESKTOP_SURFACE}`))).toBe("desktop");
    // near-misses are not the marker
    expect(requestSurface({ "x-murage-surface": "Desktop" })).toBe("remote");
    expect(requestSurface({}, new URLSearchParams("surface=1"))).toBe("remote");
  });

  // Node folds duplicate request headers into ONE comma-joined string, so two
  // `x-murage-companion: 1` headers arrive as `"1, 1"`. The check used to read
  // the value — `=== "1"` — which calls that "not a companion", falls through
  // to the desktop markers, and serves a request carrying `?surface=desktop`
  // as the local app. The marker is now read as presence, so no spelling of it
  // widens the answer.
  it("cannot be widened by sending the companion marker twice", () => {
    expect(
      requestSurface({ "x-murage-companion": "1, 1" }, new URLSearchParams(`surface=${DESKTOP_SURFACE}`)),
    ).toBe("remote");
    // the array shape some servers hand over, and the empty and odd values too
    expect(requestSurface({ "x-murage-companion": ["1", "1"] as unknown as string[] })).toBe("remote");
    expect(requestSurface({ "x-murage-companion": "" }, new URLSearchParams(`surface=${DESKTOP_SURFACE}`))).toBe("remote");
    expect(requestSurface({ "x-murage-companion": "yes" }, new URLSearchParams(`surface=${DESKTOP_SURFACE}`))).toBe("remote");
    // absent still means the desktop may announce itself
    expect(requestSurface({}, new URLSearchParams(`surface=${DESKTOP_SURFACE}`))).toBe("desktop");
  });

  it("keeps a companion scoped even when it forges the desktop marker", () => {
    // proxy.ts sets x-murage-companion into a fresh header object, so a
    // device cannot clear it — and because that check runs first, a device
    // cannot talk its way past it by appending ?surface=desktop either.
    expect(
      requestSurface({ "x-murage-companion": "1" }, new URLSearchParams(`surface=${DESKTOP_SURFACE}`)),
    ).toBe("remote");
    expect(requestSurface({ "x-murage-companion": "1", "x-murage-surface": DESKTOP_SURFACE })).toBe("remote");
  });

  it("reads a repeated header from its first value", () => {
    expect(requestSurface({ "x-murage-companion": ["1", "0"] })).toBe("remote");
    expect(requestSurface({ "x-murage-surface": [DESKTOP_SURFACE] })).toBe("desktop");
  });
});

describe("frameSubject", () => {
  it("resolves the conversation each thread-bearing kind names", () => {
    expect(frameSubject({ kind: "message", threadId: "t1" })).toEqual({ scope: "thread", threadId: "t1" });
    expect(frameSubject({ kind: "message.patch", threadId: "t1" })).toEqual({ scope: "thread", threadId: "t1" });
    expect(frameSubject({ kind: "thread", threadId: "t1" })).toEqual({ scope: "thread", threadId: "t1" });
    // streaming deltas carry the thread one level down, and they are the
    // assistant's text before it is ever persisted
    expect(frameSubject({ kind: "runtime", event: { threadId: "t1" } })).toEqual({ scope: "thread", threadId: "t1" });
    expect(frameSubject({ kind: "notify", notification: { threadId: "t1" } })).toEqual({
      scope: "thread",
      threadId: "t1",
    });
    expect(frameSubject({ kind: "bot", bot: { id: "b1" } })).toEqual({ scope: "bot", botId: "b1" });
    expect(frameSubject({ kind: "group", group: { id: "g1" } })).toEqual({ scope: "group", groupId: "g1" });
    expect(frameSubject({ kind: "screen", botId: "b1" })).toEqual({ scope: "bot", botId: "b1" });
  });

  it("treats a deletion as workspace-level", () => {
    // The record is already gone, so nothing can resolve it. A fail-closed
    // lookup would drop every one of these and leave a deleted bot in the
    // sidebar until the next full refresh; the frame carries an opaque id
    // and no content.
    expect(frameSubject({ kind: "bot.deleted", botId: "b1" })).toEqual({ scope: "workspace" });
    expect(frameSubject({ kind: "group.deleted", groupId: "g1" })).toEqual({ scope: "workspace" });
  });

  it("resolves an unfamiliar kind by convention rather than exempting it", () => {
    // A frame this module has not been taught must still be scoped if it
    // names a conversation, or the next feature leaks by omission.
    expect(frameSubject({ kind: "invented", threadId: "t1" })).toEqual({ scope: "thread", threadId: "t1" });
    expect(frameSubject({ kind: "invented", botId: "b1" })).toEqual({ scope: "bot", botId: "b1" });
    expect(frameSubject({ kind: "invented", groupId: "g1" })).toEqual({ scope: "group", groupId: "g1" });
    expect(frameSubject({ kind: "invented" })).toEqual({ scope: "workspace" });
  });

  it("falls back to workspace when the naming field is not a usable id", () => {
    expect(frameSubject({ kind: "message" })).toEqual({ scope: "workspace" });
    expect(frameSubject({ kind: "message", threadId: "" })).toEqual({ scope: "workspace" });
    expect(frameSubject({ kind: "message", threadId: 7 })).toEqual({ scope: "workspace" });
    expect(frameSubject({ kind: "bot", bot: null })).toEqual({ scope: "workspace" });
    expect(frameSubject({ kind: "runtime", event: [] })).toEqual({ scope: "workspace" });
  });
});

describe("every kind broadcast() emits is classified on purpose", () => {
  it("has an explicit frameSubject case for each one", () => {
    // The leak direction, made loud. The default branch looks for
    // threadId/botId/groupId at the TOP level, so a kind added later that
    // nests transcript content under some other key resolves to "workspace"
    // and is written to every open stream — silently, and correctly as far
    // as any type checker is concerned.
    //
    // Reading the call sites out of the source is deliberate: the point is
    // to fail when someone adds a kind and does not come here, which a test
    // that restates the list by hand cannot do.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const emitted = [...source.matchAll(/broadcast\(\{\s*kind:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(emitted.length, "no broadcast() call sites found — has the call shape changed?").toBeGreaterThan(5);

    const known = new Set<string>(KNOWN_FRAME_KINDS);
    const unclassified = [...new Set(emitted)].filter((kind) => !known.has(kind)).sort();
    expect(
      unclassified,
      `add these kinds to KNOWN_FRAME_KINDS and give each an explicit case in frameSubject(): ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("resolves every listed kind without falling through to the default branch", () => {
    // A kind on the list but not in the switch would pass the test above and
    // still be decided by convention.
    for (const kind of KNOWN_FRAME_KINDS) {
      // an id under a key the default branch does NOT read: if the switch
      // handles this kind it resolves, and if it does not it says workspace
      const subject = frameSubject({ kind, threadId: "t1", botId: "b1", groupId: "g1", bot: { id: "b1" }, group: { id: "g1" } });
      expect(subject, `frameSubject has no case for "${kind}"`).toBeTruthy();
    }
  });
});

describe("subjectResolves", () => {
  it("separates 'withheld on purpose' from 'nothing resolved this'", () => {
    // Both are invisible to a scoped client; only the second is a bug, and
    // it is the one that makes a phone miss the start of a new conversation.
    const store = world();
    expect(subjectResolves(store, { scope: "thread", threadId: "t-secret" })).toBe(true);
    expect(subjectResolves(store, { scope: "group", groupId: "chatter" })).toBe(true);
    expect(subjectResolves(store, { scope: "thread", threadId: "t-nowhere" })).toBe(false);
    expect(subjectResolves(store, { scope: "bot", botId: "gone" })).toBe(false);
    expect(subjectResolves(store, { scope: "group", groupId: "gone" })).toBe(false);
    expect(subjectResolves(store, { scope: "workspace" })).toBe(true);
  });
});

describe("visibleToCompanion", () => {
  it("passes the conversations the sidebar shows, task threads included", () => {
    expect(visible({ scope: "workspace" })).toBe(true);
    expect(visible({ scope: "thread", threadId: "t-open" })).toBe(true);
    expect(visible({ scope: "thread", threadId: "t-open-task" })).toBe(true);
    expect(visible({ scope: "thread", threadId: "t-room" })).toBe(true);
    expect(visible({ scope: "thread", threadId: "t-room-task" })).toBe(true);
    expect(visible({ scope: "bot", botId: "open" })).toBe(true);
    expect(visible({ scope: "group", groupId: "room" })).toBe(true);
  });

  it("drops a hidden bot, its task threads, and the bot⇄bot dm channels", () => {
    // The three things the firehose was handing out in real time.
    expect(visible({ scope: "thread", threadId: "t-secret" })).toBe(false);
    expect(visible({ scope: "thread", threadId: "t-secret-task" })).toBe(false);
    expect(visible({ scope: "bot", botId: "secret" })).toBe(false);
    expect(visible({ scope: "thread", threadId: "t-dm" })).toBe(false);
    expect(visible({ scope: "group", groupId: "chatter" })).toBe(false);
  });

  it("fails closed on a subject it cannot resolve", () => {
    // A thread belonging to no bot and no room is one this surface has no
    // route to open, so dropping its frames costs nothing — and it is the
    // safe direction for whatever is added next.
    expect(visible({ scope: "thread", threadId: "t-nowhere" })).toBe(false);
    expect(visible({ scope: "bot", botId: "gone" })).toBe(false);
    expect(visible({ scope: "group", groupId: "gone" })).toBe(false);
  });
});
