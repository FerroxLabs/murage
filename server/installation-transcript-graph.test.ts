import { expect, it } from "vitest";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
const create = () => new InstallationTranscriptGraph(code => { throw new Error(code); });
const message = (id: string, parentId?: string | null) => ({ id, at: 1, role: "user", kind: "text", ...(parentId !== undefined ? { parentId } : {}) });

it("validates a long legacy chain iteratively without recursion", () => {
  const graph = create();
  for (let i = 0; i < 40_000; i++) graph.add(message(`m${i}`));
  expect(() => graph.validate("m39999")).not.toThrow();
});
it("accepts real branch insertion with a later parent and explicit root", () => {
  const graph = create();
  graph.add(message("child", "parent")); graph.add(message("parent", null));
  expect(() => graph.validate("child")).not.toThrow();
});
it("rejects multi-node cycles and missing parent links", () => {
  const cycle = create(); cycle.add(message("a", "b")); cycle.add(message("b", "a"));
  expect(() => cycle.validate()).toThrow("CYCLIC_MESSAGE_BRANCH");
  const missing = create(); missing.add(message("a", "foreign-thread-message"));
  expect(() => missing.validate()).toThrow("INVALID_MESSAGE_PARENT");
});
it("rejects duplicate identities, invalid message values and absent active heads", () => {
  const graph = create(); graph.add(message("a"));
  expect(() => graph.add(message("a"))).toThrow("INVALID_RESTORE_MESSAGE");
  expect(() => graph.add({ ...message("b"), at: Infinity })).toThrow("INVALID_RESTORE_MESSAGE");
  expect(() => graph.validate("missing")).toThrow("INVALID_ACTIVE_BRANCH");
});
