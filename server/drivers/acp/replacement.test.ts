// ACP-EFFORT-1018 r9 4.4 (RP): the three-way prompt write and the one shared restoration operation.
import { beforeAll, expect, it } from "vitest";
type Mod = typeof import("./replacement.ts");
let mod: Mod;
beforeAll(async () => { mod = (await import("./replacement.ts").catch(() => undefined)) as Mod; });
const need = () => expect(mod, "acp/replacement.ts exists").toBeDefined();

const make = () => {
  need();
  const { Replacement } = mod;
  const calls: string[] = [];
  const replacement = new Replacement({
    restore: id => calls.push(`restore:${id}`), retire: id => calls.push(`retire:${id}`), publish: () => calls.push("publish"),
    notWritten: () => calls.push("notWritten"), record: () => {},
  });
  replacement.open("S", "R");
  return { replacement, calls };
};

it("K1-K3 classify the prompt write", () => {
  need();
  const { promptWriteResult } = mod;
  expect(promptWriteResult(null, true)).toBe("written");
  expect(promptWriteResult(undefined, true)).toBe("written");
  expect(promptWriteResult(new Error("closed"), false)).toBe("unwritten");
  expect(promptWriteResult(new Error("epipe"), true)).toBe("uncertain");
  expect(promptWriteResult(null, undefined)).toBe("uncertain");
  expect(promptWriteResult(null, false)).toBe("uncertain");
});

it("written publishes the replacement and retires the previous session", () => {
  const { replacement, calls } = make();
  expect(replacement.active).toBe(true);
  replacement.finish("written");
  expect(calls).toEqual(["publish", "retire:S"]);
  expect(replacement.active).toBe(false);
});

it("unwritten restores the previous cursor, retires the replacement and reports the dispatch unwritten", () => {
  const { replacement, calls } = make();
  replacement.finish("unwritten");
  expect(calls).toEqual(["restore:S", "retire:R", "notWritten"]);
});

it("uncertain and none restore without reporting unwritten (no retry of a line the engine may have read)", () => {
  for (const result of ["uncertain", "none"] as const) {
    const { replacement, calls } = make();
    replacement.finish(result);
    expect(calls).toEqual(["restore:S", "retire:R"]);
  }
});

it("the first finish wins; a later one is ignored", () => {
  const { replacement, calls } = make();
  replacement.finish("none");
  replacement.finish("written");
  expect(calls).toEqual(["restore:S", "retire:R"]);
});
