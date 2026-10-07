import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { initialState, reducer, type Group, type Message } from "../state/store";
import { roomTranscript } from "./room-transcript";

const row = (id: string, parentId: string | null | undefined, extra: Partial<Message> = {}): Message =>
  ({ id, at: 1, role: "bot", kind: "text", text: id, ...(parentId === undefined ? {} : { parentId }), ...extra }) as Message;
const ids = (messages: readonly { id: string }[]) => messages.map((message) => message.id);

describe("roomTranscript", () => {
  it("returns the same array when every row follows its parent", () => {
    const messages = [row("a", null), row("b", "a"), row("c", "b")];
    expect(roomTranscript(messages)).toBe(messages);
  });

  it("puts text inserted before a tool row ahead of that row", () => {
    // arrival order: the row and its follow-up landed first, the text later
    const messages = [row("ask", null), row("tool", "lead"), row("after", "tool"), row("lead", "ask")];
    expect(ids(roomTranscript(messages))).toEqual(["ask", "lead", "tool", "after"]);
  });

  it("reads legacy rows without a parent as following the row before them", () => {
    const messages = [row("a", undefined), row("b", undefined), row("c", "b")];
    expect(roomTranscript(messages)).toBe(messages);
  });

  it("starts a page whose parent is not held at that page's own rows, hiding nothing", () => {
    const messages = [row("t", "lead"), row("after", "t"), row("lead", "older-not-loaded"), row("orphan", "elsewhere")];
    expect(ids(roomTranscript(messages))).toEqual(["lead", "t", "after", "orphan"]);
  });

  it("puts an inserted row first when a page boundary cut it off from the row it precedes", () => {
    // chain ask → L → T1 … T101; storage order [ask, T1 … T101, L]; newest page [T3 … T101, L]
    const tools = Array.from({ length: 99 }, (_, index) => row(`T${index + 3}`, `T${index + 2}`));
    const lead = row("L", "ask", { insertedBefore: "T1" });
    expect(ids(roomTranscript([...tools, lead]))).toEqual(["L", ...ids(tools)]);
    // the same text arriving live onto a client that holds only that page
    expect(ids(roomTranscript([...tools, row("L2", "ask", { insertedBefore: "T1" })]))[0]).toBe("L2");
    // two such rows keep their arrival order, ahead of the rest
    const second = row("M", "older", { insertedBefore: "T0" });
    expect(ids(roomTranscript([...tools, second, lead])).slice(0, 2)).toEqual(["M", "L"]);
    // already first: the same array
    const first = [lead, ...tools];
    expect(roomTranscript(first)).toBe(first);
  });

  it("still shows rows caught in a parent cycle", () => {
    const messages = [row("a", null), row("x", "y"), row("y", "x")];
    expect(ids(roomTranscript(messages)).sort()).toEqual(["a", "x", "y"]);
  });

  it("orders a 20k-row room in one linear pass", () => {
    const messages: Message[] = [row("m0", null)];
    for (let index = 1; index < 20_000; index++) messages.push(row(`m${index}`, `m${index - 1}`));
    messages.push(row("late", "m9999"));
    messages[10_000] = { ...messages[10_000]!, parentId: "late" };
    const started = performance.now();
    const ordered = roomTranscript(messages);
    expect(performance.now() - started).toBeLessThan(500);
    expect(ids(ordered.slice(9_999, 10_002))).toEqual(["m9999", "late", "m10000"]);
    expect(ordered).toHaveLength(20_001);
  });
});

describe("room transcript live order", () => {
  const room = (messages: Message[]): Group => ({
    id: "room",
    threadId: "room-thread",
    name: "Room",
    memberIds: ["bot"],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    messages,
  });

  it("shows hosted-tool text before its row once the insert and reparent frames land", () => {
    const ask = row("ask", null, { role: "user" });
    const tool = row("tool", "ask", { kind: "activity", tool: { name: "web_search" } } as Partial<Message>);
    const after = row("after", "tool");
    let state = { ...initialState, groups: [room([ask, tool, after])] };
    // Store.insertMessageBefore: the new message, then the moved row
    state = reducer(state, { type: "messageAdded", threadId: "room-thread", message: row("lead", "ask") });
    state = reducer(state, { type: "messagePatched", threadId: "room-thread", message: { ...tool, parentId: "lead" } });
    expect(ids(state.groups[0]!.messages)).toEqual(["ask", "tool", "after", "lead"]); // arrival order
    expect(ids(roomTranscript(state.groups[0]!.messages))).toEqual(["ask", "lead", "tool", "after"]);
  });

  it("GroupView windows and renders the projected order, not arrival order", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/GroupView.tsx", import.meta.url)), "utf8");
    const body = source.slice(source.indexOf("export function GroupView("));
    expect(body).toContain("const roomMessages = useMemo(() => roomTranscript(group.messages), [group.messages]);");
    expect(body.split("group.messages").length - 1).toBe(2); // only the memo reads arrival order
    expect(body).toContain("resolveTranscriptWindow(roomMessages,");
  });
});
