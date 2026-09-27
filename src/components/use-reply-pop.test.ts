// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows 0.1.60 FINAL 2, D1: in an Everyone responds room the first bot's
// answer stayed pinned in the live presence block, the second bot's row lost
// its Thinking label, and later rows landed above the stuck answer. The
// second bot's first row arrived inside the 520 ms pop window: the effect's
// cleanup cancelled the settle timer and the re-run returned early without
// retiring the pop, so it never settled until the room was left.
//
// A tiny hook runner stands in for React (no DOM in this suite). It keeps
// React's effect contract: an effect whose deps changed has its previous
// cleanup run before it runs again, and state set in an effect re-renders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

type Slot = { value: unknown; deps?: unknown[]; cleanup?: (() => void) | void; effect?: () => (() => void) | void };
const runner = {
  slots: [] as Slot[],
  cursor: 0,
  dirty: false,
  pending: [] as number[],
};

vi.mock("react", () => ({
  useRef<T>(initial: T) {
    const i = runner.cursor++;
    runner.slots[i] ??= { value: { current: initial } };
    return runner.slots[i].value as { current: T };
  },
  useState<T>(initial: T) {
    const i = runner.cursor++;
    runner.slots[i] ??= { value: initial };
    const set = (next: T) => {
      if (Object.is(runner.slots[i].value, next)) return;
      runner.slots[i].value = next;
      runner.dirty = true;
    };
    return [runner.slots[i].value as T, set];
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const i = runner.cursor++;
    const slot = (runner.slots[i] ??= { value: undefined });
    const changed = !slot.deps || deps.some((dep, k) => !Object.is(dep, slot.deps![k]));
    if (!changed) return;
    slot.deps = deps;
    slot.effect = effect;
    runner.pending.push(i);
  },
}));

const { useReplyPop } = await import("./use-reply-pop");

type Props = { resetKey: string; last: Message | undefined; waiting: boolean };
function mount(initial: Props) {
  runner.slots = [];
  let props = initial;
  let result: ReturnType<typeof useReplyPop> = null;
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      runner.cursor = 0;
      runner.dirty = false;
      runner.pending = [];
      result = useReplyPop(props.resetKey, props.last, props.waiting);
      const due = runner.pending;
      for (const i of due) runner.slots[i].cleanup?.();
      for (const i of due) runner.slots[i].cleanup = runner.slots[i].effect!();
      if (!runner.dirty) return;
    }
    throw new Error("render loop");
  };
  render();
  return {
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      render();
    },
    advance(ms: number) {
      vi.advanceTimersByTime(ms);
      if (runner.dirty) render();
    },
    get pop() {
      return result;
    },
  };
}

const user: Message = { id: "u1", role: "user", kind: "text", text: "Both of you: one sentence each.", at: 1 };
const waffleReply: Message = {
  id: "w1",
  role: "bot",
  kind: "text",
  text: "Lighthouses were painted with stripes as a daymark.",
  from: { botId: "waffle", name: "Waffle", color: "blue" },
  at: 2,
} as Message;
const emberStep: Message = {
  id: "e-step",
  role: "bot",
  kind: "activity",
  tool: { name: "web_search" },
  from: { botId: "ember", name: "Ember", color: "orange" },
  at: 3,
} as Message;
const emberReply: Message = {
  id: "e1",
  role: "bot",
  kind: "text",
  text: "Stripes served as a daymark.",
  from: { botId: "ember", name: "Ember", color: "orange" },
  at: 4,
} as Message;

describe("room reply pop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a lone reply pops, then settles into the transcript", () => {
    const room = mount({ resetKey: "room", last: user, waiting: true });
    room.update({ last: waffleReply, waiting: false });
    expect(room.pop?.id).toBe("w1");
    room.advance(600);
    expect(room.pop).toBeNull();
  });

  it("the next bot's first row inside the pop window retires the first bot's pop (D1)", () => {
    const room = mount({ resetKey: "room", last: user, waiting: true });
    // Waffle lands its answer; Ember is now the speaker and starts at once.
    room.update({ last: waffleReply, waiting: false });
    expect(room.pop?.id).toBe("w1");
    room.advance(100);
    room.update({ last: emberStep, waiting: true });
    // Waffle's answer must not stay held in the presence block (and out of the
    // transcript) while Ember works.
    expect(room.pop).toBeNull();
    room.advance(2_000);
    expect(room.pop).toBeNull();
    // Ember's own reply still gets its pop, and settles.
    room.update({ last: emberReply, waiting: false });
    expect(room.pop?.id).toBe("e1");
    room.advance(600);
    expect(room.pop).toBeNull();
  });

  it("a reply whose text is still updating inside the pop window does not stick", () => {
    const room = mount({ resetKey: "room", last: user, waiting: true });
    room.update({ last: waffleReply, waiting: false });
    room.advance(100);
    room.update({ last: { ...waffleReply, text: `${waffleReply.text} Saved as stripes.md.` } });
    room.advance(2_000);
    expect(room.pop).toBeNull();
  });
});
