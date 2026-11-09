import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("grouped route selects its ordered scope with linear work", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const expression = source.match(/searchChatThreads\(q, limit, (.*), groupedFrom \?\? undefined, gen, filters, rendered\)/)![1];
  const select = new Function("orderedScope", "scope", "threadId", `return (${expression})`);
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ threadId: `thread-${i}` }));
  let reads = 0;
  const scope = new Proxy(rows.map(row => row.threadId), { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  expect(select(rows, scope, undefined)).toEqual(rows);
  expect(reads).toBeLessThanOrEqual(rows.length * 2);
  expect(select(rows, ["thread-9999"], "thread-9999")).toEqual([rows[9999]]);
});
