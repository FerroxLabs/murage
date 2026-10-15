import { describe, expect, it } from "vitest";

import { ThreadVersions } from "./thread-versions.ts";
import type { Message } from "./store.ts";

const m = (id: string) => ({ id, role: "bot", kind: "text", text: id, at: 1 }) as Message;
const add = (v: ThreadVersions, threadId: string, id: string) => v.note({ type: "message", threadId, message: m(id) });
const patch = (v: ThreadVersions, threadId: string, id: string) => v.note({ type: "message.patch", threadId, message: m(id) });

describe("ThreadVersions", () => {
  it("answers the ids written after a version, oldest first, each once", () => {
    const v = new ThreadVersions("run1");
    add(v, "t", "a");
    const held = v.token();
    add(v, "t", "b");
    patch(v, "t", "a");
    patch(v, "t", "b");
    add(v, "other", "x");
    expect(v.since("t", held, 100)).toEqual(["a", "b"]);
    expect(v.since("t", v.token(), 100)).toEqual([]);
  });

  it("answers nothing changed for a thread with no writes since the run began", () => {
    const v = new ThreadVersions("run1");
    const held = v.token();
    add(v, "other", "x");
    expect(v.since("quiet", held, 100)).toEqual([]);
  });

  it("cannot vouch across a branch move (an edit that forks, a rewind)", () => {
    const v = new ThreadVersions("run1");
    add(v, "t", "a");
    const held = v.token();
    v.note({ type: "thread", threadId: "t", activeLeafId: "a" });
    expect(v.since("t", held, 100)).toBeNull();
    // a version taken after the move is fine again
    const after = v.token();
    patch(v, "t", "a");
    expect(v.since("t", after, 100)).toEqual(["a"]);
  });

  it("cannot vouch for another server run, a malformed version, or one from the future", () => {
    const v = new ThreadVersions("run1");
    add(v, "t", "a");
    expect(v.since("t", "run0.0", 100)).toBeNull();
    expect(v.since("t", "garbage", 100)).toBeNull();
    expect(v.since("t", null, 100)).toBeNull();
    expect(v.since("t", "run1.99", 100)).toBeNull();
  });

  it("cannot vouch once older writes fell off the thread's log", () => {
    const v = new ThreadVersions("run1", 3);
    const held = v.token();
    for (const id of ["a", "b", "c", "d"]) add(v, "t", id);
    expect(v.since("t", held, 100)).toBeNull();
    const recent = v.token();
    add(v, "t", "e");
    expect(v.since("t", recent, 100)).toEqual(["e"]);
  });

  it("cannot vouch for a thread that was evicted from the log", () => {
    const v = new ThreadVersions("run1", 10, 2);
    const held = v.token();
    add(v, "t1", "a");
    add(v, "t2", "b");
    add(v, "t3", "c"); // t1 is evicted
    expect(v.since("t1", held, 100)).toBeNull();
    expect(v.since("t3", held, 100)).toEqual(["c"]); // its every write is still logged
    const later = v.token();
    expect(v.since("t1", later, 100)).toEqual([]);
  });

  it("sends the page instead when more changed than a page holds", () => {
    const v = new ThreadVersions("run1");
    const held = v.token();
    for (const id of ["a", "b", "c"]) add(v, "t", id);
    expect(v.since("t", held, 2)).toBeNull();
    expect(v.since("t", held, 3)).toEqual(["a", "b", "c"]);
  });

  it("forgets a deleted thread", () => {
    const v = new ThreadVersions("run1");
    add(v, "t", "a");
    const held = v.token();
    v.note({ type: "thread.deleted", threadId: "t" });
    expect(v.since("t", held, 100)).toBeNull();
  });
});
