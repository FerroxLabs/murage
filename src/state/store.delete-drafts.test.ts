// Linux re-test 3 (2026-09-27): after a conversation was deleted, its unsent
// composer draft was still in the renderer's localStorage. Deleting a
// conversation, a bot or a channel now removes its drafts at once. This
// drives the REAL wrapped dispatch out of StoreProvider (the harness from
// store.test.ts "answerCard routing") and reads localStorage straight after.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, initialState, useStore, type Action, type Group } from "./store";
import { draftBelongsTo, getDraft, setDraft } from "@/lib/drafts";

const DRAFTS = "murage-drafts";
const DRAFT_KEYS = ["murage-drafts", "murage-draft-attachments", "murage-draft-send-ids", "murage-draft-channel-modes", "murage-draft-failed-sends"];

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const ids = {
  deletedThread: "bot:ember:thread-gone",
  otherThread: "bot:ember:thread-kept",
  legacyBot: "bot:bramble",
  botThread: "bot:bramble:thread-b1",
  channelThread: "group:studio:thread-c1",
  channelTask: "group:studio:thread-c2",
  otherChannel: "group:other:thread-o1",
};

function seed(store: ReturnType<typeof storage>) {
  const all = Object.values(ids);
  const each = (value: (id: string) => unknown) => JSON.stringify(Object.fromEntries(all.map((id) => [id, value(id)])));
  store.setItem(DRAFTS, each((id) => `secret draft for ${id}`));
  store.setItem("murage-draft-attachments", each(() => [{ kind: "paste", id: "p", name: "note.txt", text: "attached secret" }]));
  store.setItem("murage-draft-send-ids", each((id) => `send-${id}`));
  store.setItem("murage-draft-channel-modes", each(() => "goal"));
  store.setItem("murage-draft-failed-sends", each((id) => [{ id: "f", sendId: "s", text: `failed ${id}`, requestText: "x", threadId: "t" }]));
}

function remaining(store: ReturnType<typeof storage>): Record<string, string[]> {
  return Object.fromEntries(DRAFT_KEYS.map((key) => [key, Object.keys(JSON.parse(store.getItem(key) ?? "{}"))]));
}

afterEach(() => { vi.unstubAllGlobals(); });

async function dispatchWith(action: Action, groups: Group[] = []) {
  const store = storage();
  seed(store);
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("fetch", (() => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch);
  initialState.groups.push(...groups);
  try {
    let dispatch: ((action: Action) => void) | null = null;
    const Probe = () => { dispatch = useStore().dispatch; return null; };
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
    dispatch!(action);
    // Read synchronously: the drafts are gone before the server answers.
    return { store, left: remaining(store) };
  } finally {
    initialState.groups.length = 0;
  }
}

const allKeysHold = (left: Record<string, string[]>, expected: string[]) => {
  for (const key of DRAFT_KEYS) expect(left[key].sort(), key).toEqual([...expected].sort());
};

describe("deleting removes drafts from browser storage at once", () => {
  it("a deleted conversation's draft, and only that one", async () => {
    const { store, left } = await dispatchWith({ type: "deleteTask", botId: "ember", threadId: "thread-gone" });
    allKeysHold(left, Object.values(ids).filter((id) => id !== ids.deletedThread));
    expect(store.getItem(DRAFTS)).not.toContain("secret draft for bot:ember:thread-gone");
    // A composer still mounted for a moment cannot write it back.
    setDraft(store, ids.deletedThread, "typed after delete");
    expect(getDraft(store, ids.deletedThread)).toBe("");
  });

  it("a deleted channel conversation", async () => {
    const { left } = await dispatchWith({ type: "deleteGroupTask", groupId: "studio", threadId: "thread-c2" });
    allKeysHold(left, Object.values(ids).filter((id) => id !== ids.channelTask));
  });

  it("a deleted bot: every conversation, and its older single draft", async () => {
    const { left } = await dispatchWith({ type: "deleteBot", botId: "bramble" });
    allKeysHold(left, Object.values(ids).filter((id) => id !== ids.legacyBot && id !== ids.botThread));
  });

  it("a deleted channel: every conversation in it", async () => {
    const group = { id: "studio", name: "studio", threadId: "thread-c1", memberIds: [], messages: [], tasks: [{ threadId: "thread-c2", title: "t", createdAt: 1 }] } as unknown as Group;
    const { left } = await dispatchWith({ type: "deleteGroup", groupId: "studio" }, [group]);
    allKeysHold(left, Object.values(ids).filter((id) => id !== ids.channelThread && id !== ids.channelTask));
  });
});

describe("draftBelongsTo", () => {
  it("never matches another bot, channel or conversation by prefix", () => {
    expect(draftBelongsTo("bot:ember2:t1", { botId: "ember" })).toBe(false);
    expect(draftBelongsTo("group:studio2:t1", { groupId: "studio" })).toBe(false);
    expect(draftBelongsTo("bot:ember:thread-10", { threadId: "thread-1" })).toBe(false);
    expect(draftBelongsTo("bot:thread-1", { threadId: "thread-1" })).toBe(false);
    expect(draftBelongsTo("group:studio:thread-1", { threadId: "thread-1" })).toBe(true);
  });
});
